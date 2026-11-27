// 第 2 轮修订的验证：全部走 mock pool / 临时目录，绝不连数据库、绝不写归档目录。
// 目的不是「再跑一遍 happy path」，而是给三条 review 意见各配一条可断言的失败用例。
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 用相对于本脚本的位置定位插件目录，避免把绝对路径写死进版本库
const PLUGIN = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../plugin/wrongbook')
const { ImportService, ImportError } = await import(`${PLUGIN}/import-service.js`)
const { ArchiveStore } = await import(`${PLUGIN}/archive-store.js`)

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ← ${detail}`}`)
}

/** 记录所有执行过的 SQL，用来证明「没有发生写操作」。 */
function makePool(handlers) {
  const log = []
  return {
    log,
    async query(sql, params) {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      log.push({ sql: normalized, params })
      for (const [pattern, fn] of handlers) {
        if (pattern.test(normalized)) return fn(params, normalized)
      }
      throw new Error(`未预期的 SQL：${normalized.slice(0, 80)}`)
    },
  }
}
// 预留 INSERT 带 ON CONFLICT DO NOTHING，冲突时不落任何字节，不算写操作；
// 真正的写是 UPDATE / DELETE / 无冲突保护的 INSERT。
const writes = (pool) =>
  pool.log.filter((e) => {
    if (/^delete/i.test(e.sql)) return true
    if (/^update/i.test(e.sql)) return true
    if (/^insert/i.test(e.sql)) return !/on conflict .*do nothing/i.test(e.sql)
    return false
  })

function service(pool, root) {
  return new ImportService({
    pool,
    schema: 'app',
    originalsRoot: root,
    uploadMaxBytes: 33554432,
    identifyTimeoutMs: 10000,
    log: { warn() {}, info() {} },
  })
}

/** 造一张真实可被 identify 读出的 PNG，返回 { buffer, digest, sha256hex } */
async function makePng(dir, name) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const target = path.join(dir, name)
  await run('convert', ['-size', '40x30', 'xc:white', target])
  const { readFile } = await import('node:fs/promises')
  const buffer = await readFile(target)
  return { buffer, digest: createHash('sha256').update(buffer).digest() }
}

const root = await mkdtemp(path.join(tmpdir(), 'wb-verify-'))
try {
  // ---------- 1. staging 写盘失败 → STAGING_WRITE_FAILED(500)，不是 UPLOAD_ABORTED ----------
  {
    const pool = makePool([
      [/from app\.subjects/, () => ({ rowCount: 1, rows: [{ code: 'math', directory_name: '数学' }] })],
      [/from app\.terms/, () => ({ rowCount: 1, rows: [{ code: 'g1t1', directory_name: '一年级上' }] })],
    ])
    const svc = service(pool, root)
    const original = ArchiveStore.prototype.openStaging
    ArchiveStore.prototype.openStaging = async function () {
      const staging = await original.call(this)
      staging.write = async () => {
        const error = new Error('ENOSPC: no space left on device, write /tmp/staging/x.upload')
        error.code = 'ENOSPC'
        throw error
      }
      return staging
    }
    let caught = null
    try {
      await svc.importOne({
        subjectCode: 'math', termCode: 'g1t1', filename: 'a.png',
        stream: Readable.from([Buffer.from('hello')]),
      })
    } catch (error) { caught = error } finally { ArchiveStore.prototype.openStaging = original }

    check('写盘 ENOSPC → STAGING_WRITE_FAILED', caught instanceof ImportError && caught.code === 'STAGING_WRITE_FAILED',
      `实际 ${caught?.name}:${caught?.code}`)
    check('STAGING_WRITE_FAILED 是 500 + retryable', caught?.status === 500 && caught?.retryable === true,
      `status=${caught?.status} retryable=${caught?.retryable}`)
    check('写盘失败不泄露 staging 绝对路径', !String(caught?.message).includes('/tmp/staging'),
      String(caught?.message))
    check('写盘失败时未执行任何写库语句', writes(pool).length === 0, JSON.stringify(writes(pool)))
  }

  // ---------- 2. sync/close 失败 → 同样归 STAGING_WRITE_FAILED ----------
  {
    const pool = makePool([
      [/from app\.subjects/, () => ({ rowCount: 1, rows: [{ code: 'math', directory_name: '数学' }] })],
      [/from app\.terms/, () => ({ rowCount: 1, rows: [{ code: 'g1t1', directory_name: '一年级上' }] })],
    ])
    const svc = service(pool, root)
    const original = ArchiveStore.prototype.openStaging
    ArchiveStore.prototype.openStaging = async function () {
      const staging = await original.call(this)
      staging.commit = async () => {
        const error = new Error('EIO: i/o error, fsync /tmp/staging/x.upload')
        error.code = 'EIO'
        throw error
      }
      return staging
    }
    let caught = null
    try {
      await svc.importOne({
        subjectCode: 'math', termCode: 'g1t1', filename: 'a.png',
        stream: Readable.from([Buffer.from('hello')]),
      })
    } catch (error) { caught = error } finally { ArchiveStore.prototype.openStaging = original }
    check('fsync EIO → STAGING_WRITE_FAILED', caught?.code === 'STAGING_WRITE_FAILED', `实际 ${caught?.code}`)
  }

  // ---------- 3. 读请求体失败仍是 UPLOAD_ABORTED（不能把两类混成一条）----------
  {
    const pool = makePool([
      [/from app\.subjects/, () => ({ rowCount: 1, rows: [{ code: 'math', directory_name: '数学' }] })],
      [/from app\.terms/, () => ({ rowCount: 1, rows: [{ code: 'g1t1', directory_name: '一年级上' }] })],
    ])
    const svc = service(pool, root)
    const broken = new Readable({
      read() {
        const error = new Error('aborted')
        error.code = 'ECONNRESET'
        this.destroy(error)
      },
    })
    let caught = null
    try {
      await svc.importOne({ subjectCode: 'math', termCode: 'g1t1', filename: 'a.png', stream: broken })
    } catch (error) { caught = error }
    check('客户端断连仍归 UPLOAD_ABORTED(400)', caught?.code === 'UPLOAD_ABORTED' && caught?.status === 400,
      `实际 ${caught?.code}/${caught?.status}`)
  }

  // ---------- 4. recordFailure：last_error 不得透传原始 message ----------
  {
    const pool = makePool([
      [/^UPDATE app\.captures/, (params) => ({ rowCount: 1, rows: [], params })],
    ])
    const svc = service(pool, root)
    const fsError = new Error("ENOENT: no such file or directory, open '/mnt/c/Users/Think/Pictures/错题本照片/数学/一年级上/secret.png'")
    fsError.code = 'ENOENT'
    await svc.recordFailure('00000000-0000-0000-0000-000000000001', 'reserved', fsError)
    const detail = pool.log[0]?.params?.[1] ?? ''
    check('recordFailure 不写入绝对路径', !detail.includes('/mnt/c/') && !detail.includes('secret.png'), detail)
    check('recordFailure 保留错误码供检索', detail.startsWith('ENOENT:'), detail)
    check('recordFailure 用固定文案替代原始消息', detail.includes('内部处理失败'), detail)

    // ImportError 的 message 本就是面向用户口径，应当原样保留
    pool.log.length = 0
    const svcError = new ImportError('IMAGE_PROBE_FAILED', '该文件不是单帧图片，无法作为错题原件', false, 422)
    await svc.recordFailure('00000000-0000-0000-0000-000000000002', 'reserved', svcError)
    const detail2 = pool.log[0]?.params?.[1] ?? ''
    check('recordFailure 保留 ImportError 的用户文案',
      detail2 === 'IMAGE_PROBE_FAILED: 该文件不是单帧图片，无法作为错题原件', detail2)
  }

  // ---------- 5. registered + 文件缺失 → 409，且绝不当作 duplicate ----------
  {
    const png = await makePng(root, 'src.png')
    const missingRel = '数学/一年级上/ghost.png'
    const pool = makePool([
      [/from app\.subjects/, () => ({ rowCount: 1, rows: [{ code: 'math', directory_name: '数学' }] })],
      [/from app\.terms/, () => ({ rowCount: 1, rows: [{ code: 'g1t1', directory_name: '一年级上' }] })],
      [/^INSERT INTO app\.captures/, () => ({ rowCount: 0, rows: [] })], // 冲突：已有同哈希行
      [/^select \* from app\.captures where sha256/, () => ({
        rowCount: 1,
        rows: [{ id: 'id-1', status: 'registered', original_path: missingRel, sha256: png.digest }],
      })],
    ])
    const svc = service(pool, root)
    let caught = null
    try {
      await svc.importOne({
        subjectCode: 'math', termCode: 'g1t1', filename: 'a.png', stream: Readable.from([png.buffer]),
      })
    } catch (error) { caught = error }
    check('registered 但文件缺失 → CAPTURE_RECOVERY_REQUIRED(409)',
      caught?.code === 'CAPTURE_RECOVERY_REQUIRED' && caught?.status === 409, `实际 ${caught?.code}/${caught?.status}`)
    check('registered 但文件缺失时不返回 duplicate', caught !== null, '未抛错，等于谎报成功')
    check('该分支未执行任何写库语句', writes(pool).length === 0, JSON.stringify(writes(pool)))
    check('错误文案不含绝对路径', !String(caught?.message).includes('/mnt/'), String(caught?.message))
  }

  // ---------- 6. registered + 文件完好 → 仍然 duplicate ----------
  {
    const png = await makePng(root, 'src2.png')
    const rel = '数学/一年级上/real.png'
    const abs = path.join(root, rel)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, png.buffer)
    const pool = makePool([
      [/from app\.subjects/, () => ({ rowCount: 1, rows: [{ code: 'math', directory_name: '数学' }] })],
      [/from app\.terms/, () => ({ rowCount: 1, rows: [{ code: 'g1t1', directory_name: '一年级上' }] })],
      [/^INSERT INTO app\.captures/, () => ({ rowCount: 0, rows: [] })],
      [/^select \* from app\.captures where sha256/, () => ({
        rowCount: 1,
        rows: [{ id: 'id-2', status: 'registered', original_path: rel, sha256: png.digest }],
      })],
      [/^select c\.id,/, (params) => ({
        rowCount: 1,
        rows: [{
          id: 'id-2', sha256: png.digest.toString('hex'), original_path: rel, original_filename: 'a.png',
          media_type: 'image/png', byte_size: png.buffer.length, width: 40, height: 30,
          status: 'registered', page_id: null, last_error: null, created_at: new Date(),
          subject_code: 'math', subject_display_name: '数学', term_code: 'g1t1', term_display_name: '一年级上学期',
        }],
      })],
    ])
    const svc = service(pool, root)
    const result = await svc.importOne({
      subjectCode: 'math', termCode: 'g1t1', filename: 'a.png', stream: Readable.from([png.buffer]),
    })
    check('registered 且文件完好 → 仍是 duplicate', result.outcome === 'duplicate', result.outcome)
    check('duplicate 不执行写库语句', writes(pool).length === 0, JSON.stringify(writes(pool)))
  }

  // ---------- 7. registered + 文件被换成不同内容 → 同样 409，不只比大小 ----------
  {
    const png = await makePng(root, 'src3.png')
    const rel = '数学/一年级上/swapped.png'
    const abs = path.join(root, rel)
    await mkdir(path.dirname(abs), { recursive: true })
    // 同名但内容不同：长度一致也可能，所以只断言「内容不一致就不许 duplicate」
    await writeFile(abs, Buffer.concat([png.buffer.subarray(0, png.buffer.length - 1), Buffer.from([0x00])]))
    const pool = makePool([
      [/from app\.subjects/, () => ({ rowCount: 1, rows: [{ code: 'math', directory_name: '数学' }] })],
      [/from app\.terms/, () => ({ rowCount: 1, rows: [{ code: 'g1t1', directory_name: '一年级上' }] })],
      [/^INSERT INTO app\.captures/, () => ({ rowCount: 0, rows: [] })],
      [/^select \* from app\.captures where sha256/, () => ({
        rowCount: 1,
        rows: [{ id: 'id-3', status: 'registered', original_path: rel, sha256: png.digest }],
      })],
    ])
    const svc = service(pool, root)
    let caught = null
    try {
      await svc.importOne({
        subjectCode: 'math', termCode: 'g1t1', filename: 'a.png', stream: Readable.from([png.buffer]),
      })
    } catch (error) { caught = error }
    check('registered 但内容被替换 → CAPTURE_RECOVERY_REQUIRED', caught?.code === 'CAPTURE_RECOVERY_REQUIRED',
      `实际 ${caught?.code ?? '未抛错'}`)
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
