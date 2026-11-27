// 严格 mock 数据库 —— 供批量 / 并发 / 恢复三个新测试共用。
//
// 设计原则与 verify_e2e_mock.mjs 一致（那边是内联版，不动它）：
//  1. mock 必须复刻真实数据库里**对实现行为有约束**的部分，而不是配合实现：
//       · uq_captures_sha256 → 同哈希让 ON CONFLICT 影响 0 行
//       · chk_captures_relative_path / chk_captures_original_filename
//       · 状态机 reserved→copied→registered，禁止回退
//       · chk_captures_registered_complete
//       · WHERE status=… 幂等保护 → 条件不匹配返回 rowCount 0
//  2. 未预期的 SQL 一律抛错，不静默返回空 rows（否则实现改 SQL 后会静默走错分支）。
//  3. 可以按需注入故障（faults），用来构造「复制成功但数据库未提交」这类中断现场。
//
// 为什么单独成模块：这三个测试都需要同一份约束语义。三份拷贝一旦漂移，
// 「测试通过」就只证明三份 mock 各自与自己的断言一致。

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 插件目录：所有测试都以相对本文件的位置定位，绝不写死绝对路径。 */
export const PLUGIN = path.resolve(HERE, '../../plugin/wrongbook')

// 相对路径规则只有一份真源：直接用归档存储层的实现，不在测试里再抄一遍。
// 抄一份的后果是两边规则漂移 —— 那时「mock 放行」而「真实数据库拒绝」，
// 测试反而给出虚假信心。
import { isSafeRelativePath } from '../../plugin/wrongbook/archive-store.js'
export { isSafeRelativePath }

// 与 sql/002_seed_v1.sql 保持一致（directory_name 与 display_name 显式不同，
// 这样才能验证「分类名来自路径 join」而不是从显示名反推）
export const SUBJECTS = {
  math: { id: 's-math', code: 'math', display_name: '数学', directory_name: '数学' },
  chinese: { id: 's-chinese', code: 'chinese', display_name: '语文', directory_name: '语文' },
  english: { id: 's-english', code: 'english', display_name: '英语', directory_name: '英语' },
  other: { id: 's-other', code: 'other', display_name: '其他', directory_name: '其他' },
  unclassified: { id: 's-unclassified', code: 'unclassified', display_name: '未分类', directory_name: '未分类' },
}
export const TERMS = {
  g1t1: { id: 't-g1t1', code: 'g1t1', display_name: '一年级上学期', directory_name: '一年级上' },
  g1t2: { id: 't-g1t2', code: 'g1t2', display_name: '一年级下学期', directory_name: '一年级下' },
  unclassified: { id: 't-unclassified', code: 'unclassified', display_name: '未分类', directory_name: '未分类' },
}
const SUBJECT_BY_DIR = new Map(Object.values(SUBJECTS).map((row) => [row.directory_name, row]))
const TERM_BY_DIR = new Map(Object.values(TERMS).map((row) => [row.directory_name, row]))

/** 故意写坏的相对路径必须被拒：规则真源在 archive-store.js（见文件头 re-export 说明）。 */

export const sha256hex = (buffer) => createHash('sha256').update(buffer).digest('hex')
export const toHex = (buffer) => (Buffer.isBuffer(buffer) ? buffer.toString('hex') : String(buffer))

/** 造一个带 pg 风格 code 的错误。 */
export function pgError(code, constraint, message = 'mock 数据库拒绝该语句') {
  const error = new Error(message)
  error.code = code
  if (constraint !== undefined) error.constraint = constraint
  return error
}

/** 列出归档根下所有文件（不含 staging 目录）。 */
export function listArchiveFiles(root) {
  const found = []
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.wrongbook-tmp') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else found.push(path.relative(root, full))
    }
  }
  walk(root)
  return found.sort()
}

/**
 * 造几张真实可被 identify 读出的 PNG（全部写在临时目录内，不写版本库）。
 *
 * @param {string} dir 临时目录
 * @param {{width: number, height: number, color?: string}[]} specs 每张的规格
 * @returns {{buffer: Buffer, sha256: string}[]} 字节与摘要
 */
export function makePngs(dir, specs) {
  return specs.map((spec, index) => {
    const target = path.join(dir, `fixture-${index}-${spec.width}x${spec.height}.png`)
    execFileSync('convert', [
      '-size', `${spec.width}x${spec.height}`, `xc:${spec.color ?? 'white'}`, target,
    ], { stdio: 'pipe' })
    const buffer = readFileSync(target)
    return { buffer, sha256: sha256hex(buffer), name: path.basename(target), path: target }
  })
}

/**
 * 创建严格 mock。
 *
 * @param {{seed?: object[], faults?: object}} [options]
 * @returns {object} 可直接当 pool 用的对象
 */
export function createStrictMock({ seed = [], faults = {} } = {}) {
  const rows = new Map() // sha256hex -> row
  const log = []
  /** 供测试断言的内部计数：INSERT 尝试次数 / 拿到 RETURNING 的次数。 */
  const stats = { insertAttempts: 0, insertWins: 0 }
  let nextId = 1

  for (const entry of seed) {
    const key = toHex(entry.sha256)
    rows.set(key, {
      id: `cap-${nextId++}`,
      page_id: null,
      status: 'reserved',
      media_type: null,
      byte_size: null,
      width: null,
      height: null,
      last_error: null,
      created_at: new Date(),
      source_metadata_json: {},
      ...entry,
      sha256hex: key,
    })
  }

  /** captureSelect 的投影：分类名由 original_path 前两段 join 出来（左连接语义）。 */
  function project(row) {
    const [subjectDir, termDir] = String(row.original_path).split('/')
    const subject = SUBJECT_BY_DIR.get(subjectDir)
    const term = TERM_BY_DIR.get(termDir)
    return {
      id: row.id,
      sha256: row.sha256hex,
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

  function insertRow(sql, params) {
    // 唯一并发仲裁点上必须带 ON CONFLICT：没有它就不是原子预留（DESIGN §10.2）。
    // 「先 SELECT 再 INSERT」在这个 mock 下会立刻炸，这正是并发测试要证明的事。
    if (!/on conflict \(sha256\) do nothing/i.test(sql)) {
      throw new Error(`mock：预留语句必须带 ON CONFLICT (sha256) DO NOTHING → ${sql.slice(0, 120)}`)
    }
    stats.insertAttempts += 1

    const digest = params[0]
    if (!Buffer.isBuffer(digest) || digest.length !== 32) {
      throw pgError('23514', 'chk_captures_sha256_length', 'sha256 必须是 32 字节')
    }
    const key = digest.toString('hex')
    const relativePath = params[1]
    const filename = params[2]
    const rawMetadata = params[3]

    if (!isSafeRelativePath(relativePath)) {
      throw pgError('23514', 'chk_captures_relative_path', `original_path 不安全：${relativePath}`)
    }
    if (
      typeof filename !== 'string' ||
      filename === '' ||
      filename !== filename.trim() ||
      /[/\\]/.test(filename) ||
      filename === '.' ||
      filename === '..'
    ) {
      throw pgError('23514', 'chk_captures_original_filename', `original_filename 不合法：${filename}`)
    }
    let metadata
    try {
      metadata = JSON.parse(String(rawMetadata))
    } catch {
      throw pgError('23514', 'chk_captures_source_metadata_object', 'source_metadata_json 不是合法 JSON')
    }
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw pgError('23514', 'chk_captures_source_metadata_object', 'source_metadata_json 必须是对象')
    }

    // 已存在同哈希 → ON CONFLICT DO NOTHING 的真实效果：影响 0 行、不落字节
    if (rows.has(key)) return { rows: [], rowCount: 0, command: 'INSERT' }
    for (const existing of rows.values()) {
      if (existing.original_path === relativePath) {
        throw pgError('23505', 'uq_captures_original_path', `original_path 已被占用：${relativePath}`)
      }
    }

    const row = {
      id: `cap-${nextId++}`,
      page_id: null,
      status: 'reserved',
      media_type: null,
      byte_size: null,
      width: null,
      height: null,
      last_error: null,
      created_at: new Date(),
      source_metadata_json: metadata,
      sha256hex: key,
      sha256: digest,
      original_path: relativePath,
      original_filename: filename,
    }
    rows.set(key, row)
    stats.insertWins += 1
    return {
      rows: [{ id: row.id, status: row.status, original_path: row.original_path }],
      rowCount: 1,
      command: 'INSERT',
    }
  }

  function updateRow(sql, params) {
    const whereIndex = sql.search(/\bwhere\b/i)
    if (whereIndex < 0) throw new Error(`mock：拒绝没有 WHERE 的 UPDATE → ${sql.slice(0, 120)}`)
    const setPart = sql.slice(0, whereIndex)
    const wherePart = sql.slice(whereIndex)

    if (!/where id = \$1/i.test(wherePart)) {
      throw new Error(`mock：UPDATE 只支持 where id = $1 → ${wherePart.slice(0, 120)}`)
    }

    const row = [...rows.values()].find((candidate) => candidate.id === params[0])
    if (row === undefined) return { rows: [], rowCount: 0, command: 'UPDATE' }

    // WHERE status=… 是幂等保护：条件不匹配时真实数据库影响 0 行。
    // 实现一旦漏掉这个条件，这里就会「意外成功」。
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
      // 故障注入：模拟「归档文件已经 publish，但 markCopied 这次调用没成功」
      if (faults.failMarkCopied === true) {
        throw pgError('57P01', undefined, 'terminating connection due to administrator command')
      }
      next.status = 'copied'
      next.media_type = params[1]
      next.byte_size = params[2]
      next.width = params[3]
      next.height = params[4]
      next.last_error = null
    } else if (/set status = 'registered'/i.test(setPart)) {
      next.status = 'registered'
      // 真实 SQL 里 registered 这一步同时清 last_error（见 import-service.js 的
      // markRegistered 注释）。mock 必须照做，否则「并发输家留下脏 last_error」
      // 这个真实缺陷在测试里永远看不见。
      if (/last_error = null/i.test(setPart)) next.last_error = null
    } else if (/set last_error = \$2/i.test(setPart)) {
      next.last_error = params[1]
    } else {
      throw new Error(`mock：不认识的 UPDATE → ${setPart.slice(0, 120)}`)
    }

    if (next.status !== row.status) {
      const allowed =
        (row.status === 'reserved' && (next.status === 'copied' || next.status === 'registered')) ||
        (row.status === 'copied' && next.status === 'registered')
      if (!allowed) {
        throw pgError('P0001', 'trig_captures_status_transition', `illegal capture status transition: ${row.status} -> ${next.status}`)
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
        throw pgError('23514', 'chk_captures_registered_complete', 'registered 必须带完整媒体信息')
      }
    }

    Object.assign(row, next)
    return { rows: [{ ...row }], rowCount: 1, command: 'UPDATE' }
  }

  return {
    rows,
    log,
    stats,
    /** 运行期切换故障（同一 mock 先失败再恢复，用来验证中断恢复）。 */
    faults,
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      log.push({ sql: normalized, params })

      if (/from app\.subjects/i.test(normalized) && /where code = \$1/i.test(normalized)) {
        const row = SUBJECTS[params[0]]
        return row ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (/from app\.terms/i.test(normalized) && /where code = \$1/i.test(normalized)) {
        const row = TERMS[params[0]]
        return row ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (/^insert into app\.captures/i.test(normalized)) {
        return insertRow(normalized, params)
      }
      if (/^select \* from app\.captures where sha256 = \$1/i.test(normalized)) {
        const row = rows.get(toHex(params[0]))
        return row ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (/split_part\(c\.original_path/i.test(normalized) && /where c\.id = \$1/i.test(normalized)) {
        const row = [...rows.values()].find((candidate) => candidate.id === params[0])
        return row ? { rows: [project(row)], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (/split_part\(c\.original_path/i.test(normalized) && /order by c\.created_at desc/i.test(normalized)) {
        const limit = Number(params[0])
        const sorted = [...rows.values()].sort((a, b) => b.created_at - a.created_at)
        const limited = Number.isInteger(limit) && limit > 0 ? sorted.slice(0, limit) : sorted
        return { rows: limited.map(project), rowCount: limited.length }
      }
      if (/^update app\.captures/i.test(normalized)) {
        return updateRow(normalized, params)
      }

      throw new Error(`mock：收到未预期的 SQL → ${normalized.slice(0, 160)}`)
    },
  }
}

/** 极简断言出口，三个测试脚本共用同一套输出格式。 */
export function createReporter() {
  const results = []
  function check(name, ok, detail = '') {
    results.push({ name, ok, detail })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ← ${detail}`}`)
  }
  function finish() {
    const failed = results.filter((entry) => !entry.ok)
    console.log(`\n${results.length - failed.length}/${results.length} 通过`)
    return failed.length === 0
  }
  return { check, finish, results }
}

/** 临时目录工厂：调用方必须在 finally 里清理。 */
export function makeTempDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix))
}
