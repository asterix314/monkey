// 错题本插件 · Host 半边
//
// 职责（第一轮纵切面）：
//  1. 管理到 PostgreSQL 的连接池（peer 认证，Unix socket）
//  2. 暴露业务方法：health() / dictionaries() / 单文件导入 / 图库
//  3. 通过 webServer 注册 HTTP 路由，供 Client 页面调用
//
// 设计约束（来自 DESIGN.md 与 AGENTS.md）：
//  - 业务服务统一负责数据库与文件操作，UI 不直接写 SQL
//  - 数据库记录保存相对路径，不硬编码绝对路径
//  - 任何失败都返回结构化错误，不静默吞掉
//
// 代码组织：index.js 只做组装。
//  · config.js     配置 schema 与默认值
//  · archive-store.js 路径解析 / staging / 原子发布 / 流式哈希
//  · image-probe.js  identify 探测
//  · import-service.js importOne / listCaptures / ImportError
//
// 连接配置通过插件 Config 提供，默认值匹配当前已核实的环境：
//  PostgreSQL 18.6 / 库 wrongbook / schema app / peer 认证 / Unix socket

import { Config, resolveConfig } from './config.js'
import { ArchiveError } from './archive-store.js'
import { ImportError, ImportService, importError } from './import-service.js'
import { PageError, PageService } from './page-service.js'

// 重新导出 Config：Cordis 在激活插件时读取 index.js 的 `Config` 校验 config 行，
// 而 schema 的单一真源在 config.js（模块分工要求）。这里只做转发，不复制定义。
export { Config }


// 插件必须显式声明依赖的 Host 服务：
//  · webServer  用于暴露 HTTP 路由
//  · connection 用于 requestRejection 鉴权（修掉 /wrongbook/* 原本无鉴权的缺口）
export const name = 'wrongbook'
export const inject = ['webServer', 'connection']

export async function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  // 延迟加载 pg：让插件在缺少依赖时给出清晰错误，而不是整个 profile 起不来。
  let pg
  try {
    pg = (await import('pg')).default
  } catch (error) {
    throw new Error(`错题本插件需要 pg 依赖，但加载失败：${error.message}`)
  }

  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    max: config.maxConnections,
    // peer 认证下不需要密码；显式给出避免 pg 去读 PGPASSWORD 造成困惑
    password: undefined,
    // 在连接启动参数里设置 search_path：
    //  · 避免 pool.on('connect') 里再 query 触发 pg 8 的弃用警告
    //  · 让业务查询里的非限定表名也落在目标 schema
    // statement_timeout 兜底：查询挂死（如表锁）时不会无限占住连接
    options: `-c search_path=${config.schema},public -c statement_timeout=5000`,
    // 连接超时，避免 UI 点一下卡死
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  })

  // 创建 pool 后**立刻**注册清理，消除「pool 已建但 effect 未注册」的泄漏窗口：
  // 若后续任何语句抛错，apply() 失败时 pool 仍会被关闭。
  ctx.effect(() => () => {
    pool.end().catch(() => {})
  })

  // 命名 logger：cordis 的 ctx.logger 是方法，不是属性
  const log = ctx.logger('wrongbook')

  // 连接池里的空闲连接出错时不要让进程崩溃
  pool.on('error', (error) => {
    log.warn('数据库空闲连接异常：%s', error.message)
  })

  // ---- 业务服务 ----------------------------------------------------------

  /**
   * 健康检查：连库、读版本、统计各表行数。
   * 这是第一轮纵切面的验收点——UI 点一下按钮，能拿到真实的库信息。
   */
  async function health() {
    const startedAt = Date.now()
    try {
      const versionResult = await pool.query('select version() as version')
      const schemaResult = await pool.query(
        `select count(*)::int as table_count
            from pg_tables
          where schemaname = $1`,
        [config.schema],
      )
      // 逐表行数：一条 UNION ALL 查完，避免 7 次串行往返。
      // 表名来自固定白名单（不拼用户输入），schema 已过标识符白名单校验。
      const tables = ['subjects', 'terms', 'documents', 'pages', 'captures', 'page_transforms', 'image_assets']
      const countsSql = tables
        .map((table) => `select '${table}' as t, count(*)::int as n from ${config.schema}.${table}`)
        .join(' union all ')
      const countsResult = await pool.query(countsSql)
      const counts = {}
      for (const row of countsResult.rows) counts[row.t] = row.n
      return {
        ok: true,
        database: config.database,
        schema: config.schema,
        serverVersion: versionResult.rows[0].version,
        tableCount: schemaResult.rows[0].table_count,
        rowCounts: counts,
        elapsedMs: Date.now() - startedAt,
      }
    } catch (error) {
      return {
        ok: false,
        database: config.database,
        schema: config.schema,
        error: error.message,
        code: error.code ?? null,
        elapsedMs: Date.now() - startedAt,
      }
    }
  }

  /**
   * 读取科目和学期字典，供导入页的两个下拉框使用。
   */
  async function dictionaries() {
    const subjects = await pool.query(
      `select code, display_name, directory_name, sort_order
          from ${config.schema}.subjects
        where enabled
        order by sort_order, code`,
    )
    const terms = await pool.query(
      `select code, display_name, directory_name, sort_order
          from ${config.schema}.terms
        order by sort_order, code`,
    )
    return { subjects: subjects.rows, terms: terms.rows }
  }

  // 单文件导入 / 图库 / 原件读取全部委托给 ImportService：
  // 它同时持有 SQL 与文件系统两侧的知识，路由层不做业务判断（模块分工）。
  const importService = new ImportService({
    pool,
    schema: config.schema,
    originalsRoot: config.originals_root,
    uploadMaxBytes: config.upload_max_bytes,
    identifyTimeoutMs: config.identify_timeout_ms,
    log,
  })

  // Page 归组（DESIGN §15 第 6 步）是纯人工归组：只维护 Capture ↔ Page 的关系。
  // 它复用 ImportService 的 captureSelect / presentCapture，所以两个服务必须
  // 用同一个 schema 与同一个池构造 —— 图库与归组页看到的 Capture 形状才一致。
  const pageService = new PageService({
    pool,
    schema: config.schema,
    importService,
    log,
  })

  // 把业务服务挂到 ctx 上，供同进程的其他 Host 插件/工具调用。
  // ctx.provide 返回 disposer，必须用 ctx.effect 持有，插件卸载时才会撤销。
  // 批量导入（DESIGN §15 第 5 步）**只**以业务方法的形式挂出来，不新增 HTTP 路由：
  //  · 浏览器端串行循环调 /wrongbook/import，一次一个 raw body，协议与鉴权路径完全不变
  //    （已过 112 条断言的单文件路由零改造成本，也没有 multipart boundary 解析面）；
  //  · importBatch 只是把「循环 + 逐条 try/catch + 汇总」收进业务层，让
  //    「一个失败不影响其他」有单一真源，供同进程的其他 Host 插件/工具复用；
  //  · 一旦在 HTTP 层暴露批量端点，就必须定义 multipart 或自定义多段协议、
  //    部分失败语义和临时文件生命周期 —— 收益为零，风险为正。
  ctx.effect(() =>
    ctx.provide('wrongbook', {
      health,
      dictionaries,
      importOne: (input) => importService.importOne(input),
      importBatch: (input) => importService.importBatch(input),
      listCaptures: (input) => importService.listCaptures(input),
      // 第 6 步：Page 归组（纯人工）。同样只以业务方法形式挂出，UI 不写 SQL。
      listPages: (input) => pageService.listPages(input),
      getPage: (input) => pageService.getPage(input),
      createPage: (input) => pageService.createPage(input),
      attachCapture: (input) => pageService.attachCapture(input),
      setPreferredCapture: (input) => pageService.setPreferredCapture(input),
      listUngroupedCaptures: (input) => pageService.listUngroupedCaptures(input),
    }),
  )

  // ---- HTTP 路由 --------------------------------------------------------
  // 前缀 /wrongbook/，Client 页面用 fetch 调用。
  const BASE = '/wrongbook'

  function sendJson(res, status, body) {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  }

  /**
   * 统一的错误 envelope：`{ok:false, error:{code, message, retryable, extra?}}`。
   * `extra` 只在业务错误带了普通对象时出现（当前只有 PageError 的 {pageId}）。
   *
   * 响应里绝不写本机绝对路径、SQL、stack —— ImportError 的 message 在构造时
   * 就已经是这个口径；未知异常一律换成固定文案，原始信息只进日志。
   *
   * @param {import('node:http').ServerResponse} res 响应
   * @param {any} error 捕获到的错误
   * @param {string} route 路由标识（只进日志）
   */
  function sendFailure(res, error, route) {
    if (error instanceof ImportError) {
      // extra 只承载 UUID 这类无敏感内容的 UI 上下文（如 { pageId }），
      // 让前端能直接跳到当前归属，而不用再发一次查询。
      // 只接受**非空**普通对象：数组 / null / 标量 / {} 一律不进响应。
      // 排除空对象不是洁癖：PageError 把 extra 缺省成 {}，若不排掉，所有不带
      // 上下文的业务错误都会多出一个空壳 extra，错误契约就变成「有时有有时没有」
      // 的半可选字段，前端与测试都得为它写特例。
      const hasExtra =
        error.extra !== null &&
        typeof error.extra === 'object' &&
        !Array.isArray(error.extra) &&
        Object.keys(error.extra).length > 0
      const extra = hasExtra ? { extra: error.extra } : {}
      return sendJson(res, error.status, {
        ok: false,
        error: { code: error.code, message: error.message, retryable: error.retryable, ...extra },
      })
    }
    if (error instanceof ArchiveError) {
      // ArchiveError 没带 HTTP 语义，按最接近的归档失败处理
      return sendJson(res, 500, {
        ok: false,
        error: { code: error.code, message: error.message, retryable: true },
      })
    }
    // 未预期异常：错误码表枚举的是业务结果，这里没有对应的业务含义，
    // 借用任何一个都会让 retryable 说谎。用独立兜底码 + 500，原始信息只进日志。
    log.warn('%s 未预期失败：%s', route, error instanceof Error ? error.message : String(error))
    return sendJson(res, 500, {
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: '服务内部错误，请查看插件日志', retryable: true },
    })
  }

  /**
   * 鉴权闸门：连接层的 Host/Origin 校验 + 浏览器凭据校验。
   *
   * 每条路由 handler 的第一行都调它。返回 true 表示已经写好拒绝响应、调用方
   * 必须立刻 return。修的是 Lead 实测到的缺口：无 cookie GET /wrongbook/health
   * 曾经返回 200，而框架首页返回 401。
   *
   * @param {import('node:http').IncomingMessage} req 请求
   * @param {import('node:http').ServerResponse} res 响应
   * @returns {boolean} 是否已拒绝
   */
  function rejected(req, res) {
    const rejection = ctx.connection.requestRejection({ headers: req.headers })
    if (rejection === undefined) return false
    const code = rejection === 403 ? 'FORBIDDEN_ORIGIN' : 'UNAUTHENTICATED'
    const message = rejection === 403 ? '请求来源不被信任' : '未登录或登录已过期'
    sendJson(res, rejection, { ok: false, error: { code, message, retryable: false } })
    return true
  }

  /** 只允许指定方法；否则 405 + allow 头。返回 true 表示已响应。 */
  function methodNotAllowed(res, allowed, method) {
    if (allowed.includes(method)) return false
    res.writeHead(405, { allow: allowed.join(', '), 'content-type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
        ok: false,
        error: { code: 'NOT_FOUND', message: `不支持的方法：${method}`, retryable: false },
      }),
    )
    return true
  }

  /**
   * 读取并解析 JSON 请求体（只用于元数据类的小 body）。
   *
   * 为什么不用 `req.body`：这个 webServer 只给原始 `req`，body 从来没有被
   * 预读成对象；写 `req.body` 会永远是 undefined，看起来像「客户端没传」。
   *
   * 为什么自己流式累计字节而不是看 content-length：chunked 请求没有这个头，
   * 有也可以撒谎。按实际收到的字节数截断，才是真的上限。
   *
   * @param {import('node:http').IncomingMessage} req 请求
   * @param {{ maxBytes?: number }} [options] 上限
   * @returns {Promise<object>} 解析出的普通对象
   */
  async function readJsonBody(req, { maxBytes = 16384 } = {}) {
    const contentType = req.headers['content-type'] ?? ''
    // 先认 Content-Type：浏览器跨站表单能发 text/plain 的「JSON」，那种请求
    // 不该被当成 JSON API 调用接受（也顺带挡住不需要预检的简单请求）。
    if (!contentType.toLowerCase().includes('application/json')) {
      throw new PageError('INVALID_BODY', '请求必须使用 application/json')
    }

    const chunks = []
    let received = 0
    for await (const chunk of req) {
      received += chunk.length
      if (received > maxBytes) {
        // 超限后不再继续读：把剩余数据丢掉并让连接自行结束，避免内存被撑爆。
        // 抛错由 sendFailure 转成 413，不需要在这里写响应。
        throw importError('PAYLOAD_TOO_LARGE', `请求体超过 ${maxBytes} 字节上限`)
      }
      chunks.push(chunk)
    }

    const text = Buffer.concat(chunks).toString('utf8')
    if (text.trim() === '') throw new PageError('INVALID_BODY', '请求体不能为空')

    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      // 不回传 JSON.parse 的原始报错：它带着出错位置和片段，属于内部细节
      throw new PageError('INVALID_BODY', '请求体不是合法的 JSON')
    }

    // 数组 / null / 数字都能被 JSON.parse 成功，但都不是「一个带字段的对象」
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new PageError('INVALID_BODY', '请求体必须是 JSON 对象')
    }
    return parsed
  }

  /**
   * 从请求体里取一个必填字符串字段。
   *
   * 类型错误在这里就报 INVALID_BODY，而不是让下游的 UUID 校验去报
   * INVALID_UUID —— 「没传」和「传了但格式错」是两件事，前端提示不同。
   *
   * @param {object} body 已解析的请求体
   * @param {string} field 字段名
   * @returns {string} 字段值
   */
  function requireStringField(body, field) {
    const value = body[field]
    if (typeof value !== 'string' || value === '') {
      throw new PageError('INVALID_BODY', `缺少必填字段：${field}`)
    }
    return value
  }

  // ---- 路由 1/9：GET /wrongbook/health ----------------------------------
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${BASE}/health`,
      async handler(req, res) {
        if (rejected(req, res)) return
        if (methodNotAllowed(res, ['GET'], req.method)) return
        try {
          return sendJson(res, 200, await health())
        } catch (error) {
          return sendFailure(res, error, 'GET /wrongbook/health')
        }
      },
    }),
  )

  // ---- 路由 2/9：GET /wrongbook/dictionaries ----------------------------
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${BASE}/dictionaries`,
      async handler(req, res) {
        if (rejected(req, res)) return
        if (methodNotAllowed(res, ['GET'], req.method)) return
        try {
          return sendJson(res, 200, await dictionaries())
        } catch (error) {
          return sendFailure(res, error, 'GET /wrongbook/dictionaries')
        }
      },
    }),
  )

  /**
   * 路由 3/9：POST /wrongbook/import
   *
   * 上传协议：raw body（application/octet-stream），元数据全在 query：
   *  subject_code / term_code / filename
   * 不解析 multipart：单文件纵切面不需要，也少一层边界解析风险。
   */
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${BASE}/import`,
      async handler(req, res) {
        if (rejected(req, res)) return
        if (methodNotAllowed(res, ['POST'], req.method)) return

        const url = new URL(req.url || '/', 'http://localhost')
        const subjectCode = url.searchParams.get('subject_code') ?? ''
        const termCode = url.searchParams.get('term_code') ?? ''
        const filename = url.searchParams.get('filename') ?? ''

        // Content-Length 可能是字符串，也可能缺失（chunked）。缺失时交给
        // 流式累计字节数判断，不能当成 0。
        const rawLength = req.headers['content-length']
        const contentLength =
          typeof rawLength === 'string' && /^\d+$/.test(rawLength) ? Number(rawLength) : undefined

        try {
          if (subjectCode === '') throw importError('INVALID_SUBJECT_CODE', '缺少科目代码')
          if (termCode === '') throw importError('INVALID_TERM_CODE', '缺少学期代码')

          const result = await importService.importOne({
            subjectCode,
            termCode,
            filename,
            contentLength,
            stream: req,
            declaredContentType: req.headers['content-type'],
          })
          // 成功 envelope：{ok:true, outcome, capture}
          return sendJson(res, 200, { ok: true, outcome: result.outcome, capture: result.capture })
        } catch (error) {
          return sendFailure(res, error, 'POST /wrongbook/import')
        }
      },
    }),
  )

  // ---- 路由 4/9：GET /wrongbook/captures --------------------------------
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${BASE}/captures`,
      async handler(req, res) {
        if (rejected(req, res)) return
        if (methodNotAllowed(res, ['GET'], req.method)) return
        const url = new URL(req.url || '/', 'http://localhost')
        const rawLimit = url.searchParams.get('limit')
        const limit = rawLimit !== null && /^\d+$/.test(rawLimit) ? Number(rawLimit) : 50
        try {
          const { items } = await importService.listCaptures({ limit })
          return sendJson(res, 200, { ok: true, items })
        } catch (error) {
          return sendFailure(res, error, 'GET /wrongbook/captures')
        }
      },
    }),
  )

  // ---- 路由 5/9：GET /wrongbook/originals/* ----------------------------
  // 只按数据库里已登记的 original_path 读文件，绝不接受客户端任意路径。
  // 用 prefix 路由：剩下的路径段就是相对路径。
  const ORIGINALS_PREFIX = `${BASE}/originals`
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ORIGINALS_PREFIX,
      async handler(req, res) {
        if (rejected(req, res)) return
        if (methodNotAllowed(res, ['GET', 'HEAD'], req.method)) return

        // 从原始 URL 上切，而不是用 url.pathname：pathname 已被 WHATWG 规范化，
        // 但我们要保留百分号编码的原始分段，再逐段解码 —— 这样文件名里的
        // 中文、空格、括号都能正确还原，同时「编码过的斜杠」不会伪造出新层级。
        const rawPath = (req.url || '/').split('?', 1)[0]
        if (!rawPath.startsWith(`${ORIGINALS_PREFIX}/`)) {
          return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '原件不存在', retryable: false } })
        }
        const rawRelative = rawPath.slice(ORIGINALS_PREFIX.length + 1)

        let relativePath
        try {
          relativePath = rawRelative
            .split('/')
            .map((segment) => decodeURIComponent(segment))
            .join('/')
        } catch {
          // 非法百分号编码
          return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '原件不存在', retryable: false } })
        }

        try {
          // 先查库确认这条路径确实登记过 —— 这是「不接受任意路径」的关键一步。
          // 查库与开流合成一个服务方法，避免调用方漏掉前半步。
          const { stream, size, mediaType } = await importService.openOriginalForRead(relativePath)
          res.writeHead(200, {
            // 媒体类型以数据库记录为准（来自 identify），不回退到扩展名猜测
            'content-type': mediaType ?? 'application/octet-stream',
            'content-length': size,
            // 原件不可变：路径一旦登记就不会再改内容，适合长缓存
            'cache-control': 'private, max-age=86400, immutable',
            'x-content-type-options': 'nosniff',
          })
          if (req.method === 'HEAD') {
            res.end()
            stream.destroy()
            return
          }
          stream.on('error', () => {
            // 头已经发出去了，只能中断连接；不要试图改写状态码
            res.destroy()
          })
          stream.pipe(res)
        } catch (error) {
          return sendFailure(res, error, 'GET /wrongbook/originals/*')
        }
      },
    }),
  )

  // ---- 第 6 步：Page 人工归组（4 条路由 / 5 个方法） ----------------------
  //
  // 全部 kind:'exact'：dsh-host-webserver 的 WebRouteKind 只有 'exact' | 'prefix'，
  // 没有路径参数（`/pages/:id` 会被当成字面量注册，永远匹配不到）。
  // 所以标识一律走 query 参数或 JSON body 字段。

  // ---- 路由 6/9：GET|POST /wrongbook/pages -----------------------------
  //
  // GET  一页一卡（不是一 Capture 一卡），支持按科目/学期筛选与关键字搜索。
  // POST 「不同页，创建新页面」：body {capture_id}
  //
  // 两个方法合并在**一个** register 调用里，不是风格选择：宿主
  // webServer.register() 对同一 path 的第二次注册直接抛
  // `webserver: duplicate exact route`，拆成两条会让整个插件 apply() 失败。
  // 路由的键是 path，方法分派必须由 handler 自己做。
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${BASE}/pages`,
      async handler(req, res) {
        if (rejected(req, res)) return
        if (methodNotAllowed(res, ['GET', 'POST'], req.method)) return

        if (req.method === 'POST') {
          try {
            const body = await readJsonBody(req)
            const result = await pageService.createPage({
              captureId: requireStringField(body, 'capture_id'),
            })
            return sendJson(res, 200, { ok: true, ...result })
          } catch (error) {
            return sendFailure(res, error, 'POST /wrongbook/pages')
          }
        }

        const url = new URL(req.url || '/', 'http://localhost')
        const rawLimit = url.searchParams.get('limit')
        const limit = rawLimit !== null && /^\d+$/.test(rawLimit) ? Number(rawLimit) : 50
        try {
          const { items } = await pageService.listPages({
            limit,
            subjectCode: url.searchParams.get('subject_code') ?? undefined,
            termCode: url.searchParams.get('term_code') ?? undefined,
            q: url.searchParams.get('q') ?? undefined,
          })
          return sendJson(res, 200, { ok: true, items })
        } catch (error) {
          return sendFailure(res, error, 'GET /wrongbook/pages')
        }
      },
    }),
  )

  // ---- 路由 7/9：GET /wrongbook/pages/detail ---------------------------
  // 单页 + 页内全部 Capture。page_id 走 query，因为路由不支持路径参数。
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${BASE}/pages/detail`,
      async handler(req, res) {
        if (rejected(req, res)) return
        if (methodNotAllowed(res, ['GET'], req.method)) return

        const url = new URL(req.url || '/', 'http://localhost')
        const pageId = url.searchParams.get('page_id')
        try {
          if (pageId === null || pageId === '') throw new PageError('INVALID_BODY', '缺少必填参数：page_id')
          const detail = await pageService.getPage(pageId)
          return sendJson(res, 200, { ok: true, ...detail })
        } catch (error) {
          return sendFailure(res, error, 'GET /wrongbook/pages/detail')
        }
      },
    }),
  )

  // ---- 路由 8/9：POST /wrongbook/pages/attach --------------------------
  // 「同一页，添加为另一张照片」：body {page_id, capture_id}
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${BASE}/pages/attach`,
      async handler(req, res) {
        if (rejected(req, res)) return
        if (methodNotAllowed(res, ['POST'], req.method)) return
        try {
          const body = await readJsonBody(req)
          const result = await pageService.attachCapture({
            pageId: requireStringField(body, 'page_id'),
            captureId: requireStringField(body, 'capture_id'),
          })
          return sendJson(res, 200, { ok: true, ...result })
        } catch (error) {
          return sendFailure(res, error, 'POST /wrongbook/pages/attach')
        }
      },
    }),
  )

  // ---- 路由 9/9：POST /wrongbook/pages/preferred ----------------------
  // 更换首选 Capture：body {page_id, capture_id}
  // 只改 preferred_capture_id —— 不删 Capture、不碰原件、不改 status。
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${BASE}/pages/preferred`,
      async handler(req, res) {
        if (rejected(req, res)) return
        if (methodNotAllowed(res, ['POST'], req.method)) return
        try {
          const body = await readJsonBody(req)
          const result = await pageService.setPreferredCapture({
            pageId: requireStringField(body, 'page_id'),
            captureId: requireStringField(body, 'capture_id'),
          })
          return sendJson(res, 200, { ok: true, ...result })
        } catch (error) {
          return sendFailure(res, error, 'POST /wrongbook/pages/preferred')
        }
      },
    }),
  )

  log.info('已启动：%s.%s @ %s', config.database, config.schema, config.host)
}
