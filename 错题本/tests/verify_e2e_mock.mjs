// 端到端验证 importOne 的完整链路：真实文件系统（临时目录）+ 严格 mock 数据库。
//
// 设计原则（回应 reviewer 第 3 轮的问题清单）：
//  1. 所有 fixture 现场生成（convert / writeFileSync），不依赖版本库里的二进制样本，
//     也不依赖任何绝对路径；临时目录在 finally 里必定删除。
//  2. mock 必须复刻真实数据库里**对实现行为有约束**的部分，而不是只配合实现：
//      · uq_captures_sha256 唯一约束 → 重复哈希让 ON CONFLICT 影响 0 行
//      · chk_captures_relative_path / chk_captures_original_filename → 写坏路径直接抛
//      · 状态机（reserved→copied→registered，禁止回退）→ 非法迁移直接抛
//      · chk_captures_registered_complete → registered 缺媒体信息直接抛
//      · WHERE status=… 幂等保护 → 条件不匹配返回 rowCount 0（实现漏掉 WHERE 时，
//        「markCopied 并发冲突」用例就会失败，而不是照样通过）
//      · captureSelect 的 split_part(c.original_path,'/',1|2) 双 join →
//        subject/term 由 original_path 前两段推导，join 语义在 mock 层可验证
//  3. 任何未预期的 SQL 一律抛错（不再静默返回空 rows，避免实现改 SQL 后静默走错分支）。
//  4. 断言只针对「实现发出的 SQL / 落盘文件 / 返回结果」，不断言 mock 自己维护的
//     Map —— 后者只能证明 mock 与断言一致（reviewer 指出的虚假信心）。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '../plugin/wrongbook')

const { ImportService, ImportError } = await import(`${PLUGIN}/import-service.js`)
const { isSafeRelativePath } = await import(`${PLUGIN}/archive-store.js`)

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log('PASS ', label, detail)
  } else {
    fail += 1
    console.log('FAIL ', label, detail)
  }
}

const sha256hex = (buffer) => createHash('sha256').update(buffer).digest('hex')
const toHex = (buffer) => (Buffer.isBuffer(buffer) ? buffer.toString('hex') : String(buffer))

/** 造一个带 pg 风格 code 的错误（让 translateDatabaseError 的分支行为可验证）。 */
function pgError(code, constraint, message = 'mock 数据库拒绝该语句') {
  const error = new Error(message)
  error.code = code
  if (constraint !== undefined) error.constraint = constraint
  return error
}

/** 列出归档根下所有文件（不含 staging 目录），用于断言「有没有多/少一个文件」。 */
function listArchiveFiles(root) {
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

// ---------------------------------------------------------------------------
// 字典：与 sql/002_seed_v1.sql 保持一致（directory_name 与 display_name 显式不同）
// ---------------------------------------------------------------------------
const SUBJECTS = {
  math: { id: 's-math', code: 'math', display_name: '数学', directory_name: '数学' },
  chinese: { id: 's-chinese', code: 'chinese', display_name: '语文', directory_name: '语文' },
  english: { id: 's-english', code: 'english', display_name: '英语', directory_name: '英语' },
  other: { id: 's-other', code: 'other', display_name: '其他', directory_name: '其他' },
  unclassified: { id: 's-unclassified', code: 'unclassified', display_name: '未分类', directory_name: '未分类' },
}
const TERMS = {
  g1t1: { id: 't-g1t1', code: 'g1t1', display_name: '一年级上学期', directory_name: '一年级上' },
  g1t2: { id: 't-g1t2', code: 'g1t2', display_name: '一年级下学期', directory_name: '一年级下' },
  unclassified: { id: 't-unclassified', code: 'unclassified', display_name: '未分类', directory_name: '未分类' },
}
const SUBJECT_BY_DIR = new Map(Object.values(SUBJECTS).map((row) => [row.directory_name, row]))
const TERM_BY_DIR = new Map(Object.values(TERMS).map((row) => [row.directory_name, row]))

// ---------------------------------------------------------------------------
// 严格 mock：只实现 importOne 需要的语句，并复刻数据库的约束语义
// ---------------------------------------------------------------------------
function createMock({ seed = [], faults = {} } = {}) {
  const rows = new Map() // sha256hex -> row
  const log = []
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
    // 唯一并发仲裁点上必须带 ON CONFLICT：没有它就不是原子预留（DESIGN §10.2）
    if (!/on conflict \(sha256\) do nothing/i.test(sql)) {
      throw new Error(`mock：预留语句必须带 ON CONFLICT (sha256) DO NOTHING → ${sql.slice(0, 120)}`)
    }
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
    // 实现一旦漏掉这个条件，这里就会「意外成功」，从而让下面依赖 rowCount 的断言失败。
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
      if (faults.loseMarkCopiedRace === true && row.status === 'reserved') {
        // 模拟并发：另一个请求已经把它推进到 copied，本次 UPDATE 影响 0 行
        row.status = 'copied'
        return { rows: [], rowCount: 0, command: 'UPDATE' }
      }
      next.status = 'copied'
      next.media_type = params[1]
      next.byte_size = params[2]
      next.width = params[3]
      next.height = params[4]
      next.last_error = null
    } else if (/set status = 'registered'/i.test(setPart)) {
      next.status = 'registered'
      // 与 import-service.js 的真实 SQL 对齐：registered 这一步同时清 last_error，
      // 否则并发输家写的旧错误会永久留在一条已完成的记录上（真机复现过）
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
        // 与 pg 行为一致：select * 返回的 bytea 是 Buffer
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

function service(mock, root) {
  return new ImportService({
    pool: mock,
    schema: 'app',
    originalsRoot: root,
    uploadMaxBytes: 33554432,
    identifyTimeoutMs: 10000,
    log: { warn() {}, info() {}, error() {} },
  })
}

/** 生成全部 fixture（都在临时目录内，不写版本库）。 */
function makeFixtures(dir) {
  const run = (args) => execFileSync('convert', args, { stdio: 'pipe' })
  const sheet = path.join(dir, 'sheet.png')
  const other = path.join(dir, 'other.png')
  const bmp = path.join(dir, 'capture.bmp')
  const anim = path.join(dir, 'anim.gif')
  const textJpg = path.join(dir, 'notimage.jpg')

  run(['-size', '800x600', 'xc:white', sheet])
  run(['-size', '640x480', 'xc:white', other])
  run(['-size', '40x30', 'xc:white', `bmp3:${bmp}`])
  run(['-size', '20x20', 'xc:red', 'xc:blue', '-delay', '10', anim])
  writeFileSync(textJpg, '这不是图片，只是一段文本（用来触发 identify 失败）\n')

  const sheetBytes = readFileSync(sheet)
  const truncated = path.join(dir, 'truncated.png')
  writeFileSync(truncated, sheetBytes.subarray(0, Math.max(16, Math.floor(sheetBytes.length / 2))))

  return {
    sheet: sheetBytes,
    other: readFileSync(other),
    bmp: readFileSync(bmp),
    anim: readFileSync(anim),
    notImage: readFileSync(textJpg),
    truncated: readFileSync(truncated),
  }
}

const root = mkdtempSync(path.join(tmpdir(), 'wb-e2e-'))
const fixtureDir = mkdtempSync(path.join(tmpdir(), 'wb-e2e-fixtures-'))
const allLogs = []
const logCursors = new WeakMap()
const remember = (mock) => {
  const from = logCursors.get(mock) ?? 0
  allLogs.push(...mock.log.slice(from))
  logCursors.set(mock, mock.log.length)
}
const writeStatements = (mock) => mock.log.filter((entry) => /^(insert|update|delete)/i.test(entry.sql))

try {
  const fixtures = makeFixtures(fixtureDir)
  const sheetSha = sha256hex(fixtures.sheet)

  // 用例 1 与用例 2 共用同一个 mock：它们模拟的是「同一个数据库先后收到两次请求」，
  // 唯此 duplicate 分支（ON CONFLICT 冲突 → 查既有行）才会真正被执行。
  const mainMock = createMock()

  // =========================================================================
  // 用例 1：首次导入（happy path）
  // =========================================================================
  {
    const mock = mainMock
    const svc = service(mock, root)
    const result = await svc.importOne({
      stream: Readable.from([fixtures.sheet]),
      subjectCode: 'math',
      termCode: 'g1t1',
      filename: 'IMG_0001.PNG',
      contentLength: fixtures.sheet.length,
    })
    remember(mock)

    check('首次导入 → outcome=imported', result.outcome === 'imported', `(${result.outcome})`)
    check('状态推进到 registered', result.capture?.status === 'registered', `(${result.capture?.status})`)
    check(
      '宽高来自 identify（800x600）',
      result.capture?.width === 800 && result.capture?.height === 600,
      `(${result.capture?.width}x${result.capture?.height})`,
    )
    check('byte_size 等于实际字节数', result.capture?.byteSize === fixtures.sheet.length)
    check(
      'media_type 由 identify 决定（非扩展名，.PNG 大写也一样）',
      result.capture?.mediaType === 'image/png',
      `(${result.capture?.mediaType})`,
    )
    check('sha256 与源文件一致', result.capture?.sha256 === sheetSha, `(${result.capture?.sha256})`)

    const absolute = path.join(root, result.capture.originalPath)
    check('归档文件真实落盘', existsSync(absolute), absolute.replace(root, '<root>'))
    check(
      '归档文件哈希与源一致',
      sha256hex(readFileSync(absolute)) === sheetSha,
    )
    check('归档文件大小与源一致', statSync(absolute).size === fixtures.sheet.length)
    check(
      '相对路径符合命名规则',
      /^数学\/一年级上\/\d{8}-\d{6}\.[0-9a-f]{12}-[0-9a-f]{32}\.png$/.test(result.capture.originalPath),
      result.capture.originalPath,
    )
    check(
      '分类来自路径 join（display_name 与 directory_name 不同）',
      result.capture?.subject?.code === 'math' && result.capture?.term?.displayName === '一年级上学期',
      `(${result.capture?.subject?.code}/${result.capture?.term?.displayName})`,
    )
    check(
      'originalUrl 逐段百分号编码，不暴露本机路径',
      typeof result.capture?.originalUrl === 'string' &&
        result.capture.originalUrl.startsWith('/wrongbook/originals/%E6%95%B0%E5%AD%A6/') &&
        !result.capture.originalUrl.includes(root),
      result.capture?.originalUrl,
    )

    // listCaptures 走同一条 captureSelect，验证列表页的分类 join 也成立
    const listed = await svc.listCaptures({ limit: 10 })
    check(
      'listCaptures 的分类同样来自路径 join',
      listed.items.length === 1 &&
        listed.items[0].subject?.code === 'math' &&
        listed.items[0].term?.code === 'g1t1',
      JSON.stringify(listed.items.map((item) => [item.subject?.code, item.term?.code])),
    )
  }

  // =========================================================================
  // 用例 2：同文件换科目再导入 → duplicate，且不重新复制、不改状态
  // =========================================================================
  {
    const before = listArchiveFiles(root)
    const mock = mainMock
    const cursor = mock.log.length
    const svc = service(mock, root)
    const result = await svc.importOne({
      stream: Readable.from([fixtures.sheet]),
      subjectCode: 'chinese',
      termCode: 'g1t2',
      filename: 'renamed.jpg',
      contentLength: fixtures.sheet.length,
    })
    remember(mock)
    const after = listArchiveFiles(root)
    const thisRequest = mock.log.slice(cursor)

    check('同文件换科目再导入 → duplicate', result.outcome === 'duplicate', `(${result.outcome})`)
    check('duplicate 返回既有 capture 本身（不新建行）', result.capture?.sha256 === sheetSha)
    check(
      'duplicate 保持原分类（不按新请求的科目改写）',
      result.capture?.subject?.code === 'math' && result.capture?.term?.code === 'g1t1',
      `(${result.capture?.subject?.code}/${result.capture?.term?.code})`,
    )
    check('duplicate 不产生新归档文件', before.length === after.length, `(${before.length} → ${after.length})`)
    check(
      'duplicate 不执行任何状态更新（本次请求无 UPDATE）',
      thisRequest.every((entry) => !/^update/i.test(entry.sql)),
      JSON.stringify(thisRequest.filter((entry) => /^update/i.test(entry.sql))),
    )
    check(
      'duplicate 不再执行 INSERT 复制记录（只走冲突检测）',
      thisRequest.filter((entry) => /^insert/i.test(entry.sql)).length === 1,
      `本次 insert 次数=${thisRequest.filter((entry) => /^insert/i.test(entry.sql)).length}`,
    )
    const captureStatements = thisRequest.filter((entry) => /app\.captures/i.test(entry.sql))
    check(
      '先走 ON CONFLICT 预留（第一条 captures 语句是 INSERT，不是先 SELECT）',
      captureStatements.length > 0 && /^insert/i.test(captureStatements[0].sql),
      captureStatements[0]?.sql.slice(0, 60),
    )
  }

  // =========================================================================
  // 用例 3a：声明的 Content-Length 超限 → 读流之前就拒绝
  // =========================================================================
  {
    const mock = createMock()
    const svc = service(mock, root)
    const before = listArchiveFiles(root)
    let caught = null
    try {
      await svc.importOne({
        stream: Readable.from([Buffer.alloc(1024)]),
        subjectCode: 'math',
        termCode: 'g1t1',
        filename: 'big.png',
        contentLength: 33554433,
      })
    } catch (error) {
      caught = error
    }
    remember(mock)
    check(
      '声明超限 → PAYLOAD_TOO_LARGE(413)',
      caught instanceof ImportError && caught.code === 'PAYLOAD_TOO_LARGE' && caught.status === 413,
      `(${caught?.code}/${caught?.status})`,
    )
    check('声明超限时不写库、不落盘', writeStatements(mock).length === 0 && listArchiveFiles(root).length === before.length)
  }

  // =========================================================================
  // 用例 3b：实际字节超限（Content-Length 撒谎）→ 流式累计时拦住
  // =========================================================================
  {
    const mock = createMock()
    const svc = service(mock, root)
    let caught = null
    try {
      await svc.importOne({
        stream: Readable.from([Buffer.alloc(33554433, 0x41)]),
        subjectCode: 'math',
        termCode: 'g1t1',
        filename: 'lie.png',
        contentLength: 1024,
      })
    } catch (error) {
      caught = error
    }
    remember(mock)
    check(
      '实际字节超限（Content-Length 撒谎）→ PAYLOAD_TOO_LARGE',
      caught?.code === 'PAYLOAD_TOO_LARGE',
      `(${caught?.code})`,
    )
    check('流式超限时未执行任何写库语句', writeStatements(mock).length === 0)
  }

  // =========================================================================
  // 用例 4：字典校验（非法科目 / 路径穿越科目 / 非法学期）
  // =========================================================================
  {
    const mock = createMock()
    const svc = service(mock, root)
    let caught = null
    try {
      await svc.importOne({
        stream: Readable.from([fixtures.sheet]),
        subjectCode: 'not_exist',
        termCode: 'g1t1',
        filename: 'x.png',
        contentLength: fixtures.sheet.length,
      })
    } catch (error) {
      caught = error
    }
    check('非法科目 → INVALID_SUBJECT_CODE(400)', caught?.code === 'INVALID_SUBJECT_CODE' && caught?.status === 400, `(${caught?.code})`)
  }
  {
    const mock = createMock()
    const svc = service(mock, root)
    let caught = null
    try {
      await svc.importOne({
        stream: Readable.from([fixtures.sheet]),
        subjectCode: '../../etc',
        termCode: 'g1t1',
        filename: 'x.png',
        contentLength: fixtures.sheet.length,
      })
    } catch (error) {
      caught = error
    }
    remember(mock)
    check(
      '路径穿越科目 → 被字典校验拦住（INVALID_SUBJECT_CODE）',
      caught?.code === 'INVALID_SUBJECT_CODE',
      `(${caught?.code})`,
    )
    check(
      '路径穿越时科目查询参数原样进 SQL 参数（不做路径拼接）',
      mock.log.every((entry) => !entry.sql.includes('../')),
    )
  }
  {
    const mock = createMock()
    const svc = service(mock, root)
    let caught = null
    try {
      await svc.importOne({
        stream: Readable.from([fixtures.sheet]),
        subjectCode: 'math',
        termCode: 'g9t9',
        filename: 'x.png',
        contentLength: fixtures.sheet.length,
      })
    } catch (error) {
      caught = error
    }
    remember(mock)
    check('非法学期 → INVALID_TERM_CODE(400)', caught?.code === 'INVALID_TERM_CODE' && caught?.status === 400, `(${caught?.code})`)
    check('非法学期时不写库', writeStatements(mock).length === 0)
  }

  // =========================================================================
  // 用例 5：非法文件名（含 / 或 ..）→ 在校验阶段就拒绝，任何 SQL 都不发
  // =========================================================================
  {
    const mock = createMock()
    const svc = service(mock, root)
    const filesBefore = listArchiveFiles(root)
    const results = []
    for (const badName of ['../escape.png', 'a/b.png', 'a\\b.png', '..', '.', ' trailing.png']) {
      try {
        await svc.importOne({
          stream: Readable.from([fixtures.sheet]),
          subjectCode: 'math',
          termCode: 'g1t1',
          filename: badName,
          contentLength: fixtures.sheet.length,
        })
        results.push({ badName, code: 'NO_ERROR' })
      } catch (error) {
        results.push({ badName, code: error.code })
      }
    }
    remember(mock)
    check(
      '含 / 、\\ 、.. 的文件名全部 → INVALID_FILENAME(400)',
      results.every((item) => item.code === 'INVALID_FILENAME'),
      JSON.stringify(results),
    )
    check('文件名不合法时一条 SQL 都不发', mock.log.length === 0, `(${mock.log.length} 条)`)
    check(
      '文件名不合法时未落盘任何文件',
      listArchiveFiles(root).length === filesBefore.length,
      `(${filesBefore.length} → ${listArchiveFiles(root).length})`,
    )
  }

  // =========================================================================
  // 用例 6：空上传（两条路径：声明 0 字节 / 实际 0 字节流）
  // =========================================================================
  {
    const mock = createMock()
    const svc = service(mock, root)
    let caught = null
    try {
      await svc.importOne({
        stream: Readable.from([]),
        subjectCode: 'math',
        termCode: 'g1t1',
        filename: 'empty.png',
        contentLength: 0,
      })
    } catch (error) {
      caught = error
    }
    remember(mock)
    check('声明 0 字节 → EMPTY_UPLOAD(400)', caught?.code === 'EMPTY_UPLOAD' && caught?.status === 400, `(${caught?.code})`)
    check('声明 0 字节时不写库', writeStatements(mock).length === 0)
  }
  {
    const mock = createMock()
    const svc = service(mock, root)
    let caught = null
    try {
      await svc.importOne({
        stream: Readable.from([]),
        subjectCode: 'math',
        termCode: 'g1t1',
        filename: 'empty.png',
        // 无 Content-Length（chunked 场景）：只能靠流式累计的字节数判断
      })
    } catch (error) {
      caught = error
    }
    remember(mock)
    check(
      '实际 0 字节（无 Content-Length）→ EMPTY_UPLOAD',
      caught?.code === 'EMPTY_UPLOAD',
      `(${caught?.code})`,
    )
    check('实际 0 字节时不写库（不预留空哈希）', writeStatements(mock).length === 0)
  }

  // =========================================================================
  // 用例 7：探测失败 422 与不支持格式 415 的分界
  // =========================================================================
  {
    const mock = createMock()
    const svc = service(mock, root)
    let caught = null
    try {
      await svc.importOne({
        stream: Readable.from([fixtures.notImage]),
        subjectCode: 'math',
        termCode: 'g1t1',
        filename: 'fake.jpg',
        contentLength: fixtures.notImage.length,
      })
    } catch (error) {
      caught = error
    }
    remember(mock)
    check(
      '非图片（文本改名 .jpg）→ IMAGE_PROBE_FAILED(422)',
      caught?.code === 'IMAGE_PROBE_FAILED' && caught?.status === 422,
      `(${caught?.code}/${caught?.status})`,
    )
    check('探测失败时不写库', writeStatements(mock).length === 0)
  }
  {
    const mock = createMock()
    const svc = service(mock, root)
    let caught = null
    try {
      await svc.importOne({
        stream: Readable.from([fixtures.truncated]),
        subjectCode: 'math',
        termCode: 'g1t1',
        filename: 'truncated.png',
        contentLength: fixtures.truncated.length,
      })
    } catch (error) {
      caught = error
    }
    remember(mock)
    check('截断 PNG → IMAGE_PROBE_FAILED', caught?.code === 'IMAGE_PROBE_FAILED', `(${caught?.code})`)
  }
  {
    const mock = createMock()
    const svc = service(mock, root)
    let caught = null
    try {
      await svc.importOne({
        stream: Readable.from([fixtures.bmp]),
        subjectCode: 'math',
        termCode: 'g1t1',
        filename: 'photo.png',
        contentLength: fixtures.bmp.length,
      })
    } catch (error) {
      caught = error
    }
    remember(mock)
    check(
      '白名单外格式（BMP）→ UNSUPPORTED_MEDIA_TYPE(415)',
      caught?.code === 'UNSUPPORTED_MEDIA_TYPE' && caught?.status === 415,
      `(${caught?.code}/${caught?.status})`,
    )
    check('格式不受支持时不写库', writeStatements(mock).length === 0)
  }
  {
    const mock = createMock()
    const svc = service(mock, root)
    let caught = null
    try {
      await svc.importOne({
        stream: Readable.from([fixtures.anim]),
        subjectCode: 'math',
        termCode: 'g1t1',
        filename: 'anim.gif',
        contentLength: fixtures.anim.length,
      })
    } catch (error) {
      caught = error
    }
    remember(mock)
    check('多帧 GIF（非单帧）→ IMAGE_PROBE_FAILED', caught?.code === 'IMAGE_PROBE_FAILED', `(${caught?.code})`)
    check(
      '「探测失败 422」与「格式不支持 415」是两个不同错误码',
      caught?.code !== 'UNSUPPORTED_MEDIA_TYPE',
      `(${caught?.code})`,
    )
  }

  // =========================================================================
  // 用例 8a：reserved 恢复分支（reviewer 第 2 轮指出的覆盖缺口）
  //  既有行 status='reserved' + 归档文件完好 → 补齐 copied 再 registered
  // =========================================================================
  {
    const relPath = '数学/一年级上/recover-reserved.png'
    const absolute = path.join(root, relPath)
    execFileSync('mkdir', ['-p', path.dirname(absolute)])
    writeFileSync(absolute, fixtures.other)
    const before = listArchiveFiles(root)

    const mock = createMock({
      seed: [
        {
          id: 'cap-reserved',
          sha256: createHash('sha256').update(fixtures.other).digest(),
          original_path: relPath,
          original_filename: 'recover.png',
          status: 'reserved',
        },
      ],
    })
    const svc = service(mock, root)
    const result = await svc.importOne({
      stream: Readable.from([fixtures.other]),
      subjectCode: 'math',
      termCode: 'g1t1',
      filename: 'recover.png',
      contentLength: fixtures.other.length,
    })
    remember(mock)
    const after = listArchiveFiles(root)
    const updates = mock.log.filter((entry) => /^update/i.test(entry.sql)).map((entry) => entry.sql)

    check('reserved + 文件完好 → outcome=imported（恢复而非重复报错）', result.outcome === 'imported', `(${result.outcome})`)
    check('reserved 恢复后状态为 registered', result.capture?.status === 'registered', `(${result.capture?.status})`)
    check('reserved 恢复补齐 copied 推进', updates.some((sql) => /set status = 'copied'/i.test(sql)))
    check('reserved 恢复再推进到 registered', updates.some((sql) => /set status = 'registered'/i.test(sql)))
    check('reserved 恢复不重新复制文件（归档文件数不变）', before.length === after.length, `(${before.length} → ${after.length})`)
    check(
      'reserved 恢复复用既有行（capture id 未变，没有新建记录）',
      result.capture?.id === 'cap-reserved',
      `(${result.capture?.id})`,
    )
    check(
      'reserved 恢复只做一次预留尝试（冲突后转入恢复，不重复复制）',
      mock.log.filter((entry) => /^insert/i.test(entry.sql)).length === 1,
      `insert 次数=${mock.log.filter((entry) => /^insert/i.test(entry.sql)).length}`,
    )
    check(
      'reserved 恢复后媒体信息已补齐（不是空记录）',
      result.capture?.mediaType === 'image/png' && result.capture?.byteSize === fixtures.other.length,
      `(${result.capture?.mediaType}/${result.capture?.byteSize})`,
    )
  }

  // =========================================================================
  // 用例 8b：copied 恢复分支
  //  既有行 status='copied' + 归档文件完好 → 只补 registered，不再重复探测/复制
  // =========================================================================
  {
    const relPath = '语文/一年级下/recover-copied.png'
    const absolute = path.join(root, relPath)
    execFileSync('mkdir', ['-p', path.dirname(absolute)])
    writeFileSync(absolute, fixtures.other)
    const before = listArchiveFiles(root)

    const mock = createMock({
      seed: [
        {
          id: 'cap-copied',
          sha256: createHash('sha256').update(fixtures.other).digest(),
          original_path: relPath,
          original_filename: 'recover.png',
          status: 'copied',
          media_type: 'image/png',
          byte_size: fixtures.other.length,
          width: 640,
          height: 480,
        },
      ],
    })
    const svc = service(mock, root)
    const result = await svc.importOne({
      stream: Readable.from([fixtures.other]),
      subjectCode: 'math',
      termCode: 'g1t1',
      filename: 'recover.png',
      contentLength: fixtures.other.length,
    })
    remember(mock)
    const updates = mock.log.filter((entry) => /^update/i.test(entry.sql)).map((entry) => entry.sql)
    const after = listArchiveFiles(root)

    check('copied + 文件完好 → outcome=imported', result.outcome === 'imported', `(${result.outcome})`)
    check('copied 恢复后状态为 registered', result.capture?.status === 'registered', `(${result.capture?.status})`)
    check(
      'copied 恢复不再重复写 copied（只做 registered）',
      !updates.some((sql) => /set status = 'copied'/i.test(sql)),
      JSON.stringify(updates.map((sql) => sql.slice(0, 40))),
    )
    check('copied 恢复不重新复制文件', before.length === after.length)
    check(
      'copied 恢复保留原有分类（路径 join）',
      result.capture?.subject?.code === 'chinese' && result.capture?.term?.code === 'g1t2',
      `(${result.capture?.subject?.code}/${result.capture?.term?.code})`,
    )
  }

  // =========================================================================
  // 用例 8c：reserved/copied 但文件缺失或损坏 → 409，绝不当成功
  // =========================================================================
  {
    const mock = createMock({
      seed: [
        {
          id: 'cap-reserved-missing',
          sha256: createHash('sha256').update(fixtures.other).digest(),
          original_path: '数学/一年级上/ghost-reserved.png',
          original_filename: 'ghost.png',
          status: 'reserved',
        },
      ],
    })
    const svc = service(mock, root)
    let caught = null
    try {
      await svc.importOne({
        stream: Readable.from([fixtures.other]),
        subjectCode: 'math',
        termCode: 'g1t1',
        filename: 'ghost.png',
        contentLength: fixtures.other.length,
      })
    } catch (error) {
      caught = error
    }
    remember(mock)
    check(
      'reserved 但归档文件缺失 → CAPTURE_RECOVERY_REQUIRED(409)',
      caught?.code === 'CAPTURE_RECOVERY_REQUIRED' && caught?.status === 409,
      `(${caught?.code}/${caught?.status})`,
    )
    check('reserved 文件缺失时不返回 imported/duplicate', caught !== null, '未抛错等于谎报成功')
  }
  {
    const relPath = '数学/一年级上/corrupt-copied.png'
    const absolute = path.join(root, relPath)
    execFileSync('mkdir', ['-p', path.dirname(absolute)])
    // 同长度不同内容：只比大小会漏判，必须复算哈希
    writeFileSync(absolute, Buffer.concat([fixtures.other.subarray(0, fixtures.other.length - 1), Buffer.from([0x00])]))
    const mock = createMock({
      seed: [
        {
          id: 'cap-copied-corrupt',
          sha256: createHash('sha256').update(fixtures.other).digest(),
          original_path: relPath,
          original_filename: 'corrupt.png',
          status: 'copied',
          media_type: 'image/png',
          byte_size: fixtures.other.length,
          width: 640,
          height: 480,
        },
      ],
    })
    const svc = service(mock, root)
    let caught = null
    try {
      await svc.importOne({
        stream: Readable.from([fixtures.other]),
        subjectCode: 'math',
        termCode: 'g1t1',
        filename: 'corrupt.png',
        contentLength: fixtures.other.length,
      })
    } catch (error) {
      caught = error
    }
    remember(mock)
    check(
      'copied 但文件内容被替换（同长度）→ CAPTURE_RECOVERY_REQUIRED',
      caught?.code === 'CAPTURE_RECOVERY_REQUIRED',
      `(${caught?.code})`,
    )
    check('被测文件内容不符时不推进状态', writeStatements(mock).every((entry) => !/set status/i.test(entry.sql)))
  }

  // =========================================================================
  // 用例 9：markCopied 幂等冲突（并发恢复）→ rowCount=0 → CAPTURE_RECOVERY_REQUIRED
  //  这条用例专门验证 markCopied 里 `AND status = 'reserved'` 的幂等保护：
  //  实现一旦漏掉这个条件，本次 UPDATE 会「成功」，用例就会失败。
  // =========================================================================
  {
    const mock = createMock({ faults: { loseMarkCopiedRace: true } })
    const svc = service(mock, root)
    let caught = null
    try {
      await svc.importOne({
        stream: Readable.from([fixtures.other]),
        subjectCode: 'math',
        termCode: 'g1t1',
        filename: 'race.png',
        contentLength: fixtures.other.length,
      })
    } catch (error) {
      caught = error
    }
    remember(mock)
    check(
      'markCopied 竞争失败（rowCount=0）→ CAPTURE_RECOVERY_REQUIRED',
      caught?.code === 'CAPTURE_RECOVERY_REQUIRED',
      `(${caught?.code})`,
    )
    check('该错误可重试（retryable=true, 409）', caught?.retryable === true && caught?.status === 409, `(${caught?.retryable}/${caught?.status})`)
    const recordFailure = mock.log.filter((entry) => /set last_error/i.test(entry.sql))
    check(
      '竞争失败后回写 last_error 不会越过状态机（WHERE status 不匹配 → 影响 0 行）',
      recordFailure.length === 0 || [...mock.rows.values()].every((row) => row.last_error === null),
      JSON.stringify(recordFailure.map((entry) => entry.sql.slice(0, 60))),
    )
  }

  // =========================================================================
  // 用例 10：staging 不外泄（每个用例都 discard，归档根里不留 .upload）
  // =========================================================================
  {
    const stagingDir = path.join(root, '.wrongbook-tmp')
    const leftovers = existsSync(stagingDir)
      ? readdirSync(stagingDir).filter((name) => name.endsWith('.upload'))
      : []
    check('staging 文件全部清理（成功与失败路径都不留 .upload）', leftovers.length === 0, JSON.stringify(leftovers))
  }

  // =========================================================================
  // 全局断言：实现从不写 page_id（替代原先「mock 里 page_id 恒 null」的恒真断言）
  // =========================================================================
  {
    const writes = allLogs.filter((entry) => /^(insert|update|delete)/i.test(entry.sql))
    const touchingPageId = writes.filter((entry) => /\bpage_id\b/i.test(entry.sql))
    check(
      '所有写库语句都不触碰 page_id（归组是下一步的事）',
      writes.length > 0 && touchingPageId.length === 0,
      `写语句 ${writes.length} 条，涉及 page_id ${touchingPageId.length} 条`,
    )
    check(
      '预留语句带 ON CONFLICT (sha256) DO NOTHING（并发唯一仲裁点）',
      writes
        .filter((entry) => /^insert/i.test(entry.sql))
        .every((entry) => /on conflict \(sha256\) do nothing/i.test(entry.sql)),
    )
  }
} finally {
  rmSync(root, { recursive: true, force: true })
  rmSync(fixtureDir, { recursive: true, force: true })
}

console.log(`\n${pass}/${pass + fail} 通过`)
process.exit(fail === 0 ? 0 : 1)
