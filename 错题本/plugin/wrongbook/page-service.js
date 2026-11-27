// 错题本插件 · Page 归组业务服务（DESIGN §8.2 / §10.3 / §11.2 / §15 第 6 步）
//
// 本步是**纯人工归组**：真实 9 张样本已证伪九种视觉指纹方法（见
// .plan-grouping-v2.md §1），所以这里既不计算指纹、也不产生任何相似度 / 距离 /
// 强度语义。归组只由用户的两个显式动作驱动：
//   · 「不同页，创建新页面」      → createPage
//   · 「同一页，添加为另一张照片」 → attachCapture
// 更换封面（setPreferredCapture）只改 pages.preferred_capture_id。
//
// 三条硬约束在本文件里的落点：
//  1. 原件不可变：这里只写元数据（documents / pages / captures.page_id），
//     没有任何文件操作；失败回滚也只撤销元数据，不删行、不删文件。
//  2. Page 只能是 pending：organized 要求首选 Capture 有 ready 的 standardized
//     image_asset（trig_pages_status_transition），而标准化图属于第 7 步。
//     因此本文件**不写 status 列、不 UPDATE status**，新建页只显式写 'pending'。
//  3. 首选 Capture 必须属于本页：应用层先查一次（好给出 409 语义），
//     数据库侧还有复合外键 (preferred_capture_id, id) → captures(id, page_id) 兜底。
//
// 为什么错误类型要继承 ImportError：路由层的 sendFailure() 只认识 ImportError
// 与 ArchiveError 两种，继承之后 PageError 自动带上自己的 status / code /
// retryable，index.js 的既有错误处理一行都不用改（也就不会退化成 500）。

import { ImportError } from './import-service.js'

/**
 * Page 归组的错误码 → HTTP 状态码 + 可重试性。
 *
 * 单独一张表，不去改 import-service 的 ERROR_TABLE：那边是导入语义的错误码，
 * 混在一起会让「某个错误码属于哪一步」失去边界，也会让 importError() 变成
 * 跨模块的公共注册表。
 */
const PAGE_ERROR_TABLE = {
  INVALID_BODY: { status: 400, retryable: false },
  INVALID_UUID: { status: 400, retryable: false },
  PAGE_NOT_FOUND: { status: 404, retryable: false },
  CAPTURE_NOT_FOUND: { status: 404, retryable: false },
  CAPTURE_NOT_GROUPABLE: { status: 409, retryable: false },
  CAPTURE_ALREADY_GROUPED: { status: 409, retryable: false },
  PREFERRED_CAPTURE_NOT_IN_PAGE: { status: 409, retryable: false },
  CLASSIFICATION_UNRESOLVED: { status: 422, retryable: false },
}

/**
 * 归组失败的错误。
 *
 * extra 携带 UI 需要的上下文（例如「这张照片已在某个 Page 里」时的 pageId），
 * 让前端能直接跳到当前归属，而不用再发一次查询。
 */
export class PageError extends ImportError {
  /**
   * @param {string} code 业务错误码（见 PAGE_ERROR_TABLE）
   * @param {string} message 面向用户的中文说明（不得含绝对路径、SQL、stack）
   * @param {boolean} [retryable] 是否可原样重试；缺省按错误码表
   * @param {number} [status] HTTP 状态码；缺省按错误码表
   * @param {object} [extra] 附加给 UI 的上下文（如 { pageId }）
   */
  constructor(code, message, retryable, status, extra = {}) {
    const entry = PAGE_ERROR_TABLE[code]
    super(
      code,
      message,
      retryable === undefined ? (entry?.retryable ?? false) : retryable,
      status === undefined ? (entry?.status ?? 500) : status,
    )
    this.name = 'PageError'
    this.extra = extra ?? {}
  }
}

/** 规范 UUID 文本形式（8-4-4-4-12）。数据库里存的就是这个形式，大小写不敏感。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/**
 * 校验并返回一个 UUID 参数。
 *
 * 为什么要先校验再进 SQL：非法 UUID 交给 PostgreSQL 会抛 22P02，那是驱动层
 * 错误，只能落到 500 INTERNAL_ERROR —— 而真实原因是「调用方参数写错了」，
 * 应当是 400。提前拦住，错误语义才准确。
 *
 * @param {unknown} value 待校验的值
 * @param {string} field 字段名（只用于拼面向用户的文案）
 * @returns {string} 校验通过的 UUID 文本
 */
function requireUuid(value, field) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new PageError('INVALID_UUID', `${field} 必须是合法的 UUID`)
  }
  return value.toLowerCase()
}

/**
 * 把 limit 夹到 1..200。
 *
 * 非整数或小于 1 时退回默认值（而不是夹成 1）：调用方少传一个 `limit=0`
 * 更可能是参数缺失，返回 1 条会让人误以为库里的数据只有一条。
 *
 * @param {unknown} value 原始 limit
 * @returns {number} 可用 limit
 */
function clampLimit(value) {
  const numeric = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isInteger(numeric) || numeric < 1) return DEFAULT_LIMIT
  return Math.min(numeric, MAX_LIMIT)
}

/**
 * 转义 LIKE / ILIKE 的通配符。
 *
 * `%` `_` 是通配符，`\` 是默认转义符本身；用户搜索 `50%` 时如果不转义，
 * `%` 会变成「任意字符」，搜索结果就与输入无关了。三者在 SQL 里都靠
 * `escape '\'` 声明的转义符生效，所以必须先转义反斜杠本身。
 *
 * @param {string} value 用户输入
 * @returns {string} 可安全嵌入 LIKE 模式的文本
 */
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

/** 时间戳统一成 ISO 字符串（pg 会把 timestamptz 读成 Date）。 */
function toIso(value) {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

/**
 * Page 归组服务。
 *
 * 与 ImportService 的分工：ImportService 负责「一次拍摄 → 一条 Capture + 一个
 * 原件」，这里负责「Capture → Page」的关系与展示。captureSelect 与
 * presentCapture 直接复用它的实例成员，不复制第二份 —— 图库与归组页看到的
 * Capture 形状必须完全一致，否则前端要写两套渲染分支。
 */
export class PageService {
  /**
   * @param {{ pool: import('pg').Pool, schema: string, importService: import('./import-service.js').ImportService, log?: any }} options
   */
  constructor({ pool, schema, importService, log }) {
    this.pool = pool
    this.schema = schema
    this.importService = importService
    this.log = log
  }

  // ---- 读 ---------------------------------------------------------------

  /**
   * Page 列表：一页一卡（不是一 Capture 一卡）。
   *
   * 聚合在 SQL 侧做（count / max），封面另取一次：封面的形状必须与图库里的
   * Capture 完全一致（带科目学期显示名），那需要 captureSelect 的 join，
   * 塞进同一条聚合查询会让 GROUP BY 迅速失控。
   *
   * @param {{ limit?: number, subjectCode?: string, termCode?: string, q?: string }} [options] 筛选
   * @returns {Promise<{items: object[]}>} PageCard 列表
   */
  async listPages({ limit = DEFAULT_LIMIT, subjectCode, termCode, q } = {}) {
    const safeLimit = clampLimit(limit)
    const conditions = []
    const params = []

    if (typeof subjectCode === 'string' && subjectCode !== '') {
      params.push(subjectCode)
      conditions.push(`s.code = $${params.length}`)
    }
    if (typeof termCode === 'string' && termCode !== '') {
      params.push(termCode)
      conditions.push(`t.code = $${params.length}`)
    }
    // 搜索范围：资料标题 + 页内任一 Capture 的原文件名。
    // 用 EXISTS 而不是 join captures 再过滤 —— join 后过滤会把 captureCount 一起
    // 改小，页面上就会显示「本页 1 张」但实际 3 张。
    const keyword = typeof q === 'string' ? q.trim() : ''
    if (keyword !== '') {
      params.push(`%${escapeLike(keyword)}%`)
      const placeholder = `$${params.length}`
      conditions.push(`(
        d.title ilike ${placeholder} escape '\\'
        or exists (
          select 1
            from ${this.schema}.captures fc
           where fc.page_id = p.id
             and fc.original_filename ilike ${placeholder} escape '\\'
        )
      )`)
    }

    params.push(safeLimit)
    const whereSql = conditions.length === 0 ? '' : `where ${conditions.join('\n       and ')}`

    const sql = `
      select p.id,
             p.document_id,
             p.page_number,
             p.status,
             p.created_at,
             p.preferred_capture_id,
             d.title as document_title,
             s.code  as subject_code,
             s.display_name as subject_display_name,
             t.code  as term_code,
             t.display_name as term_display_name,
             count(c.id)::int as capture_count,
             max(c.created_at) as latest_capture_at
        from ${this.schema}.pages p
        join ${this.schema}.documents d on d.id = p.document_id
        left join ${this.schema}.subjects s on s.id = d.subject_id
        left join ${this.schema}.terms    t on t.id = d.term_id
        left join ${this.schema}.captures c on c.page_id = p.id
       ${whereSql}
       group by p.id, d.title, s.code, s.display_name, t.code, t.display_name
       -- 稳定排序：最近有拍摄的页在前；没有任何 Capture 的页排最后，靠 p.id 定序
       order by max(c.created_at) desc nulls last, p.id
       limit $${params.length}`

    try {
      const result = await this.pool.query(sql, params)
      const rows = result.rows
      const capturesByPage = await this.fetchCaptureRowsByPage(
        this.pool,
        rows.map((row) => row.id),
      )
      const items = rows.map((row) => {
        const captures = capturesByPage.get(row.id) ?? []
        const preferred = row.preferred_capture_id === null
          ? null
          : captures.find((capture) => capture.id === row.preferred_capture_id) ?? null
        // 首选为 NULL 时用页内最早的一张作临时封面，但**不写库**：
        // 让「显示哪张」和「用户选了哪张」保持两件事，避免一次浏览就改数据。
        const cover = preferred ?? captures[0] ?? null
        return this.presentPage(row, cover, Number(row.capture_count ?? captures.length))
      })
      return { items }
    } catch (error) {
      throw this.translateDatabaseError(error, '查询 Page 列表')
    }
  }

  /**
   * 单页详情：Page 卡 + 首选 id + 页内全部 Capture（按拍摄先后升序）。
   *
   * @param {string} pageId pages.id
   * @returns {Promise<{page: object, preferredCaptureId: string|null, captures: object[]}>} 详情
   */
  async getPage(pageId) {
    const id = requireUuid(pageId, 'page_id')
    try {
      const row = await this.fetchPageRow(this.pool, id)
      if (row === null) throw new PageError('PAGE_NOT_FOUND', '页面不存在或已被删除')

      const captureRows = await this.fetchPageCaptureRows(this.pool, id)
      const preferred = row.preferred_capture_id === null
        ? null
        : captureRows.find((capture) => capture.id === row.preferred_capture_id) ?? null
      const cover = preferred ?? captureRows[0] ?? null

      return {
        page: this.presentPage(row, cover, captureRows.length),
        preferredCaptureId: row.preferred_capture_id ?? null,
        captures: captureRows.map((capture) => this.importService.presentCapture(capture)),
      }
    } catch (error) {
      throw this.translateDatabaseError(error, '查询页面详情')
    }
  }

  /**
   * 待整理 Capture：已登记但还没有 Page 的那些。
   *
   * 只取 registered：reserved / copied 是导入中断后的中间态，它们连元数据都不完整，
   * 放进「待整理」会让用户点进一个必然失败的归组动作。
   *
   * @param {{ limit?: number }} [options] 条数上限
   * @returns {Promise<{items: object[]}>} Capture 列表
   */
  async listUngroupedCaptures({ limit = DEFAULT_LIMIT } = {}) {
    const safeLimit = clampLimit(limit)
    try {
      const result = await this.pool.query(
        `${this.importService.captureSelect}
          where c.page_id is null
            and c.status = 'registered'
          order by c.created_at desc, c.id desc
          limit $1`,
        [safeLimit],
      )
      return { items: result.rows.map((row) => this.importService.presentCapture(row)) }
    } catch (error) {
      throw this.translateDatabaseError(error, '查询待整理照片')
    }
  }

  // ---- 写（全部单事务） --------------------------------------------------

  /**
   * 「不同页，创建新页面」：为一张待整理 Capture 建 Document + pending Page。
   *
   * 为什么每次新建一个独立 Document：第一轮不追求复杂组装规则（DESIGN §8.1），
   * 一个 Page 一个 Document 让分类（科目+学期）落在 Document 层，后续要合并成
   * 「一张试卷多页」时只需改 document_id，不必搬动任何原件。
   *
   * 分类从 original_path 前两段反查字典，UI 不传：路径是导入时按字典
   * directory_name 生成的唯一真源，让 UI 再传一次就等于允许两处不一致。
   *
   * @param {{ captureId: string }} input 目标 Capture
   * @returns {Promise<{outcome: string, page: object, capture: object}>} 结果
   */
  async createPage({ captureId } = {}) {
    const id = requireUuid(captureId, 'capture_id')

    const pageId = await this.withTransaction(async (client) => {
      // 先锁 Capture：并发的两次「创建新页面」只有一方能通过 page_id IS NULL 校验，
      // 另一方拿到的是已归组的确定结果，而不是两个 Page 各挂一张照片。
      const captureResult = await client.query(
        `select id, page_id, status, original_path
           from ${this.schema}.captures
          where id = $1
          for update`,
        [id],
      )
      if (captureResult.rowCount === 0) {
        throw new PageError('CAPTURE_NOT_FOUND', '照片不存在或已被删除')
      }
      const capture = captureResult.rows[0]
      if (capture.status !== 'registered') {
        throw new PageError('CAPTURE_NOT_GROUPABLE', '这张照片尚未完成归档，暂时不能归组')
      }
      if (capture.page_id !== null) {
        throw new PageError('CAPTURE_ALREADY_GROUPED', '这张照片已经归入某个页面', false, 409, {
          pageId: capture.page_id,
        })
      }

      const segments = String(capture.original_path ?? '').split('/')
      const subjectDirectory = segments[0] ?? ''
      const termDirectory = segments[1] ?? ''
      const classification = await client.query(
        // subjects 加 enabled 条件：与 ImportService.lookupSubject 同口径，
        // 「停用即不再接收新归档」。terms 表没有 enabled 列（schema 已核实），
        // 所以学期这一支只能按 directory_name 匹配。
        `select (select id from ${this.schema}.subjects where directory_name = $1 and enabled) as subject_id,
                (select id from ${this.schema}.terms    where directory_name = $2) as term_id`,
        [subjectDirectory, termDirectory],
      )
      const { subject_id: subjectId, term_id: termId } = classification.rows[0]
      if (subjectId === null || termId === null) {
        // 字典被改名、删除或停用后旧路径会落到这里。这不是数据损坏（原件与 Capture 都还在），
        // 所以用 422 让用户先修分类，而不是 500。
        throw new PageError('CLASSIFICATION_UNRESOLVED', '无法从归档路径确定科目或学期，请先修正分类')
      }

      const documentResult = await client.query(
        `insert into ${this.schema}.documents (subject_id, term_id, source_type)
         values ($1, $2, 'other')
         returning id`,
        [subjectId, termId],
      )
      const documentId = documentResult.rows[0].id

      // status 显式写 'pending'：本步不可能 organized（缺 standardized asset），
      // 也不能依赖列默认值去表达「这一页还没整理完」这个业务事实。
      const pageResult = await client.query(
        `insert into ${this.schema}.pages (document_id, status)
         values ($1, 'pending')
         returning id`,
        [documentId],
      )
      const newPageId = pageResult.rows[0].id

      // and page_id is null 是并发防线：锁住 Capture 之后仍保留这个条件，
      // 任何「读到的行与写入时不一致」都退化成 0 行更新，而不是静默改挂。
      const linked = await client.query(
        `update ${this.schema}.captures
            set page_id = $1
          where id = $2
            and page_id is null`,
        [newPageId, id],
      )
      if (linked.rowCount === 0) {
        throw new PageError('CAPTURE_ALREADY_GROUPED', '这张照片已经归入某个页面')
      }

      // 单 Capture 的页直接把这张设为首选：页面立刻有封面，且不需要用户多点一次。
      // 复合外键要求首选 Capture 的 page_id 等于本页 id —— 上一条 update 已经满足。
      await client.query(
        `update ${this.schema}.pages
            set preferred_capture_id = $1
          where id = $2`,
        [id, newPageId],
      )

      return newPageId
    })

    // 回读放在事务外：事务只负责把关系写成自洽状态，返回给 UI 的形状走与列表
    // 完全相同的读路径，避免「写的时候拼一份、读的时候又拼一份」。
    try {
      const pageRow = await this.fetchPageRow(this.pool, pageId)
      // 刚提交的页在回读前被别人删掉（本步没有删除入口，但别假设永远不会出现）
      if (pageRow === null) throw new PageError('PAGE_NOT_FOUND', '页面不存在或已被删除')
      const captureRow = await this.fetchCaptureRow(this.pool, id)
      // captureCount 取回读值而不是写死 1：回读是唯一真源，写死会在
      // 未来加入「一次建页挂多张」时静默显示错数字
      const card = this.presentPage(pageRow, captureRow, Number(pageRow.capture_count ?? 1))
      return {
        outcome: 'created',
        page: card,
        capture: captureRow === null ? null : this.importService.presentCapture(captureRow),
      }
    } catch (error) {
      throw this.translateDatabaseError(error, '回读新建页面')
    }
  }

  /**
   * 「同一页，添加为另一张照片」。
   *
   * 只改 captures.page_id。首张自动成为首选（否则页面上没有封面），
   * 已有首选时**不动**它 —— 加一张照片不应该悄悄换掉用户选过的封面。
   *
   * @param {{ pageId: string, captureId: string }} input 目标页与照片
   * @returns {Promise<{outcome: string, pageId: string, capture: object|null}>} 结果
   */
  async attachCapture({ pageId, captureId } = {}) {
    const targetPageId = requireUuid(pageId, 'page_id')
    const targetCaptureId = requireUuid(captureId, 'capture_id')

    await this.withTransaction(async (client) => {
      // 与 createPage 相同的加锁顺序（先 Capture 再 Page）：两处顺序一致才不会
      // 在「同时归组同一张照片」时互相等成死锁。
      const captureResult = await client.query(
        `select id, page_id, status
           from ${this.schema}.captures
          where id = $1
          for update`,
        [targetCaptureId],
      )
      if (captureResult.rowCount === 0) {
        throw new PageError('CAPTURE_NOT_FOUND', '照片不存在或已被删除')
      }
      const capture = captureResult.rows[0]
      if (capture.status !== 'registered') {
        throw new PageError('CAPTURE_NOT_GROUPABLE', '这张照片尚未完成归档，暂时不能归组')
      }
      if (capture.page_id !== null) {
        throw new PageError('CAPTURE_ALREADY_GROUPED', '这张照片已经归入某个页面', false, 409, {
          pageId: capture.page_id,
        })
      }

      const pageResult = await client.query(
        `select id, preferred_capture_id
           from ${this.schema}.pages
          where id = $1
          for update`,
        [targetPageId],
      )
      if (pageResult.rowCount === 0) {
        throw new PageError('PAGE_NOT_FOUND', '页面不存在或已被删除')
      }

      const linked = await client.query(
        `update ${this.schema}.captures
            set page_id = $2
          where id = $1
            and page_id is null`,
        [targetCaptureId, targetPageId],
      )
      if (linked.rowCount === 0) {
        throw new PageError('CAPTURE_ALREADY_GROUPED', '这张照片已经归入某个页面')
      }

      if (pageResult.rows[0].preferred_capture_id === null) {
        await client.query(
          `update ${this.schema}.pages
              set preferred_capture_id = $1
            where id = $2`,
          [targetCaptureId, targetPageId],
        )
      }
    })

    try {
      const captureRow = await this.fetchCaptureRow(this.pool, targetCaptureId)
      return {
        outcome: 'attached',
        pageId: targetPageId,
        capture: captureRow === null ? null : this.importService.presentCapture(captureRow),
      }
    } catch (error) {
      throw this.translateDatabaseError(error, '回读归组结果')
    }
  }

  /**
   * 更换首选 Capture（页封面）。
   *
   * 只写 pages.preferred_capture_id 一列：不 DELETE 任何 captures 行、不碰文件、
   * 不改 status。其他照片仍然属于本页，随时可以再切回来。
   *
   * @param {{ pageId: string, captureId: string }} input 目标页与照片
   * @returns {Promise<{pageId: string, preferredCaptureId: string}>} 结果
   */
  async setPreferredCapture({ pageId, captureId } = {}) {
    const targetPageId = requireUuid(pageId, 'page_id')
    const targetCaptureId = requireUuid(captureId, 'capture_id')

    await this.withTransaction(async (client) => {
      const pageResult = await client.query(
        `select id
           from ${this.schema}.pages
          where id = $1
          for update`,
        [targetPageId],
      )
      if (pageResult.rowCount === 0) {
        throw new PageError('PAGE_NOT_FOUND', '页面不存在或已被删除')
      }

      // 归属校验放在应用层：复合外键只会抛 23503（→500），而这里能给出
      // 「这张照片不属于本页」这个用户看得懂的 409。
      const captureResult = await client.query(
        `select id
           from ${this.schema}.captures
          where id = $1
            and page_id = $2`,
        [targetCaptureId, targetPageId],
      )
      if (captureResult.rowCount === 0) {
        throw new PageError('PREFERRED_CAPTURE_NOT_IN_PAGE', '这张照片不属于本页面，不能设为首选')
      }

      await client.query(
        `update ${this.schema}.pages
            set preferred_capture_id = $1
          where id = $2`,
        [targetCaptureId, targetPageId],
      )
    })

    return { pageId: targetPageId, preferredCaptureId: targetCaptureId }
  }

  // ---- 呈现 -------------------------------------------------------------

  /**
   * 把 Page 行整理成 UI 形状（PageCard）。
   *
   * 刻意没有 score / distance / similarity / strength 之类的字段：本步没有
   * 相似度语义（九种方法已证伪），任何数值都会制造虚假的精确感并诱导排序。
   *
   * @param {any} row pages 行（含 document / subject / term 的 join 列与聚合列）
   * @param {any} preferredCaptureRow 用于展示的封面 Capture 行（首选，或回退到最早一张）
   * @param {number} captureCount 本页 Capture 数
   * @returns {object} PageCard
   */
  presentPage(row, preferredCaptureRow, captureCount) {
    const preferredId = row.preferred_capture_id ?? null
    const displayRow = preferredCaptureRow ?? null
    // 只有「库里记的首选」与「实际拿来展示的那张」是同一张，才算 preferred；
    // 否则就是临时封面。前端据此决定是否显示「未选封面」的提示。
    const displayCaptureSource = displayRow === null
      ? 'none'
      : preferredId !== null && displayRow.id === preferredId
        ? 'preferred'
        : 'fallback'

    const count = Number.isInteger(captureCount)
      ? captureCount
      : Number(row.capture_count ?? 0)

    return {
      page: {
        id: row.id,
        documentId: row.document_id,
        pageNumber: row.page_number ?? null,
        status: row.status,
        createdAt: toIso(row.created_at),
      },
      subject: row.subject_code
        ? { code: row.subject_code, displayName: row.subject_display_name }
        : null,
      term: row.term_code
        ? { code: row.term_code, displayName: row.term_display_name }
        : null,
      preferredCapture: displayRow === null ? null : this.importService.presentCapture(displayRow),
      displayCaptureSource,
      captureCount: count,
      latestCaptureAt: toIso(row.latest_capture_at),
    }
  }

  // ---- 内部工具 ---------------------------------------------------------

  /**
   * 单事务执行器。
   *
   * 用专用连接而不是 pool.query：pool.query 每条语句可能落在不同连接上，
   * 事务语义根本不成立。ROLLBACK 失败时销毁连接（release(true)）——
   * 一条事务状态未知的连接被复用到池里，后续查询会看到别人的未提交数据。
   *
   * @template T
   * @param {(client: import('pg').PoolClient) => Promise<T>} work 事务体
   * @returns {Promise<T>} work 的返回值
   */
  async withTransaction(work) {
    const client = await this.pool.connect()
    let discard = false
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackError) {
        discard = true
        this.log?.warn('归组事务回滚失败，丢弃该连接：%s', rollbackError.message)
      }
      throw this.translateDatabaseError(error, '归组事务')
    } finally {
      client.release(discard ? true : undefined)
    }
  }

  /**
   * 单页的聚合行（PageCard 的数据来源）。
   *
   * @param {import('pg').Pool | import('pg').PoolClient} queryable 执行者
   * @param {string} pageId pages.id
   * @returns {Promise<any|null>} 行，不存在时 null
   */
  async fetchPageRow(queryable, pageId) {
    const result = await queryable.query(
      `select p.id,
              p.document_id,
              p.page_number,
              p.status,
              p.created_at,
              p.preferred_capture_id,
              d.title as document_title,
              s.code  as subject_code,
              s.display_name as subject_display_name,
              t.code  as term_code,
              t.display_name as term_display_name,
              (select count(*)::int from ${this.schema}.captures pc where pc.page_id = p.id) as capture_count,
              (select max(pc.created_at) from ${this.schema}.captures pc where pc.page_id = p.id) as latest_capture_at
         from ${this.schema}.pages p
         join ${this.schema}.documents d on d.id = p.document_id
         left join ${this.schema}.subjects s on s.id = d.subject_id
         left join ${this.schema}.terms    t on t.id = d.term_id
        where p.id = $1`,
      [pageId],
    )
    return result.rowCount === 0 ? null : result.rows[0]
  }

  /**
   * 页内全部 Capture，按拍摄先后升序（第一张 = 该页最早的一张）。
   *
   * @param {import('pg').Pool | import('pg').PoolClient} queryable 执行者
   * @param {string} pageId pages.id
   * @returns {Promise<any[]>} captureSelect 行
   */
  async fetchPageCaptureRows(queryable, pageId) {
    const result = await queryable.query(
      `${this.importService.captureSelect}
        where c.page_id = $1
        order by c.created_at asc, c.id asc`,
      [pageId],
    )
    return result.rows
  }

  /**
   * 批量取多页的 Capture，按 page_id 分组。
   *
   * 一次查询取完，避免列表页 N+1 次往返；`any($1::uuid[])` 是参数化数组，
   * 页数再多也只有一个占位符。
   *
   * @param {import('pg').Pool | import('pg').PoolClient} queryable 执行者
   * @param {string[]} pageIds pages.id 列表
   * @returns {Promise<Map<string, any[]>>} page_id → Capture 行（升序）
   */
  async fetchCaptureRowsByPage(queryable, pageIds) {
    const grouped = new Map()
    if (pageIds.length === 0) return grouped
    const result = await queryable.query(
      `${this.importService.captureSelect}
        where c.page_id = any($1::uuid[])
        order by c.created_at asc, c.id asc`,
      [pageIds],
    )
    for (const row of result.rows) {
      const bucket = grouped.get(row.page_id)
      if (bucket === undefined) grouped.set(row.page_id, [row])
      else bucket.push(row)
    }
    return grouped
  }

  /**
   * 按 id 取一条 Capture（captureSelect 形状）。
   *
   * @param {import('pg').Pool | import('pg').PoolClient} queryable 执行者
   * @param {string} captureId captures.id
   * @returns {Promise<any|null>} 行，不存在时 null
   */
  async fetchCaptureRow(queryable, captureId) {
    const result = await queryable.query(
      `${this.importService.captureSelect} where c.id = $1`,
      [captureId],
    )
    return result.rowCount === 0 ? null : result.rows[0]
  }

  /**
   * 复用 ImportService 的错误翻译，只做一处语义纠正。
   *
   * 连接类失败（→ DATABASE_UNAVAILABLE 503）与「非业务错误原样返回」的口径
   * 两边完全一致，没必要抄一份 SQLSTATE 集合。唯一不同的是 23514（CHECK 违约）：
   * ImportService 把它译成 INVALID_FILENAME（导入语义），归组里没有文件名这回事，
   * 继续沿用会给出误导文案，这里换成通用的参数错误。
   *
   * @param {any} error 捕获到的错误
   * @param {string} stage 出错阶段（只进日志）
   * @returns {Error} 可直接抛出的错误
   */
  translateDatabaseError(error, stage) {
    const translated = this.importService.translateDatabaseError(error, stage)
    if (translated instanceof ImportError && translated.code === 'INVALID_FILENAME') {
      return new PageError('INVALID_BODY', '请求数据未通过数据库完整性检查')
    }
    return translated
  }
}
