// 文件系统支撑的「数据库」—— 供真并发测试用。
//
// 为什么不能用 JS 的 Map 来测并发：
//  Map 是进程内对象。把 N 个本应同时执行的请求放进一个进程（Promise.all），
//  它们仍然只在同一个事件循环里交替执行，而「先 SELECT 再 INSERT」这种错误
//  写法在这种交替里**也**可能恰好通过（两次 await 之间没有让出点时尤其明显）。
//  所以单进程串行/Promise.all 都不能证明 ON CONFLICT 的仲裁成立。
//
// 这里换成：独立进程（child_process）+ 由操作系统提供的原子原语
//  · INSERT ... ON CONFLICT DO NOTHING → 用 `open(path, 'wx')` 复刻。
//    O_EXCL 由内核保证「只有一个调用者能创建成功」，语义与唯一约束完全一致。
//  · UPDATE ... WHERE id=$1 AND status='x' → 用 O_EXCL 自旋锁 + 读改写复刻。
//    WHERE 条件在锁内判定，条件不满足返回 rowCount 0（与 pg 一致）。
//  · SELECT → 直接读 JSON 文件。
//
// 这不是「假装成数据库的 mock」：它把**并发仲裁**交给内核，因此当一个进程
// 拿到 RETURNING 时，其他进程拿到的一定是 rowCount=0。正因如此，这个测试
// 才能真的失败 —— 如果实现改成「先查再插」，就会有两个进程都拿到 RETURNING。

import { link, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'

/** 与 sql/002_seed_v1.sql 一致的最小字典（只用于分类名 join）。 */
const SUBJECTS = {
  math: { code: 'math', display_name: '数学', directory_name: '数学' },
  chinese: { code: 'chinese', display_name: '语文', directory_name: '语文' },
  english: { code: 'english', display_name: '英语', directory_name: '英语' },
}
const TERMS = {
  g1t1: { code: 'g1t1', display_name: '一年级上学期', directory_name: '一年级上' },
  g1t2: { code: 'g1t2', display_name: '一年级下学期', directory_name: '一年级下' },
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function lockTimeout(key) {
  const error = new Error(`等待行锁超时：${key}`)
  error.code = 'LOCK_TIMEOUT'
  return error
}

/**
 * 创建一个文件系统支撑的 pool。
 *
 * 目录结构：
 *   <dir>/rows/<sha256hex>.json   一行一个文件
 *   <dir>/locks/<key>.lock        自旋锁（O_EXCL 创建，用完删除）
 *
 * @param {{ dir: string, schema?: string }} options dir 必须是所有进程共享的绝对路径
 * @returns {object} 可直接传给 ImportService 的 pool
 */
export function createFileBackedPool({ dir, schema = 'app' }) {
  const rowsDir = path.join(dir, 'rows')
  const locksDir = path.join(dir, 'locks')
  const rowPath = (hex) => path.join(rowsDir, `${hex}.json`)
  const sha256Of = (buffer) => (Buffer.isBuffer(buffer) ? buffer.toString('hex') : null)

  /**
   * 抢一个命名锁并执行 fn。
   *
   * 自旋而不是阻塞：importOne 的临界区都是毫秒级，阻塞式等待会把「竞争」
   * 变成「排队」，那就不再是同一时刻的仲裁了。
   */
  async function withLock(key, fn) {
    const lockPath = path.join(locksDir, `${key}.lock`)
    const deadline = Date.now() + 20000
    let handle = null
    while (handle === null) {
      try {
        handle = await open(lockPath, 'wx')
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        if (Date.now() > deadline) throw lockTimeout(key)
        // 随机退避，避免所有进程同步重试形成「活锁」
        await sleep(2 + Math.floor(Math.random() * 8))
      }
    }
    try {
      return await fn()
    } finally {
      // 先关句柄再删文件：Windows/9p 上句柄未释放时 unlink 会失败
      await handle.close().catch(() => {})
      await unlink(lockPath).catch(() => {})
    }
  }

  /** 读一行；不存在返回 null。 */
  async function readRow(hex) {
    try {
      const raw = await readFile(rowPath(hex), 'utf8')
      const row = JSON.parse(raw)
      // pg 把 bytea 读成 Buffer；这里保持一致，让 presentCapture / measureIntact 走同一路径
      row.sha256Buffer = Buffer.from(row.sha256, 'hex')
      return row
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  /** 扫描所有行（行数很小，测试里只用于按 id 查找与列表）。 */
  async function listRows() {
    let names
    try {
      names = await readdir(rowsDir)
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const out = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const row = await readRow(name.slice(0, -'.json'.length))
      if (row !== null) out.push(row)
    }
    return out
  }

  /** captureSelect 的投影：分类名由 original_path 的前两段 join 出来。 */
  function project(row) {
    const [subjectDir, termDir] = String(row.original_path).split('/')
    const subject = Object.values(SUBJECTS).find((entry) => entry.directory_name === subjectDir)
    const term = Object.values(TERMS).find((entry) => entry.directory_name === termDir)
    return {
      id: row.id,
      sha256: row.sha256,
      original_path: row.original_path,
      original_filename: row.original_filename,
      media_type: row.media_type,
      byte_size: row.byte_size,
      width: row.width,
      height: row.height,
      status: row.status,
      page_id: row.page_id,
      last_error: row.last_error,
      created_at: row.created_at,
      subject_code: subject ? subject.code : null,
      subject_display_name: subject ? subject.display_name : null,
      term_code: term ? term.code : null,
      term_display_name: term ? term.display_name : null,
    }
  }

  /** INSERT ... ON CONFLICT (sha256) DO NOTHING RETURNING —— 内核保证原子性。 */
  async function insertRow(sql, params) {
    if (!/on conflict \(sha256\) do nothing/i.test(sql)) {
      throw new Error(`文件-backed 池：预留语句必须带 ON CONFLICT (sha256) DO NOTHING → ${sql.slice(0, 120)}`)
    }
    const digest = params[0]
    if (!Buffer.isBuffer(digest) || digest.length !== 32) {
      throw new Error('sha256 必须是 32 字节')
    }
    const hex = digest.toString('hex')
    // 随机 id：多个进程各自算出来的 id 不能撞（用 pid + 时间 + 随机）
    const id = `cap-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
    const row = {
      id,
      sha256: hex,
      original_path: params[1],
      original_filename: params[2],
      source_metadata_json: JSON.parse(String(params[3])),
      status: 'reserved',
      page_id: null,
      media_type: null,
      byte_size: null,
      width: null,
      height: null,
      last_error: null,
      created_at: new Date().toISOString(),
    }

    // 关键：先把**完整内容**写到唯一临时名，再用 link() 原子地「创建这个名字」。
    // 不用 open(target,'wx') 然后再写内容 —— 那样在「文件已创建、内容还没写完」
    // 的窗口里，另一个进程会读到空文件（JSON.parse 直接炸），测试会间歇性假失败。
    // link() 在目标已存在时返回 EEXIST，且内容已是完整的：这是
    // uq_captures_sha256 + ON CONFLICT DO NOTHING 最贴近的真实语义。
    const tempPath = path.join(rowsDir, `.tmp-${process.pid}-${Math.random().toString(16).slice(2, 10)}`)
    const handle = await open(tempPath, 'wx')
    try {
      await handle.writeFile(JSON.stringify(row), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }

    try {
      await link(tempPath, rowPath(hex))
    } catch (error) {
      if (error.code === 'EEXIST') return { rows: [], rowCount: 0, command: 'INSERT' }
      throw error
    } finally {
      await unlink(tempPath).catch(() => {})
    }

    return {
      rows: [{ id: row.id, status: row.status, original_path: row.original_path }],
      rowCount: 1,
      command: 'INSERT',
    }
  }

  /** UPDATE ... WHERE id=$1 AND status='x' —— 锁内判定条件，等价于 pg 的 rowCount 语义。 */
  async function updateRow(sql, params) {
    const whereIndex = sql.search(/\bwhere\b/i)
    if (whereIndex < 0) throw new Error(`拒绝没有 WHERE 的 UPDATE → ${sql.slice(0, 120)}`)
    const setPart = sql.slice(0, whereIndex)
    const wherePart = sql.slice(whereIndex)
    if (!/where id = \$1/i.test(wherePart)) {
      throw new Error(`UPDATE 只支持 where id = $1 → ${wherePart.slice(0, 120)}`)
    }
    const id = params[0]

    // 按 id 找到哈希，再用哈希作为锁键（id 是进程内唯一的，锁键必须跨进程稳定）
    const candidates = await listRows()
    const target = candidates.find((row) => row.id === id)
    if (target === undefined) return { rows: [], rowCount: 0, command: 'UPDATE' }
    const hex = target.sha256

    return await withLock(`row-${hex}`, async () => {
      const row = await readRow(hex)
      if (row === null) return { rows: [], rowCount: 0, command: 'UPDATE' }

      // WHERE status=… 是幂等保护。必须同时支持字面量与绑定参数两种写法：
      // recordFailure 用的是 `status = $3`（同状态才允许回写 last_error）。
      // 只处理字面量会让输家把 last_error 写到一条已经 registered 的记录上 ——
      // 真实数据库会因 WHERE 不匹配影响 0 行，测试池必须一模一样地拒绝。
      const literalStatus = /status = '([a-z]+)'/i.exec(wherePart)
      const boundStatus = /status = \$(\d+)/i.exec(wherePart)
      const requiredStatus =
        literalStatus !== null
          ? literalStatus[1]
          : boundStatus !== null
            ? params[Number(boundStatus[1]) - 1]
            : null
      if (requiredStatus !== null && row.status !== requiredStatus) {
        return { rows: [], rowCount: 0, command: 'UPDATE' }
      }

      const next = { ...row }
      if (/set status = 'copied'/i.test(setPart)) {
        next.status = 'copied'
        next.media_type = params[1]
        next.byte_size = params[2]
        next.width = params[3]
        next.height = params[4]
        next.last_error = null
      } else if (/set status = 'registered'/i.test(setPart)) {
        next.status = 'registered'
        // 与真实 SQL 一致：registered 这一步同时清 last_error，
        // 否则并发输家写的旧错误会永久留在一条已完成的记录上
        if (/last_error = null/i.test(setPart)) next.last_error = null
      } else if (/set last_error = \$2/i.test(setPart)) {
        next.last_error = params[1]
      } else {
        throw new Error(`不认识的 UPDATE → ${setPart.slice(0, 120)}`)
      }

      if (next.status !== row.status) {
        const allowed =
          (row.status === 'reserved' && (next.status === 'copied' || next.status === 'registered')) ||
          (row.status === 'copied' && next.status === 'registered')
        if (!allowed) {
          const error = new Error(`illegal capture status transition: ${row.status} -> ${next.status}`)
          error.code = 'P0001'
          throw error
        }
      }
      if (next.status === 'registered') {
        const complete =
          typeof next.media_type === 'string' &&
          /^image\//.test(next.media_type) &&
          Number(next.byte_size) > 0 &&
          Number(next.width) > 0 &&
          Number(next.height) > 0
        if (!complete) {
          const error = new Error('registered 必须带完整媒体信息')
          error.code = '23514'
          throw error
        }
      }

      delete next.sha256Buffer
      await withTempWrite(rowPath(hex), JSON.stringify(next))
      return { rows: [{ ...next }], rowCount: 1, command: 'UPDATE' }
    })
  }

  /** 原子写：先写临时名再 rename，避免另一个进程读到半截 JSON。 */
  async function withTempWrite(target, content) {
    const temp = `${target}.${process.pid}.${Math.random().toString(16).slice(2, 8)}.tmp`
    const handle = await open(temp, 'wx')
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    // rename 覆盖同名文件是原子的；读方要么看到旧内容要么看到新内容
    await rename(temp, target)
  }

  return {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim()

      if (/from app\.subjects/i.test(normalized)) {
        const row = SUBJECTS[params[0]]
        return row ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (/from app\.terms/i.test(normalized)) {
        const row = TERMS[params[0]]
        return row ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (/^insert into app\.captures/i.test(normalized)) {
        return insertRow(normalized, params)
      }
      if (/^select \* from app\.captures where sha256 = \$1/i.test(normalized)) {
        const row = await readRow(sha256Of(params[0]))
        if (row === null) return { rows: [], rowCount: 0 }
        const { sha256Buffer, ...rest } = row
        return { rows: [{ ...rest, sha256: sha256Buffer }], rowCount: 1 }
      }
      if (/split_part\(c\.original_path/i.test(normalized) && /where c\.id = \$1/i.test(normalized)) {
        const rows = await listRows()
        const row = rows.find((candidate) => candidate.id === params[0])
        return row ? { rows: [project(row)], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (/split_part\(c\.original_path/i.test(normalized) && /order by c\.created_at desc/i.test(normalized)) {
        const rows = await listRows()
        rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        const limit = Number(params[0])
        const limited = Number.isInteger(limit) && limit > 0 ? rows.slice(0, limit) : rows
        return { rows: limited.map(project), rowCount: limited.length }
      }
      if (/^update app\.captures/i.test(normalized)) {
        return updateRow(normalized, params)
      }

      throw new Error(`文件-backed 池：收到未预期的 SQL → ${normalized.slice(0, 160)}`)
    },
  }
}

/** 供父进程做最终核对的工具：直接读池目录，不经过任何业务代码。 */
export async function inspectPoolDir(dir) {
  const rowsDir = path.join(dir, 'rows')
  let names
  try {
    names = await readdir(rowsDir)
  } catch (error) {
    if (error.code === 'ENOENT') return { fileCount: 0, rows: [] }
    throw error
  }
  const rows = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    rows.push(JSON.parse(await readFile(path.join(rowsDir, name), 'utf8')))
  }
  return { fileCount: names.filter((name) => name.endsWith('.json')).length, rows }
}

/** 等待某个标记文件出现（真并发用的起跑线）。 */
export async function waitForBarrier(barrierPath, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await stat(barrierPath)
      return true
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await sleep(2)
  }
  return false
}
