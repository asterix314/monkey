// 错题本插件 · 导入业务服务（DESIGN §10 导入契约 / §11.1 文件级去重）
//
// 这一层是「单文件导入纵切面」的核心，负责把一次 HTTP 上传变成一条可恢复的
// captures 记录 + 一个归档原件。它同时持有数据库与文件系统两侧的知识，
// 所以放到这里，而不是让 index.js 的路由去拼逻辑（DESIGN §5.2 第 5 条）。
//
// 严格执行 DESIGN §10.2 的固定步骤顺序：
//  1. 校验 subject_code / term_code（查字典，取 directory_name）
//  2. 建 staging 文件
//  3. 边收边算 sha256 + 写 staging
//  4. close/sync staging
//  5. ON CONFLICT 预留
//  6. 无 RETURNING → 查既有行按 status 分支
//  7. 预留成功者才复制（唯一临时名 + rename 原子发布）
//  8. 复算最终文件 sha256 与预留摘要比对
//  9. identify 读 media_type / width / height
// 10. UPDATE → copied
// 11. UPDATE → registered
//
// 批量导入（DESIGN §15 第 5 步）在这里只体现为 importBatch：一个**串行**的
// 逐文件循环，不新增任何上传协议、不新增数据库对象。为什么串行、为什么不走
// multipart，见 importBatch 方法头的说明。
// 批量级联失败（整批连一个文件都没机会开始，例如科目代码非法）用
// ImportBatchError 表达，与「某个文件自己失败」严格区分：后者是每条 item 的
// outcome='failed'，绝不抛错、绝不中断后面的文件。
//
// 关于「扩展名从哪来」的一处必须写清楚的实现说明：
//  存储文件名要求用 identify 确认的小写扩展名（文件名规则），而预留时又要求
//  预留时就把相对路径写好（$2 是先生成的碰撞安全相对路径）。两者只有在
//  staging 阶段先探测一次才能同时成立。因此这里对 staging 探测一次拿扩展名，
//  第 9 步再对**已归档文件**探测一次拿 media_type/宽高 —— 后者顺带验证了
//  落盘副本仍然可解码。两次探测必须是同一格式，否则视为探测失败。

import { ArchiveError, ArchiveStore, buildRelativePath, buildStorageName } from './archive-store.js'
import { ImageProbeError, probeImage } from './image-probe.js'

/** 导入失败的错误（带业务错误码 + 是否可重试）。 */
export class ImportError extends Error {
  /**
   * @param {string} code 业务错误码
   * @param {string} message 面向用户的中文说明（不得含绝对路径、SQL、stack）
   * @param {boolean} retryable 调用方是否可以原样重试
   * @param {number} status HTTP 状态码
   */
  constructor(code, message, retryable, status) {
    super(message)
    this.name = 'ImportError'
    this.code = code
    this.retryable = retryable
    this.status = status
  }
}

/**
 * 批量导入的**整批**失败（不是某一个文件失败）。
 *
 * 什么时候才用：整批还没开始处理文件就已经不可能成功，例如
 *   · 科目 / 学期代码非法（所有文件都会撞同一个错，逐个报 N 遍没有意义）；
 *   · 文件列表为空。
 *
 * 什么**不**用：某个文件读流失败、格式不支持、哈希冲突、DB 报错 —— 那些是
 * 这一条的 outcome='failed'，importBatch 照常收集结果并继续下一个文件
 * （DESIGN §5.2 第 6 条 / §14.4-19：一个失败不得影响其他文件，更不得破坏已归档原件）。
 *
 * 它继承 ImportError，是为了让路由层只需要认识一种错误类型：
 * sendFailure() 对 ImportError 的处理（status / retryable / code / message）
 * 原样适用于整批失败，不会退化成 INTERNAL_ERROR。
 */
export class ImportBatchError extends ImportError {
  /**
   * @param {string} code 业务错误码（见 ERROR_TABLE）
   * @param {string} message 面向用户的中文说明
   * @param {boolean} retryable 整批是否可以原样重试
   * @param {number} status HTTP 状态码
   * @param {object[]} [items] 已完成的条目（整批失败时通常是空数组）
   */
  constructor(code, message, retryable, status, items = []) {
    super(code, message, retryable, status)
    this.name = 'ImportBatchError'
    /** 已处理完的条目：整批失败也可能是在第 N 个文件前才发现问题 */
    this.items = items
  }
}

/**
 * 业务错误码 → HTTP 状态码 + 可重试性。
 *
 * 单一真源：路由层不重复判断，避免两处不一致。
 */
const ERROR_TABLE = {
  UNAUTHENTICATED: { status: 401, retryable: false },
  FORBIDDEN_ORIGIN: { status: 403, retryable: false },
  INVALID_SUBJECT_CODE: { status: 400, retryable: false },
  INVALID_TERM_CODE: { status: 400, retryable: false },
  INVALID_FILENAME: { status: 400, retryable: false },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, retryable: false },
  EMPTY_UPLOAD: { status: 400, retryable: false },
  PAYLOAD_TOO_LARGE: { status: 413, retryable: false },
  UPLOAD_ABORTED: { status: 400, retryable: true },
  STAGING_WRITE_FAILED: { status: 500, retryable: true },
  ARCHIVE_COPY_FAILED: { status: 500, retryable: true },
  HASH_MISMATCH: { status: 500, retryable: false },
  IMAGE_PROBE_FAILED: { status: 422, retryable: false },
  DATABASE_UNAVAILABLE: { status: 503, retryable: true },
  CAPTURE_RECOVERY_REQUIRED: { status: 409, retryable: true },
  NOT_FOUND: { status: 404, retryable: false },
  // 批量入口自身的参数错误（不是某个文件的错误）。整批连一个文件都无法开始才用它；
  // 单个文件失败永远走 item 结果，不占这个错误码。
  INVALID_BATCH: { status: 400, retryable: false },
}

/**
 * 按错误码构造 ImportError。
 *
 * @param {string} code 业务错误码
 * @param {string} message 面向用户的说明
 * @returns {ImportError} 带 status / retryable 的错误
 */
export function importError(code, message) {
  const entry = ERROR_TABLE[code]
  if (entry === undefined) {
    // 内部错误码拼错时宁可归为 500，也不要抛 TypeError 掩盖真实原因
    return new ImportError('DATABASE_UNAVAILABLE', message, true, 503)
  }
  return new ImportError(code, message, entry.retryable, entry.status)
}

/** 原文件名长度上限：Windows 单段文件名 255 字符，留出余量。 */
const MAX_FILENAME_LENGTH = 255

/** 控制字符（含换行、制表符、NUL）。 */
const FILENAME_CONTROL = /[\u0000-\u001f\u007f]/

/**
 * 校验客户端给的原文件名（INVALID_FILENAME）。
 *
 * 只做「能不能安全地当一个文件名元数据」的判断，不做任何清洗改写 ——
 * 改写会让「用户看到的原文件名」与「手机上的真实文件名」不一致，
 * 而 original_filename 的唯一用途就是追溯来源。
 *
 * @param {unknown} rawFilename query 参数 filename（已 decodeURIComponent）
 * @returns {string} 通过校验的文件名
 */
export function validateFilename(rawFilename) {
  const invalid = () => importError('INVALID_FILENAME', '文件名不合法（不能为空、不能包含路径分隔符）')
  if (typeof rawFilename !== 'string') throw invalid()
  if (rawFilename === '') throw invalid()
  if (rawFilename !== rawFilename.trim()) throw invalid()
  if (rawFilename === '.' || rawFilename === '..') throw invalid()
  if (rawFilename.includes('/') || rawFilename.includes('\\')) throw invalid()
  if (FILENAME_CONTROL.test(rawFilename)) throw invalid()
  if (rawFilename.length > MAX_FILENAME_LENGTH) throw invalid()
  return rawFilename
}

/** pg 连接类错误的 SQLSTATE 前缀/集合：这些应当映射成 DATABASE_UNAVAILABLE(503)。 */
const CONNECTION_ERROR_CODES = new Set(['08000', '08001', '08003', '08006', '08004', '57P01', '57P02', '57P03'])

/**
 * 驱动层（非 SQLSTATE）的连接失败码。
 *
 * 数据库进程没起来时，pg 根本走不到 SQL 层，抛的是 Node 网络错误：
 *   ECONNREFUSED / ECONNRESET / ENOTFOUND / ETIMEDOUT / EPIPE / EHOSTUNREACH
 * 以及 pg 自己的连接超时 'Connection terminated'（无 code，只有 message）。
 * 不覆盖这些，用户看到的就是 500 INTERNAL_ERROR，而正确答案是 503。
 */
const DRIVER_CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  // pg 在连接超时/池耗尽时使用的内部码
  'CONNECTION_TIMEOUT',
  'CONNECTION_ENDED',
  'POOL_CLOSED',
])

/**
 * 判断一个错误是否是「数据库暂时不可用」。
 *
 * @param {any} error 捕获到的错误
 * @returns {boolean} 是则 true
 */
function isDatabaseUnavailable(error) {
  if (error === null || typeof error !== 'object') return false
  const code = error.code
  if (typeof code === 'string') {
    if (CONNECTION_ERROR_CODES.has(code)) return true
    if (DRIVER_CONNECTION_CODES.has(code)) return true
    // SQLSTATE 三级类 08 = connection exception
    if (code.startsWith('08')) return true
  }
  // pg 的连接类失败常常没有 code，只有 message；精确匹配而不是模糊包含，
  // 避免把业务错误里出现的同样单词误判成连接问题。
  const message = typeof error.message === 'string' ? error.message : ''
  return (
    message === 'Connection terminated' ||
    message.startsWith('Connection terminated') ||
    message.startsWith('timeout exceeded when trying to connect') ||
    message.startsWith('Client has encountered a connection error')
  )
}

/**
 * 导入服务。
 *
 * 持有连接池与归档存储，暴露三个业务方法。所有 SQL 都在这里，UI 与路由都不写 SQL。
 */
export class ImportService {
  /**
   * @param {{ pool: import('pg').Pool, schema: string, originalsRoot: string, uploadMaxBytes: number, identifyTimeoutMs: number, identifyCommand?: string, log?: any }} options
   */
  constructor({ pool, schema, originalsRoot, uploadMaxBytes, identifyTimeoutMs, identifyCommand, log }) {
    this.pool = pool
    this.schema = schema
    this.uploadMaxBytes = uploadMaxBytes
    this.identifyTimeoutMs = identifyTimeoutMs
    this.identifyCommand = identifyCommand
    this.log = log
    this.store = new ArchiveStore({ root: originalsRoot })
    // 模板替换只做一次：schema 已在 config.js 过标识符白名单，拼接不会引入注入面
    this.captureSelect = CAPTURE_SELECT_TEMPLATE.split('{SCHEMA}').join(schema)
  }

  /** 探测参数集中一处构造，避免两处 timeout 不一致。 */
  probeOptions() {
    return { timeoutMs: this.identifyTimeoutMs, command: this.identifyCommand }
  }

  /**
   * 查科目字典，拿 directory_name。
   *
   * 只接受字典里 enabled 的科目：`enabled = false` 的科目等于「不再接收新归档」，
   * 与 UI 下拉框的来源保持一致。
   *
   * @param {string} code subjects.code
   * @returns {Promise<{code: string, directory_name: string}>} 字典行
   */
  async lookupSubject(code) {
    try {
      const result = await this.pool.query(
        `select code, directory_name
            from ${this.schema}.subjects
          where code = $1
            and enabled`,
        [code],
      )
      if (result.rowCount === 0) {
        throw importError('INVALID_SUBJECT_CODE', `未知科目代码：${code}`)
      }
      return result.rows[0]
    } catch (error) {
      throw this.translateDatabaseError(error, '查科目字典')
    }
  }

  /**
   * 查学期字典，拿 directory_name。
   *
   * @param {string} code terms.code
   * @returns {Promise<{code: string, directory_name: string}>} 字典行
   */
  async lookupTerm(code) {
    try {
      const result = await this.pool.query(
        `select code, directory_name
            from ${this.schema}.terms
          where code = $1`,
        [code],
      )
      if (result.rowCount === 0) {
        throw importError('INVALID_TERM_CODE', `未知学期代码：${code}`)
      }
      return result.rows[0]
    } catch (error) {
      throw this.translateDatabaseError(error, '查学期字典')
    }
  }

  /**
   * 把任意错误翻译成带业务错误码的 ImportError。
   *
   * ImportError 原样返回；ImportError 之外的（pg 连接错、约束冲突等）在这里收敛，
   * 保证路由层只会看到 ImportError 或真正的内部异常。
   *
   * @param {any} error 捕获到的错误
   * @param {string} stage 出错阶段（只进日志，不进响应）
   * @returns {Error} 可直接抛出的错误
   */
  translateDatabaseError(error, stage) {
    if (error instanceof ImportError) return error
    if (isDatabaseUnavailable(error)) {
      this.log?.warn('%s 失败：数据库不可用（%s）', stage, error.code)
      return importError('DATABASE_UNAVAILABLE', '数据库暂时不可用，请稍后重试')
    }
    // 约束冲突：理论上不该发生（应用层先拦过），发生即说明有未考虑到的输入
    if (typeof error?.code === 'string' && error.code === '23514') {
      this.log?.warn('%s 触发约束 %s', stage, error.constraint ?? '(unknown)')
      return importError('INVALID_FILENAME', '请求数据未通过数据库完整性检查')
    }
    return error
  }

  /**
   * 单文件导入（DESIGN §10 全流程）。
   *
   * @param {{
   *  subjectCode: string,
   *  termCode: string,
   *  filename: string,
   *  contentLength?: number,
   *  stream: import('node:stream').Readable,
   *  declaredContentType?: string,
   * }} input 上传参数
   * @returns {Promise<{outcome: 'imported'|'duplicate', capture: object}>} 导入结果
   */
  async importOne({ subjectCode, termCode, filename, contentLength, stream, declaredContentType }) {
    const originalFilename = validateFilename(filename)

    // ---- 1. 校验字典 ---------------------------------------------------
    const subject = await this.lookupSubject(subjectCode)
    const term = await this.lookupTerm(termCode)

    // ---- 上传体量上限：先看 Content-Length，能把大包挡在写盘之前 ------
    if (typeof contentLength === 'number' && Number.isFinite(contentLength) && contentLength > this.uploadMaxBytes) {
      throw importError('PAYLOAD_TOO_LARGE', `文件超过上限 ${this.uploadMaxBytes} 字节`)
    }
    if (typeof contentLength === 'number' && contentLength === 0) {
      throw importError('EMPTY_UPLOAD', '上传内容为空')
    }

    // ---- 2. 建 staging -------------------------------------------------
    // openStaging 抛的是 ArchiveError（staging 写失败），这里统一成 ImportError，
    // 保证 importOne 对外的错误类型单一，路由层不用认识存储层的错误类。
    let staging
    try {
      staging = await this.store.openStaging()
    } catch (error) {
      throw this.normalizeError(error)
    }

    /** 已成功的预留行：失败时要回写 last_error 保留现场（只留现场，不删行）。 */
    let reservation = null
    /** 已发布到归档目录的绝对路径：失败时**不删除**（原件不可变）。 */
    let publishedPath = null

    try {
      // ---- 3. 边收边算 -------------------------------------------------
      // 读流失败与写盘失败必须分开归因：前者是客户端断连（UPLOAD_ABORTED），
      // 后者是服务端磁盘故障（STAGING_WRITE_FAILED）。混成一条会把「磁盘满」
      // 报成「上传中断，请重新选择文件」——用户重试一万次也不会成功。
      try {
        for await (const chunk of stream) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          if (staging.bytesWritten + buffer.length > this.uploadMaxBytes) {
            // 中途超限：立刻停止读取，避免把剩下的几百 MB 也读进来
            stream.destroy?.()
            throw importError('PAYLOAD_TOO_LARGE', `文件超过上限 ${this.uploadMaxBytes} 字节`)
          }
          try {
            await staging.write(buffer)
          } catch (writeError) {
            // 写的是本进程自己打开的 staging 句柄，与客户端无关：
            // ENOSPC / EDQUOT / EIO / EACCES / EMFILE 一律是服务端写盘失败
            this.log?.warn('staging 写盘失败：%s', writeError?.code ?? '(no code)')
            throw importError('STAGING_WRITE_FAILED', '写入临时上传文件失败，请稍后重试')
          }
        }
      } catch (error) {
        if (error instanceof ImportError) throw error
        // 走到这里的只剩「读请求体」本身的失败：客户端断连 / socket 错误
        throw importError('UPLOAD_ABORTED', '上传中断，请重新选择文件')
      }

      // ---- 4. close/sync staging ---------------------------------------
      // sync/close 同样是服务端动作，失败也归 STAGING_WRITE_FAILED，
      // 不能让 fs 的原始错误漏到最外层被当成 INTERNAL_ERROR。
      let committed
      try {
        committed = await staging.commit()
      } catch (commitError) {
        this.log?.warn('staging 落盘失败：%s', commitError?.code ?? '(no code)')
        throw importError('STAGING_WRITE_FAILED', '临时上传文件落盘失败，请稍后重试')
      }
      const { digest, byteSize } = committed
      if (byteSize === 0) throw importError('EMPTY_UPLOAD', '上传内容为空')

      // staging 阶段先探测一次：只为拿 identify 确认的扩展名（见文件头说明）
      const stagingProbe = await this.probe(staging.filePath)

      // ---- 5. 预留（唯一并发仲裁点）------------------------------------
      const storageName = buildStorageName(digest, stagingProbe.extension)
      const relativePath = buildRelativePath(subject.directory_name, term.directory_name, storageName)
      const metadata = {
        original_filename: originalFilename,
        declared_content_type: typeof declaredContentType === 'string' ? declaredContentType : null,
        received_bytes: byteSize,
        upload_protocol: 'raw-octet-stream',
        probe: { format: stagingProbe.format, width: stagingProbe.width, height: stagingProbe.height },
      }

      const inserted = await this.reserve(digest, relativePath, originalFilename, metadata)

      // ---- 6. 无 RETURNING → 查既有行，按 status 分支 -------------------
      if (inserted === null) {
        return await this.resolveExisting(digest)
      }
      reservation = { id: inserted.id, status: inserted.status }

      // ---- 7. 预留成功者才复制 -----------------------------------------
      const published = await this.store.publish(staging.filePath, relativePath)
      publishedPath = published.absolutePath

      // ---- 8. 复算哈希 -------------------------------------------------
      const copiedDigest = await this.store.hashFile(publishedPath)
      if (!copiedDigest.equals(digest)) {
        // 不覆盖、不删除：留下现场供人工核对（DESIGN §10.2 要求校验复制后文件 SHA-256）
        throw importError('HASH_MISMATCH', '复制后的文件哈希与上传内容不一致，已保留现场')
      }

      // ---- 9. identify 读可信元数据 ------------------------------------
      const probe = await this.probe(publishedPath)
      if (probe.format !== stagingProbe.format) {
        throw importError('IMAGE_PROBE_FAILED', '归档文件格式与上传内容不一致')
      }

      // ---- 10/11. 推进状态机 ------------------------------------------
      await this.markCopied(inserted.id, probe, published.byteSize)
      // 状态已前移：后续若 markRegistered 失败，last_error 必须按 copied 同状态写入，
      // 否则会被状态机触发器当成回退而拒绝（只允许同状态 UPDATE）
      reservation.status = 'copied'
      const capture = await this.markRegistered(inserted.id)

      return { outcome: 'imported', capture: this.presentCapture(capture) }
    } catch (error) {
      // 失败现场处理：归档文件与预留行都保留（原件不可变 + 失败只留现场）
      if (reservation !== null) {
        await this.recordFailure(reservation.id, reservation.status, error)
      }
      throw this.normalizeError(error)
    } finally {
      // staging 是本次请求的私有产物，成功或失败都应清掉：
      // 它还没进归档树，删除不违反「原件不可变」；留着只会让 .wrongbook-tmp 涨大。
      await staging.discard()
    }
  }

  /**
   * 批量导入：逐文件**串行**调用 importOne，收集每一条的结果（DESIGN §15 第 5 步）。
   *
   * 三个设计选择必须写在这里，否则后来者会「优化」掉它们：
   *
   * 1) 为什么串行而不是 Promise.all 并发：
   *    · 单文件上限 32 MiB，N 路并发会同时占满带宽和 pg 连接池（maxConnections=4），
   *      一旦超过 4 个文件并行，后到的请求全部在等连接，整体反而更慢；
   *    · 进度反馈天然有序。「第 3/10 个，正在处理 xxx.jpg」只有在同一时刻只有
   *      一个文件在跑时才说得通；并发下「正在处理」是一个集合，UI 只能展示成
   *      「3 个进行中」，既难读也没有意义；
   *    · 并发安全性本来就不由客户端保证，而由 uq_captures_sha256 + ON CONFLICT
   *      在数据库层兜底（DESIGN §14.1-7）。所以「并发上传」既不必要也不划算。
   *
   * 2) 为什么不在这一层解析 multipart：
   *    HTTP 层继续复用 POST /wrongbook/import 的 raw body 单文件协议（已过 112 条
   *    断言），批量是**浏览器端循环 + Host 端这个方法**，不引入 boundary 解析、
   *    部分失败语义和临时文件管理。这个方法只是把「循环 + 逐条 try/catch」收进
   *    业务层，让 UI 不必自己拼汇总，也让「一个失败不影响其他」有单一真源。
   *
   * 3) 为什么单文件失败只记进 items 而绝不整体回滚：
   *    DESIGN §5.2 第 6 条与 §14.4-19 要求失败不得破坏已归档原件。整体回滚意味着
   *    删除已经发布进归档树、且已经登记为 registered 的原件 —— 那正是「原件不可变」
   *    禁止的动作。importOne 内部已经把失败收敛成「保留现场 + last_error 回写」，
   *    所以这里只需要不吞掉结果、继续下一个文件。
   *
   * @param {{
   *   subjectCode: string,
   *   termCode: string,
   *   files: Array<{filename: string, stream: import('node:stream').Readable, contentLength?: number, declaredContentType?: string, label?: string}>,
   *   onProgress?: (event: object) => void | Promise<void>,
   *   signal?: { aborted: boolean },
   * }} input 批量参数
   * @returns {Promise<{items: object[], totals: {total: number, imported: number, duplicate: number, failed: number}}>} 汇总
   */
  async importBatch({ subjectCode, termCode, files, onProgress, signal } = {}) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new ImportBatchError('INVALID_BATCH', '没有选择任何文件', false, 400)
    }

    // 字典先校验一次：科目/学期错了，N 个文件会撞同一个错，逐个报 N 遍既慢又吵，
    // 而且用户真正需要知道的只有一句「科目代码不对」。这一步失败属于整批失败。
    try {
      await this.lookupSubject(subjectCode)
      await this.lookupTerm(termCode)
    } catch (error) {
      const normalized = this.normalizeError(error)
      throw new ImportBatchError(
        normalized.code ?? 'INVALID_BATCH',
        normalized.message ?? '批量导入参数不合法',
        normalized.retryable === true,
        normalized.status ?? 400,
      )
    }

    const items = []
    const totals = { total: files.length, imported: 0, duplicate: 0, failed: 0 }

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index] ?? {}
      const filename = typeof file.filename === 'string' ? file.filename : ''
      // label 只用于 UI 显示（浏览器给的 File.name 就是这个），落库用的仍是
      // 严格校验过的 filename；两者分开，避免为了好看而放宽文件名规则。
      const label = typeof file.label === 'string' && file.label !== '' ? file.label : filename

      // 用户中途取消：不再开始新文件，但**已经处理完的不撤销**（原件不可变）。
      if (signal !== undefined && signal !== null && signal.aborted === true) {
        this.log?.info?.('批量导入被取消于第 %d/%d 个', index + 1, files.length)
        break
      }

      // 进度先发 start 再干活：用户看到的「正在处理」必须早于实际耗时，
      // 否则小文件一闪而过、大文件迟迟没有反馈。
      await this.emitProgress(onProgress, {
        index: index + 1,
        total: files.length,
        filename: label,
        phase: 'start',
        totals: { ...totals },
      })

      let item
      try {
        const result = await this.importOne({
          subjectCode,
          termCode,
          filename,
          contentLength: file.contentLength,
          stream: file.stream,
          declaredContentType: file.declaredContentType,
        })
        item = { index: index + 1, filename: label, outcome: result.outcome, capture: result.capture }
        if (result.outcome === 'duplicate') totals.duplicate += 1
        else totals.imported += 1
      } catch (error) {
        const normalized = this.normalizeError(error)
        item = {
          index: index + 1,
          filename: label,
          outcome: 'failed',
          // 错误 envelope 与 HTTP 层同构：UI 不用为批量再写一套解析
          error: {
            code: normalized.code ?? 'INTERNAL_ERROR',
            message: normalized.message ?? '导入失败',
            retryable: normalized.retryable === true,
            // 整批里这一条失败不该让整批变成 500；状态码只作参考
            status: normalized.status ?? 500,
          },
        }
        totals.failed += 1
        // 非业务错误在这里补一条日志：importOne 已经记过业务失败的现场，重复记没有价值
        if (!(normalized instanceof ImportError)) {
          this.log?.warn?.('批量导入第 %d 个文件异常：%s', index + 1, normalized?.message ?? String(normalized))
        }
      }

      items.push(item)
      await this.emitProgress(onProgress, {
        index: index + 1,
        total: files.length,
        filename: label,
        phase: 'done',
        outcome: item.outcome,
        result: item,
        totals: { ...totals },
      })
    }

    return { items, totals }
  }

  /**
   * 安全地触发一次进度回调。
   *
   * 进度回调是 UI 的**旁观者**：它抛错绝不能把已经成功的导入变成失败。
   * 这里吞掉并只记日志，是因为调用方（浏览器）刷新页面、组件卸载都会让回调失效，
   * 而文件已经归档、记录已经登记 —— 让一个渲染异常回滚业务状态是不可接受的。
   *
   * @param {((event: object) => void | Promise<void>) | undefined} onProgress 回调
   * @param {object} event 进度事件
   * @returns {Promise<void>}
   */
  async emitProgress(onProgress, event) {
    if (typeof onProgress !== 'function') return
    try {
      await onProgress(event)
    } catch (error) {
      this.log?.warn?.('批量进度回调失败（忽略）：%s', error?.message ?? String(error))
    }
  }

  /**
   * 把探测层的错误翻译成 ImportError。
   *
   * @param {string} filePath 待探测文件
   * @returns {Promise<{mediaType: string, extension: string, width: number, height: number, format: string}>}
   */
  async probe(filePath) {
    try {
      return await probeImage(filePath, this.probeOptions())
    } catch (error) {
      if (error instanceof ImageProbeError) {
        throw importError(error.code, error.message)
      }
      throw error
    }
  }

  /**
   * 收尾兜底：把 ArchiveError / pg 错误 / 未知异常统一成 ImportError。
   *
   * @param {any} error 原始错误
   * @returns {Error} 可抛出的错误
   */
  normalizeError(error) {
    if (error instanceof ImportError) return error
    if (error instanceof ArchiveError) {
      return importError(error.code, error.message)
    }
    const translated = this.translateDatabaseError(error, '导入收尾')
    return translated
  }

  /**
   * 预留 SHA-256（导入流程第 5 步的固定 SQL 形态）。
   *
   * `ON CONFLICT (sha256) DO NOTHING` 是唯一的并发仲裁点：不先 SELECT 再 INSERT，
   * 否则两个并发导入都会以为自己是第一个。
   *
   * @param {Buffer} digest 32 字节摘要
   * @param {string} relativePath 预先生成的碰撞安全相对路径
   * @param {string} originalFilename 原文件名
   * @param {object} metadata 源元数据（jsonb object）
   * @returns {Promise<{id: string, status: string, original_path: string} | null>} 预留成功返回行
   */
  async reserve(digest, relativePath, originalFilename, metadata) {
    try {
      const result = await this.pool.query(
        `INSERT INTO ${this.schema}.captures (sha256, original_path, original_filename, source_metadata_json, status)
          VALUES ($1, $2, $3, $4::jsonb, 'reserved')
          ON CONFLICT (sha256) DO NOTHING
          RETURNING id, status, original_path`,
        [digest, relativePath, originalFilename, JSON.stringify(metadata)],
      )
      if (result.rowCount === 0) return null
      return result.rows[0]
    } catch (error) {
      throw this.translateDatabaseError(error, '预留 captures')
    }
  }

  /**
   * 已有同哈希记录时的分支处理（导入流程第 6 步）。
   *
   *  · registered + 归档文件完好   → duplicate，直接返回既有 Capture
   *  · registered + 文件缺失/内容不符 → CAPTURE_RECOVERY_REQUIRED(409)
   *  · reserved / copied + 归档文件完整 → 恢复：补齐剩余状态推进并登记
   *  · reserved / copied + 文件缺失/损坏 → CAPTURE_RECOVERY_REQUIRED(409)
   *
   * 「文件是否完好」对**所有**状态都要核，包括 registered：状态机只保证记录
   * 推进顺序，不保证文件系统里那份复制品还在。对 registered 跳过这一步，
   * 就会把坏引用当作重复成功返回（见下方分支内注释）。
   *
   * 为什么缺文件不能自己复制：只有拿到 RETURNING 的预留者才有权按该路径复制
   * （PLAN_v1 §2）。别人代劳会掩盖「上一轮到底复制到哪一步」的真实状态，
   * 也会让两个请求同时往同一个目标名写 —— 那是覆盖原件的唯一入口。
   *
   * @param {Buffer} digest 本次上传的摘要
   * @returns {Promise<{outcome: 'imported'|'duplicate', capture: object}>} 结果
   */
  async resolveExisting(digest) {
    const existing = await this.fetchByDigest(digest)
    if (existing === null) {
      // 理论不可达：INSERT 冲突了就一定存在同一行（除非期间被手工删除）
      throw importError('CAPTURE_RECOVERY_REQUIRED', '预留冲突但未找到对应记录，请重试')
    }

    if (existing.status === 'registered') {
      // registered 只说明「这条记录登记完了」，不说明「文件还在」。
      // 归档目录在 Windows 盘上，用户可能手工移动/删除、或上一次写入后盘掉线，
      // 所以这里必须真的 stat + 复算哈希，再决定能不能回 duplicate。
      //
      // 为什么不直接信 registered：DESIGN §10.2「不得显示为成功导入」+
      // §14.4-20「引用可核对」——如果原件已经不在，UI 会显示
      // 「已存在（未复制）」而 <img> 指向 404，那是把坏引用伪装成成功。
      // PLAN_v1 的「registered → duplicate」描述的是记录存在的分支语义，
      // 不是「跳过文件存在性检查」，两者在这里是兼容的。
      const intactSize = await this.measureIntact(existing.original_path, digest)
      if (intactSize <= 0) {
        throw importError(
          'CAPTURE_RECOVERY_REQUIRED',
          '该文件已有登记记录，但归档原件缺失或内容不一致，需要先走恢复流程',
        )
      }
      // 用 fetchById 而不是复用 select * 的行：presentCapture 需要 join 出来的分类名
      return { outcome: 'duplicate', capture: this.presentCapture(await this.fetchById(existing.id)) }
    }

    // reserved / copied：先看归档文件到底在不在、对不对
    const intactSize = await this.measureIntact(existing.original_path, digest)

    if (intactSize <= 0) {
      throw importError(
        'CAPTURE_RECOVERY_REQUIRED',
        '该文件已有未完成的导入记录，但归档文件缺失或已损坏，需要先走恢复流程',
      )
    }

    // 文件完整：走「恢复」路径。这里不再复制（文件已就位），只补状态推进。
    try {
      if (existing.status === 'reserved') {
        const probe = await this.probeByPaths(existing.original_path)
        await this.markCopied(existing.id, probe, intactSize)
      }
      const capture = await this.markRegistered(existing.id)
      return { outcome: 'imported', capture: this.presentCapture(capture) }
    } catch (error) {
      throw this.normalizeError(error)
    }
  }

  /**
   * 核对一条既有记录的归档原件是否仍然完好。
   *
   * 「存在 + 大小 > 0」不够：原件可能被替换成同名但内容不同的文件，
   * 那样 sha256 唯一约束保护的「同一个文件只存一份」就名存实亡。所以这里
   * 复算磁盘上的摘要，只有与数据库里的 digest 一致才算完好。
   *
   * 任何异常（路径越界、文件不存在、权限不足、读失败）都返回 0 由调用方
   * 决定报什么错 —— 本方法只回答「能不能用」，不负责判定原因。
   *
   * @param {string} relativePath captures.original_path
   * @param {Buffer} digest 本次上传（或数据库记录）的 SHA-256
   * @returns {Promise<number>} 完好时返回文件字节数，否则 0
   */
  async measureIntact(relativePath, digest) {
    try {
      const absolute = await this.store.resolveOriginal(relativePath, { mustExist: true })
      const onDisk = await this.store.hashFile(absolute)
      if (!onDisk.equals(digest)) return 0
      // 只要字节数，但 openOriginalStream 会开一个真实句柄：必须立刻 destroy，
      // 否则每来一次 duplicate 就漏一个 fd（长期运行会把进程 fd 耗尽）。
      const { stream, size } = await this.store.openOriginalStream(relativePath)
      stream.destroy()
      return size
    } catch {
      return 0
    }
  }

  /**
   * 探测数据库里记录的原件（走 resolveOriginal 做越界防护）。
   *
   * @param {string} relativePath captures.original_path
   * @returns {Promise<{mediaType: string, extension: string, width: number, height: number, format: string}>}
   */
  async probeByPaths(relativePath) {
    const absolute = await this.store.resolveOriginal(relativePath, { mustExist: true })
    return await this.probe(absolute)
  }

  /**
   * 按 sha256 取既有记录。
   *
   * @param {Buffer} digest 32 字节摘要
   * @returns {Promise<any | null>} captures 行（含 join 出来的分类名）
   */
  async fetchByDigest(digest) {
    try {
      const result = await this.pool.query(`select * from ${this.schema}.captures where sha256 = $1`, [digest])
      if (result.rowCount === 0) return null
      return result.rows[0]
    } catch (error) {
      throw this.translateDatabaseError(error, '按哈希查既有记录')
    }
  }

  /**
   * 导入流程第 10 步的固定 SQL 形态：reserved → copied，并补齐媒体信息。
   *
   * `AND status = 'reserved'` 是幂等保护：并发恢复时只有一个能推进，
   * 另一个的 rowCount 为 0，由调用方决定是报错还是接受。
   *
   * @param {string} id captures.id
   * @param {{mediaType: string, width: number, height: number}} probe 探测结果
   * @param {number} byteSize 归档文件字节数
   * @returns {Promise<void>}
   */
  async markCopied(id, probe, byteSize) {
    try {
      const result = await this.pool.query(
        `UPDATE ${this.schema}.captures
            SET status = 'copied', media_type = $2, byte_size = $3, width = $4, height = $5, last_error = NULL
          WHERE id = $1 AND status = 'reserved'`,
        [id, probe.mediaType, byteSize, probe.width, probe.height],
      )
      if (result.rowCount === 0) {
        // 已经被别的请求推进了（并发恢复）。不是错误，但要如实反映
        throw importError('CAPTURE_RECOVERY_REQUIRED', '该记录的状态已被其他导入流程推进，请刷新后重试')
      }
    } catch (error) {
      throw this.translateDatabaseError(error, '推进到 copied')
    }
  }

  /**
   * 导入流程第 11 步的固定 SQL 形态：copied → registered。
   *
   * 同时把 last_error 清空：走到 registered 就意味着这次导入**完成**了。
   * 不清空会留下一个真实可复现的脏现场 —— 并发时两个请求都会尝试
   * copied → registered（一个从预留分支来、一个从恢复分支来），输的那个
   * 会按当时的 copied 状态回写 last_error；赢的那个随后把状态推到
   * registered，那条「状态已被其他导入流程推进」的旧错误就永远留在了
   * 一条已完成的记录上。UI 与人工核对都会把它误读成「这条还没弄好」。
   *
   * @param {string} id captures.id
   * @returns {Promise<any>} 已登记的 captures 行（含分类名）
   */
  async markRegistered(id) {
    try {
      const updated = await this.pool.query(
        `UPDATE ${this.schema}.captures
            SET status = 'registered', last_error = NULL
          WHERE id = $1 AND status = 'copied'`,
        [id],
      )
      if (updated.rowCount === 0) {
        throw importError('CAPTURE_RECOVERY_REQUIRED', '该记录未能从 copied 推进到 registered，请刷新后重试')
      }
      return await this.fetchById(id)
    } catch (error) {
      throw this.translateDatabaseError(error, '推进到 registered')
    }
  }

  /**
   * 按 id 取一条 Capture（带分类显示名，供 UI 直接渲染）。
   *
   * @param {string} id captures.id
   * @returns {Promise<any>} captures 行
   */
  async fetchById(id) {
    const result = await this.pool.query(`${this.captureSelect} where c.id = $1`, [id])
    if (result.rowCount === 0) throw importError('NOT_FOUND', '记录不存在')
    return result.rows[0]
  }

  /**
   * 失败现场保留：只做同状态 UPDATE last_error，不 DELETE 行。
   *
   * last_error 的取值口径被收窄成「业务错误码 + 固定文案」，不透传原始
   * error.message：
   *  · fs 错误的 message 里带 staging 的**绝对路径**（ENOENT/ENOSPC 都会带
   *    出完整路径），pg 错误的 message 里带 SQL 片段 —— 这两类信息进了
   *    captures.last_error 就等于把本机路径和 SQL 持久化了一份；
   *  · ImportError 的 message 在构造时就已经是面向用户的口径（无路径、无
   *    SQL、无 stack），可以原样落库；
   *  · 其余错误一律换成固定文案，真实原因只进插件日志。
   *
   * @param {string} id captures.id
   * @param {string} status 预留时的状态（同状态更新才不会被状态机触发器拒）
   * @param {any} error 原始错误
   * @returns {Promise<void>}
   */
  async recordFailure(id, status, error) {
    // 非业务错误也尽量留一个可检索的 errno / SQLSTATE，但只留码，不留文本
    const code = error instanceof ImportError
      ? error.code
      : (typeof error?.code === 'string' ? error.code : 'ERROR')
    const message = error instanceof ImportError ? error.message : '内部处理失败（详情见插件日志）'
    if (!(error instanceof ImportError)) {
      this.log?.warn('导入失败（capture %s，%s）：%s', id, code, error instanceof Error ? error.message : String(error))
    }
    const detail = `${code}: ${message}`.slice(0, 500)
    try {
      await this.pool.query(
        `UPDATE ${this.schema}.captures
            SET last_error = $2
          WHERE id = $1 AND status = $3`,
        [id, detail, status],
      )
    } catch (updateError) {
      // 连回写都失败时只能记日志：绝不能因为清理失败而掩盖原始错误
      this.log?.warn('回写 last_error 失败（capture %s）：%s', id, updateError.message)
    }
  }

  /**
   * 图库列表：最近的 Capture 及其分类（DESIGN §13.2 图库页）。
   *
   * captures 表没有 subject_id / term_id（设计如此：分类由归档路径的两级目录表达），
   * 所以这里用 original_path 的前两段去 join 字典表。字典表两侧都有唯一约束
   * （uq_subjects_directory_name / uq_terms_directory_name），join 不会放大行数。
   *
   * @param {{ limit?: number }} [options] 条数上限
   * @returns {Promise<{items: object[]}>} 列表
   */
  async listCaptures({ limit = 50 } = {}) {
    const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 50
    try {
      const result = await this.pool.query(`${this.captureSelect} order by c.created_at desc, c.id desc limit $1`, [
        safeLimit,
      ])
      return { items: result.rows.map((row) => this.presentCapture(row)) }
    } catch (error) {
      throw this.translateDatabaseError(error, '查询图库')
    }
  }

  /**
   * 按相对路径取一条已登记的 Capture（供 /originals/* 只读原件）。
   *
   * 关键：路径必须来自数据库，绝不能直接拿 URL 里的字符串去拼文件路径。
   *
   * @param {string} relativePath captures.original_path
   * @returns {Promise<{relativePath: string, mediaType: string | null, byteSize: number | null}>} 记录
   */
  async findOriginal(relativePath) {
    try {
      const result = await this.pool.query(
        `select original_path, media_type, byte_size
            from ${this.schema}.captures
          where original_path = $1`,
        [relativePath],
      )
      if (result.rowCount === 0) throw importError('NOT_FOUND', '原件不存在')
      const row = result.rows[0]
      return {
        relativePath: row.original_path,
        mediaType: row.media_type,
        byteSize: row.byte_size === null ? null : Number(row.byte_size),
      }
    } catch (error) {
      throw this.translateDatabaseError(error, '查原件记录')
    }
  }

  /**
   * 为 GET /wrongbook/originals/* 打开原件读流。
   *
   * 两步合成一个方法，是为了让「先查库、再读文件」这件事无法被调用方拆开：
   * 只要路径没在数据库里登记过，就一定不会有文件句柄被打开。
   *
   * @param {string} relativePath URL 里还原出来的相对路径
   * @returns {Promise<{mediaType: string, size: number, stream: import('node:stream').Readable}>}
   */
  async openOriginalForRead(relativePath) {
    const record = await this.findOriginal(relativePath)
    const { stream, size } = await this.store.openOriginalStream(record.relativePath)
    return { mediaType: record.mediaType, size, stream }
  }

  /**
   * 把数据库行整理成 UI 友好的形状。
   *
   * original_url 只暴露路由相对地址：页面用 <img src> 直接取，且绝不泄露
   * 本机绝对路径。路径分段分别 encode，避免空格/中文把 URL 弄坏。
   *
   * @param {any} row captures 行
   * @returns {object} 面向 UI 的 Capture
   */
  presentCapture(row) {
    const segments = String(row.original_path ?? '').split('/')
    return {
      id: row.id,
      sha256: typeof row.sha256 === 'string' ? row.sha256 : Buffer.isBuffer(row.sha256) ? row.sha256.toString('hex') : null,
      originalPath: row.original_path,
      originalFilename: row.original_filename,
      originalUrl: `/wrongbook/originals/${segments.map(encodeURIComponent).join('/')}`,
      mediaType: row.media_type,
      byteSize: row.byte_size === null || row.byte_size === undefined ? null : Number(row.byte_size),
      width: row.width,
      height: row.height,
      status: row.status,
      pageId: row.page_id ?? null,
      subject: row.subject_code ? { code: row.subject_code, displayName: row.subject_display_name } : null,
      term: row.term_code ? { code: row.term_code, displayName: row.term_display_name } : null,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    }
  }
}

/**
 * 图库/单条共用的 SELECT 模板（`{SCHEMA}` 由实例按配置替换）。
 *
 * sha256 用 encode() 输出 hex：pg 默认把 bytea 读成 Buffer，直接 JSON 序列化会变成
 * `{"type":"Buffer","data":[...]}`，UI 还得二次解码；在 SQL 侧转好更干净。
 *
 * 分类 join 的口径：captures 表本身没有 subject_id / term_id（设计如此，分类由
 * 归档路径的两级目录表达），所以用 original_path 的前两段去 join 字典表。
 * 字典表两侧都有唯一约束（uq_subjects_directory_name / uq_terms_directory_name），
 * join 不会放大行数。
 */
const CAPTURE_SELECT_TEMPLATE = `
  select c.id,
          encode(c.sha256, 'hex') as sha256,
          c.original_path,
          c.original_filename,
          c.media_type,
          c.byte_size,
          c.width,
          c.height,
          c.status,
          c.page_id,
          c.last_error,
          c.created_at,
          s.code     as subject_code,
          s.display_name as subject_display_name,
          t.code     as term_code,
          t.display_name as term_display_name
    from {SCHEMA}.captures c
    left join {SCHEMA}.subjects s on s.directory_name = split_part(c.original_path, '/', 1)
    left join {SCHEMA}.terms  t on t.directory_name = split_part(c.original_path, '/', 2)
`
