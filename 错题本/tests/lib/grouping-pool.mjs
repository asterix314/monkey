// 带事务语义的内存池替身 — 专供第 6 步 Page 归组测试
//
// 为什么不用 tests/lib/strict-mock.mjs：
//  · strict-mock 只认识**导入状态机**的那几条 SQL，任何别的 SQL 都直接抛错；
//  · 它没有 BEGIN/COMMIT/ROLLBACK 概念，也没有 documents/pages 表，
//    因此无法验证「createPage 中途失败时 document 不留孤儿」这类事务语义；
//  · 它没有行锁，无法表达「同一 Capture 被两个事务并发争抢」。
//
// 这个替身的取舍：**复刻约束，不复刻全部 PostgreSQL**。
// 它实现的东西都对应一条真实约束或一条真实语义：
//  · uq_captures_id_page_id 复合外键（pages.preferred_capture_id 必须属于本页）
//  · trig_pages_status_transition（organized 必须有 preferred + ready asset）
//  · trig_captures_status_transition（状态只能向前）
//  · documents/pages 的外键与 NOT NULL
//  · BEGIN/COMMIT/ROLLBACK 与「回滚丢弃本次事务的全部写入」
//  · FOR UPDATE 行锁：同一 key 的并发事务串行化
//
// 它**不**实现：SQL 解析、索引、隔离级别、真正的并发调度。
// 因此并发用例证明的是「实现用了行锁 + 乐观条件」这个**逻辑**正确，
// 真实 PostgreSQL 上的仲裁仍需一次人工验证（README 记录）。

const SUBJECT_BY_DIR = new Map([
  ['数学', { id: 's-math', code: 'math', display_name: '数学', enabled: true }],
  ['语文', { id: 's-chinese', code: 'chinese', display_name: '语文', enabled: true }],
  ['英语', { id: 's-english', code: 'english', display_name: '英语', enabled: true }],
  ['其他', { id: 's-other', code: 'other', display_name: '其他', enabled: true }],
  ['未分类', { id: 's-unclassified', code: 'unclassified', display_name: '未分类', enabled: true }],
])

const TERM_BY_DIR = new Map([
  ['一年级上', { id: 't-g1t1', code: 'g1t1', display_name: '一年级上学期' }],
  ['一年级下', { id: 't-g1t2', code: 'g1t2', display_name: '一年级下学期' }],
  ['未分类', { id: 't-unclassified', code: 'unclassified', display_name: '未分类' }],
])

let uuidCounter = 0
/** 递增的确定性 UUID（v4 形状），避免随机导致测试不可复现。 */
function nextUuid() {
  uuidCounter += 1
  const hex = uuidCounter.toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${hex}`
}

/** PostgreSQL 错误形状（带 code / constraint），供 translateDatabaseError 识别。 */
function pgError(code, constraint, message) {
  const error = new Error(message ?? `mock 数据库拒绝：${constraint}`)
  error.code = code
  if (constraint !== undefined) error.constraint = constraint
  return error
}

/**
 * 解析 `insert into app.<table> (a, b, c) values ($1, $2, 'literal')` 的列与值。
 *
 * 返回 `[{column, kind, value|placeholder}]`。
 *
 * 为什么要解析 values 而不是按位置取 params：实现里 `source_type` 和 `status`
 * 是**字面量**（`'other'` / `'pending'`），不是参数。只按位置映射会把字面量列
 * 当成缺参数而报错；而若改成「缺参数就填默认值」，就又回到「mock 替实现补值」
 * 的老毛病 —— 实现把字面量删掉，测试仍然绿。
 */
function parseInsert(text, table) {
  const match = text.match(
    new RegExp(`insert\\s+into\\s+app\\.${table}\\s*\\(([^)]*)\\)\\s*values\\s*\\(([^)]*)\\)`, 'i'),
  )
  if (match === null) {
    throw new Error(`grouping-pool：无法解析 insert ${table} → ${text.slice(0, 160)}`)
  }
  const columns = match[1].split(',').map((part) => part.trim().toLowerCase()).filter(Boolean)
  const values = match[2].split(',').map((part) => part.trim())
  if (columns.length === 0 || columns.length !== values.length) {
    throw new Error(
      `grouping-pool：insert ${table} 列数与值数不一致（${columns.length} vs ${values.length}）`,
    )
  }
  return columns.map((column, index) => {
    const raw = values[index]
    const placeholder = raw.match(/^\$(\d+)$/)
    if (placeholder !== null) {
      return { column, kind: 'param', placeholder: Number(placeholder[1]) }
    }
    const literal = raw.match(/^'([^']*)'$/)
    if (literal !== null) {
      return { column, kind: 'literal', value: literal[1] }
    }
    const numeric = raw.match(/^-?\d+(?:\.\d+)?$/)
    if (numeric !== null) {
      return { column, kind: 'literal', value: Number(raw) }
    }
    if (/^null$/i.test(raw)) {
      return { column, kind: 'literal', value: null }
    }
    throw new Error(
      `grouping-pool：insert ${table} 的列 ${column} 值 "${raw}" 不是 $N / 字面量 / NULL`,
    )
  })
}

/**
 * 把解析结果映射成行字段。
 *
 * `defaults` 只表达**数据库 schema 自己的默认值**（如 source_type DEFAULT 'other'），
 * 不是给实现兜底：实现若省略某列，落库值来自 schema 默认值 —— 与真实
 * PostgreSQL 一致，断言检查的是「省略时是否仍符合 schema」。
 */
function mapInsertValues(parsed, params, table, defaults) {
  const row = {}
  for (const entry of parsed) {
    if (entry.kind === 'param') {
      const value = params[entry.placeholder - 1]
      if (value === undefined) {
        throw new Error(`grouping-pool：insert ${table} 列 ${entry.column} 缺少参数 $${entry.placeholder}`)
      }
      row[entry.column] = value
    } else {
      row[entry.column] = entry.value
    }
  }
  for (const [column, value] of Object.entries(defaults)) {
    if (!(column in row)) row[column] = value
  }
  return row
}

/**
 * 解析 `set a = $1, b = $2` 的全部赋值，返回 `[{column, placeholder}]`。
 *
 * 只认第一个赋值是上一版 mock 的缺陷：`set page_id = $1, status = 'x'`
 * 会被静默接受，而 status 从未被写入 → 「status 没变」的断言恒真。
 */
function parseSetAssignments(text, table) {
  const setMatch = text.match(/\bset\b([\s\S]*?)\bwhere\b/i)
  if (setMatch === null) {
    throw new Error(`grouping-pool：update ${table} 缺少 set ... where → ${text.slice(0, 160)}`)
  }
  const assignments = []
  for (const chunk of setMatch[1].split(',')) {
    const part = chunk.trim()
    if (part === '') continue
    const match = part.match(/^([a-z_][a-z0-9_]*)\s*=\s*\$(\d+)$/i)
    if (match === null) {
      // 非 `col = $N` 形式的赋值（字面量、表达式、函数调用）一律拒绝：
      // 接受它就意味着 mock 要「理解」它，那等于替实现解释语义。
      throw new Error(
        `grouping-pool：update ${table} 的 set 子句只支持 col = $N，收到 "${part}" → ${text.slice(0, 160)}`,
      )
    }
    assignments.push({ column: match[1].toLowerCase(), placeholder: Number(match[2]) })
  }
  if (assignments.length === 0) {
    throw new Error(`grouping-pool：update ${table} 没有可解析的 set 赋值`)
  }
  return assignments
}

/** 拒绝白名单之外的列，避免 mock 静默吞掉实现多写的列。 */
function assertAllowedColumns(assignments, allowed, table) {
  for (const { column } of assignments) {
    if (!allowed.has(column)) {
      throw new Error(
        `grouping-pool：update ${table} 写入了非白名单列 "${column}"（本步只允许 ${[...allowed].join('/')}）`,
      )
    }
  }
}

/**
 * @param {{captures?: object[], faults?: object}} [options]
 * @returns {object} 可直接当 pool 用的对象（有 query 与 connect）
 */
export function createGroupingPool({ captures = [], faults = {} } = {}) {
  /** 已提交状态 */
  const committed = {
    captures: new Map(captures.map((row) => [row.id, normalizeCapture(row)])),
    documents: new Map(),
    pages: new Map(),
  }
  /** 每条语句（已归一化空白），供卫生断言 */
  const statements = []
  /** 行锁：key -> 当前持锁事务的 promise 链尾 */
  const locks = new Map()
  /**
   * 未显式收尾就归还连接的事务计数。
   *
   * 这是「实现漏了 ROLLBACK」唯一可靠的判红点：mock 的 overlay 在没 COMMIT 时
   * 本来就会被丢弃，所以「回滚后没有孤儿 document」那条断言**证明不了**
   * 实现调过 ROLLBACK —— 它只证明没有孤儿，而 mock 无论如何都不会有。
   */
  let leakedTransactions = 0
  /**
   * 借出后未归还的连接数。
   *
   * `leakedTransactions` 只在 release() 被调用时才计数，因此测不到
   * 「实现从不 release」这种更严重的泄漏。这个计数在 connect 时 +1、
   * release 时 -1，测试断言终态为 0，两者互补。
   */
  let openConnections = 0
  const leakedDetail = []
  /** 最近一条语句，用于定位漏收尾的事务。 */
  let lastStatement = null

  function normalizeCapture(row) {
    return {
      visual_fingerprint: null,
      visual_fingerprint_method: null,
      source_metadata_json: {},
      last_error: null,
      created_at: new Date('2026-11-27T08:00:00Z'),
      media_type: 'image/jpeg',
      byte_size: 1000,
      width: 3072,
      height: 4096,
      ...row,
    }
  }

  /** 取得某个 key 的行锁（串行化同一资源的并发事务）。 */
  async function acquireLock(key) {
    const previous = locks.get(key) ?? Promise.resolve()
    let release
    const held = new Promise((resolve) => {
      release = resolve
    })
    locks.set(key, previous.then(() => held))
    await previous
    return release
  }

  /**
   * 一个事务的视图：写操作先落到 overlay，COMMIT 时合并，ROLLBACK 时丢弃。
   *
   * 这就是「回滚后 document 不留孤儿」能够被测试的前提 ——
   * 若实现漏了 ROLLBACK，overlay 会被提交，断言立刻变红。
   */
  function createTransaction() {
    const overlay = {
      captures: new Map(),
      documents: new Map(),
      pages: new Map(),
    }
    let finished = false

    const view = (table) => {
      const map = new Map(committed[table])
      for (const [key, value] of overlay[table]) map.set(key, value)
      return map
    }

    function writeCapture(id, patch) {
      const current = overlay.captures.get(id) ?? committed.captures.get(id)
      if (current === undefined) return null
      const next = { ...current, ...patch }
      overlay.captures.set(id, next)
      return next
    }

    const api = {
      view,
      overlay,
      get finished() {
        return finished
      },
      writeCapture,
      insertDocument(row) {
        const id = nextUuid()
        overlay.documents.set(id, { id, ...row })
        return id
      },
      insertPage(row) {
        const id = nextUuid()
        overlay.pages.set(id, {
          id,
          page_number: null,
          preferred_capture_id: null,
          notes: null,
          created_at: new Date(),
          ...row,
        })
        return id
      },
      writePage(id, patch) {
        const current = overlay.pages.get(id) ?? committed.pages.get(id)
        if (current === undefined) return null
        const next = { ...current, ...patch }
        overlay.pages.set(id, next)
        return next
      },
      commit() {
        if (finished) return
        finished = true
        for (const table of ['captures', 'documents', 'pages']) {
          for (const [key, value] of overlay[table]) committed[table].set(key, value)
        }
      },
      rollback() {
        if (finished) return
        finished = true
        // 丢弃 overlay 即可 —— 这正是「不留孤儿」的保证点
      },
    }
    return api
  }

  /** 把 pages 上的复合外键 / 状态机守卫当作提交前的校验。 */
  function validatePage(page, tx) {
    const captures = tx.view('captures')
    if (page.status === 'organized') {
      // trig_pages_status_transition：organized 必须有首选，且必须有 ready 的 standardized asset
      if (page.preferred_capture_id === null) {
        throw pgError('P0001', 'trig_pages_status_transition', 'page cannot be organized without a preferred capture')
      }
      throw pgError(
        'P0001',
        'trig_pages_status_transition',
        'page cannot be organized: no ready standardized asset in this mock (第 7 步才产出)',
      )
    }
    if (page.preferred_capture_id !== null) {
      const preferred = captures.get(page.preferred_capture_id)
      if (preferred === undefined) {
        throw pgError('23503', 'fk_pages_preferred_capture_id', 'preferred capture 不存在')
      }
      // 复合外键 (preferred_capture_id, id) -> captures(id, page_id)
      if (preferred.page_id !== page.id) {
        throw pgError('23503', 'fk_pages_preferred_capture_id', 'preferred capture 不属于本页')
      }
    }
  }

  /** 解析出 captureId / pageId（实现里都是 $1、$2 位置参数）。 */
  function queryInTransaction(tx, sql, params) {
    const text = sql

    // ---- captures：SELECT ... FOR UPDATE ----
    if (/select\s+id,\s*page_id,\s*status,\s*original_path\s+from\s+app\.captures\s+where\s+id\s*=\s*\$1(\s+for\s+update)?\s*$/i.test(text)) {
      const row = tx.view('captures').get(params[0])
      return row === undefined ? { rows: [], rowCount: 0 } : { rows: [{ ...row }], rowCount: 1 }
    }
    if (/select\s+id,\s*page_id,\s*status\s+from\s+app\.captures\s+where\s+id\s*=\s*\$1(\s+for\s+update)?\s*$/i.test(text)) {
      const row = tx.view('captures').get(params[0])
      return row === undefined ? { rows: [], rowCount: 0 } : { rows: [{ ...row }], rowCount: 1 }
    }
    if (/select\s+id\s+from\s+app\.captures\s+where\s+id\s*=\s*\$1(\s+and\s+page_id\s*=\s*\$2)?\s*$/i.test(text)) {
      const row = tx.view('captures').get(params[0])
      // 按 SQL 里**实际写了什么**来判定，而不是替实现补全它没写的条件。
      //
      // 这里曾经写过一个「缺 $2 就退化成本行自己的 page_id」的兜底，本意是
      // 让去掉归属条件的变异也能跑到底。那是个错误：兜底等于由 mock 替实现
      // 补上归属校验，于是 M4（删掉 `and page_id = $2`）永远测不出来——
      // 测试通过只证明了 mock 的善意，没证明实现正确。
      //
      // 正确做法是忠实复刻 PostgreSQL：SQL 里没有 `and page_id = $2`，
      // 查询就真的只按 id 命中，于是「跨页设首选」会成功、断言变红。
      const requiresOwnership = /and\s+page_id\s*=\s*\$2/i.test(text)
      const hit =
        row !== undefined && (!requiresOwnership || row.page_id === params[1])
      return hit ? { rows: [{ id: row.id }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }

    // ---- pages：SELECT ... FOR UPDATE ----
    if (/select\s+id,\s*preferred_capture_id\s+from\s+app\.pages\s+where\s+id\s*=\s*\$1(\s+for\s+update)?\s*$/i.test(text)) {
      const row = tx.view('pages').get(params[0])
      return row === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id: row.id, preferred_capture_id: row.preferred_capture_id }], rowCount: 1 }
    }
    if (/select\s+id\s+from\s+app\.pages\s+where\s+id\s*=\s*\$1(\s+for\s+update)?\s*$/i.test(text)) {
      const row = tx.view('pages').get(params[0])
      return row === undefined ? { rows: [], rowCount: 0 } : { rows: [{ id: row.id }], rowCount: 1 }
    }

    // ---- 分类反查（子查询形态）----
    if (/select\s+\(select\s+id\s+from\s+app\.subjects/i.test(text)) {
      const subject = SUBJECT_BY_DIR.get(params[0])
      const term = TERM_BY_DIR.get(params[1])
      const subjectEnabled = /where\s+(?:s\.)?directory_name\s*=\s*\$1\s+and\s+(?:s\.)?enabled/i.test(text)
      const subjectId = subject !== undefined && (!subjectEnabled || subject.enabled) ? subject.id : null
      return { rows: [{ subject_id: subjectId, term_id: term?.id ?? null }], rowCount: 1 }
    }

    // ---- INSERT documents ----
    // 按 SQL 里**实际列出的列**建行，不用 `?? 默认值` 替实现补。
    //
    // 曾经写过 `source_type: params[2] ?? 'other'`，后果是：实现把 source_type
    // 从 INSERT 里删掉，测试照样绿——断言验证的是 mock 自己填的 'other'，
    // 不是实现写下的值。这跟 M4 兜底是同一个反模式，一并堵掉。
    if (/insert\s+into\s+app\.documents/i.test(text)) {
      const parsed = parseInsert(text, 'documents')
      const row = mapInsertValues(parsed, params, 'documents', {
        // 数据库层的默认值：只有 SQL 真的省略该列时才由**约束**补，不是由 mock 猜
        source_type: 'other',
        title: null,
        document_date: null,
      })
      const id = tx.insertDocument(row)
      return { rows: [{ id }], rowCount: 1 }
    }

    // ---- INSERT pages ----
    if (/insert\s+into\s+app\.pages/i.test(text)) {
      if (faults.failPageInsert) {
        throw pgError('23503', 'fk_pages_document_id', 'mock：注入的 page 插入失败')
      }
      const parsed = parseInsert(text, 'pages')
      const row = mapInsertValues(parsed, params, 'pages', {
        status: 'pending',
        page_number: null,
        preferred_capture_id: null,
        notes: null,
      })
      const id = tx.insertPage(row)
      return { rows: [{ id }], rowCount: 1 }
    }

    // ---- UPDATE captures ----
    // 解析完整 SET 列清单，白名单之外的列一律报错（不静默吞掉）。
    //
    // 曾经只认 `set page_id = $N`，于是
    // `update captures set page_id = $1, status = 'organized' where ...`
    // 会静默成功、status 原样不动，导致「status 仍是 registered」这类
    // 数据级断言恒真——实现真把 status 写坏了也测不出来。
    if (/update\s+app\.captures\b/i.test(text)) {
      const assignments = parseSetAssignments(text, 'captures')
      const allowed = new Set(['page_id', 'last_error'])
      assertAllowedColumns(assignments, allowed, 'captures')
      const wherePlaceholder = text.match(/where\s+id\s*=\s*\$(\d+)/i)
      if (wherePlaceholder === null) {
        throw new Error(`grouping-pool：update captures 缺少 where id → ${text.slice(0, 160)}`)
      }
      const captureId = params[Number(wherePlaceholder[1]) - 1]
      const current = tx.view('captures').get(captureId)
      if (current === undefined) return { rows: [], rowCount: 0 }
      // 只有 SQL 真的写了 `page_id is null` 才施加乐观条件
      const requiresNull = /page_id\s+is\s+null/i.test(text)
      if (requiresNull && current.page_id !== null) return { rows: [], rowCount: 0 }
      const patch = {}
      for (const { column, placeholder } of assignments) {
        patch[column] = params[placeholder - 1]
      }
      tx.writeCapture(captureId, patch)
      return { rows: [], rowCount: 1 }
    }

    // ---- UPDATE pages ----
    if (/update\s+app\.pages\b/i.test(text)) {
      const assignments = parseSetAssignments(text, 'pages')
      // status 不在白名单：本步 Page 只能是 pending，任何 UPDATE status 都该炸
      const allowed = new Set(['preferred_capture_id', 'notes', 'page_number'])
      assertAllowedColumns(assignments, allowed, 'pages')
      const wherePlaceholder = text.match(/where\s+id\s*=\s*\$(\d+)/i)
      if (wherePlaceholder === null) {
        throw new Error(`grouping-pool：update pages 缺少 where id → ${text.slice(0, 160)}`)
      }
      const pageId = params[Number(wherePlaceholder[1]) - 1]
      const current = tx.view('pages').get(pageId)
      if (current === undefined) return { rows: [], rowCount: 0 }
      const patch = {}
      for (const { column, placeholder } of assignments) {
        patch[column] = params[placeholder - 1]
      }
      tx.writePage(pageId, patch)
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`grouping-pool：事务内收到未预期的 SQL → ${text.replace(/\s+/g, ' ').slice(0, 160)}`)
  }

  function queryOutsideTransaction(sql, params) {
    const text = sql

    // listPages 主查询
    if (/from\s+app\.pages\s+p/i.test(text) && /group\s+by\s+p\.id/i.test(text)) {
      const pages = [...committed.pages.values()]
      const limit = Number(params[params.length - 1])
      const rows = pages.slice(0, Number.isInteger(limit) && limit > 0 ? limit : pages.length).map((page) => {
        const doc = committed.documents.get(page.document_id)
        const grouped = [...committed.captures.values()].filter((row) => row.page_id === page.id)
        const subject = doc === undefined ? undefined : [...SUBJECT_BY_DIR.values()].find((s) => s.id === doc.subject_id)
        const term = doc === undefined ? undefined : [...TERM_BY_DIR.values()].find((t) => t.id === doc.term_id)
        return {
          id: page.id,
          document_id: page.document_id,
          page_number: page.page_number,
          status: page.status,
          created_at: page.created_at,
          preferred_capture_id: page.preferred_capture_id,
          document_title: doc?.title ?? null,
          subject_code: subject?.code ?? null,
          subject_display_name: subject?.display_name ?? null,
          term_code: term?.code ?? null,
          term_display_name: term?.display_name ?? null,
          capture_count: grouped.length,
          latest_capture_at: grouped.length === 0 ? null : grouped[grouped.length - 1].created_at,
        }
      })
      return { rows, rowCount: rows.length }
    }

    // 单页回读（含 capture_count 子查询）
    if (/from\s+app\.pages\s+p/i.test(text) && /where\s+p\.id\s*=\s*\$1/i.test(text)) {
      const page = committed.pages.get(params[0])
      if (page === undefined) return { rows: [], rowCount: 0 }
      const doc = committed.documents.get(page.document_id)
      const grouped = [...committed.captures.values()].filter((row) => row.page_id === page.id)
      const subject = doc === undefined ? undefined : [...SUBJECT_BY_DIR.values()].find((s) => s.id === doc.subject_id)
      const term = doc === undefined ? undefined : [...TERM_BY_DIR.values()].find((t) => t.id === doc.term_id)
      return {
        rows: [
          {
            id: page.id,
            document_id: page.document_id,
            page_number: page.page_number,
            status: page.status,
            created_at: page.created_at,
            preferred_capture_id: page.preferred_capture_id,
            document_title: doc?.title ?? null,
            subject_code: subject?.code ?? null,
            subject_display_name: subject?.display_name ?? null,
            term_code: term?.code ?? null,
            term_display_name: term?.display_name ?? null,
            capture_count: grouped.length,
            latest_capture_at: grouped.length === 0 ? null : grouped[grouped.length - 1].created_at,
          },
        ],
        rowCount: 1,
      }
    }

    // Capture 回读（captureSelect 模板）
    if (/split_part\(c\.original_path/i.test(text)) {
      const project = (row) => {
        const [subjectDir, termDir] = String(row.original_path).split('/')
        const subject = SUBJECT_BY_DIR.get(subjectDir)
        const term = TERM_BY_DIR.get(termDir)
        return {
          id: row.id,
          sha256: 'a'.repeat(64),
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
          subject_code: subject?.code ?? null,
          subject_display_name: subject?.display_name ?? null,
          term_code: term?.code ?? null,
          term_display_name: term?.display_name ?? null,
        }
      }
      const all = [...committed.captures.values()]

      /**
       * 按 SQL 里**实际写的** ORDER BY 方向排序，不硬编码升序。
       *
       * 别名必须可选：`order by created_at desc`（无 c. 前缀）是合法且常见的
       * 写法。上一版只认 `order by c.created_at desc`，于是实现写无别名的
       * desc 时正则不命中 → mock 静默按升序返回，而断言又恰好按升序写，
       * 三者错位却全绿。这类「静默降级成另一种语义」比抛错危险得多，
       * 所以这里改成：认不出方向就抛错，绝不猜。
       */
      const sortByCreatedAt = (rows) => {
        const orderMatch = text.match(
          /order\s+by\s+(?:c\.)?created_at(?:\s+(asc|desc))?/i,
        )
        if (orderMatch === null) {
          throw new Error(
            `grouping-pool：查询未声明 order by created_at，无法确定返回顺序 → ${text.slice(0, 160)}`,
          )
        }
        const descending = (orderMatch[1] ?? '').toLowerCase() === 'desc'
        return [...rows].sort((a, b) =>
          descending ? b.created_at - a.created_at : a.created_at - b.created_at,
        )
      }

      if (/where\s+c\.page_id\s*=\s*any\(\$1/i.test(text)) {
        const wanted = new Set(params[0])
        const rows = all.filter((row) => wanted.has(row.page_id)).map(project)
        return { rows, rowCount: rows.length }
      }
      if (/where\s+c\.page_id\s*=\s*\$1/i.test(text)) {
        const rows = sortByCreatedAt(all.filter((row) => row.page_id === params[0])).map(project)
        return { rows, rowCount: rows.length }
      }
      // 「未归组列表」的两种写法都要认：带 page_id is null 的，和只按 status 过滤的。
      // 后者是变异测试刻意制造的坏实现——mock 必须**照常响应**，让断言去判红；
      // 若这里直接抛「未预期 SQL」，测试变成崩溃而不是 FAIL，就分不清
      // 「实现被改坏了」与「mock 不认识这条 SQL」。
      if (/where\s+c\.page_id\s+is\s+null/i.test(text) || /where\s+c\.status\s*=\s*'registered'/i.test(text)) {
        // 只有 SQL 真的写了 `status = 'registered'` 才过滤，否则不替实现补条件
        // （这是 M4 兜底的同模式：补了就等于由 mock 保证「只返回已登记」，
        //   实现漏写该条件也测不出来）。
        const requiresRegistered = /(?:c\.)?status\s*=\s*'registered'/i.test(text)
        // 同理：只有 SQL 真的写了 `page_id is null` 才按未归组过滤
        const requiresUngrouped = /c\.page_id\s+is\s+null/i.test(text)
        const limit = Number(params[0])
        const rows = sortByCreatedAt(
          all.filter(
            (row) =>
              (!requiresUngrouped || row.page_id === null) &&
              (!requiresRegistered || row.status === 'registered'),
          ),
        )
          .slice(0, Number.isInteger(limit) && limit > 0 ? limit : all.length)
          .map(project)
        return { rows, rowCount: rows.length }
      }
      if (/where\s+c\.id\s*=\s*\$1/i.test(text)) {
        const row = all.find((candidate) => candidate.id === params[0])
        return row === undefined ? { rows: [], rowCount: 0 } : { rows: [project(row)], rowCount: 1 }
      }
    }

    throw new Error(`grouping-pool：收到未预期的 SQL → ${text.replace(/\s+/g, ' ').slice(0, 160)}`)
  }

  const pool = {
    /** 已提交的数据，供断言直接看 */
    get captures() {
      return committed.captures
    },
    get documents() {
      return committed.documents
    },
    get pages() {
      return committed.pages
    },
    statements,
    /** 未显式收尾就归还连接的事务数（实现漏 COMMIT/ROLLBACK 时为非 0） */
    get leakedTransactions() {
      return leakedTransactions
    },
    get leakedDetail() {
      return leakedDetail
    },
    /** 借出后未归还的连接数（终态应为 0） */
    get openConnections() {
      return openConnections
    },

    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      statements.push(normalized)
      return queryOutsideTransaction(normalized, params)
    },

    async connect() {
      openConnections += 1
      const tx = createTransaction()
      const heldLocks = []
      let released = false

      return {
        async query(sql, params = []) {
          const normalized = String(sql).replace(/\s+/g, ' ').trim()
          statements.push(normalized)
          lastStatement = normalized

          if (/^begin$/i.test(normalized)) return { rows: [], rowCount: null }
          if (/^commit$/i.test(normalized)) {
            for (const page of tx.view('pages').values()) {
              if (tx.overlay.pages.has(page.id)) validatePage(page, tx)
            }
            tx.commit()
            return { rows: [], rowCount: null }
          }
          if (/^rollback$/i.test(normalized)) {
            tx.rollback()
            return { rows: [], rowCount: null }
          }

          // FOR UPDATE：对目标行取锁，让并发事务串行化
          const lockMatch = normalized.match(
            /select\s+id[,\s\w]*from\s+app\.(captures|pages)\s+where\s+id\s*=\s*\$1\s+for\s+update/i,
          )
          if (lockMatch !== null) {
            const release = await acquireLock(`${lockMatch[1]}:${params[0]}`)
            heldLocks.push(release)
          }

          return queryInTransaction(tx, normalized, params)
        },
        release() {
          if (released) return
          released = true
          // 事务没被显式收尾就归还连接 = 实现漏了 COMMIT 或 ROLLBACK。
          // 必须在这里显式记一笔：真实 PostgreSQL 下这会留下一个处于中止状态
          // 的事务，被下一个复用该连接的人 COMMIT 时孤儿数据照样落库。
          // 光靠「overlay 被丢弃」是测不出来的——那只是 mock 的实现细节。
          if (!tx.finished) {
            leakedTransactions += 1
            leakedDetail.push(lastStatement ?? '(unknown)')
          }
          openConnections -= 1
          for (const release of heldLocks) release()
          heldLocks.length = 0
        },
      }
    },
  }

  return pool
}
