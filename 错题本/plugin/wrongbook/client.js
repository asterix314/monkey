// 错题本插件 · 浏览器半边
//
// 第一轮纵切面的验收目标：侧栏有入口，主区域是真实 React 页面
//  · 导入卡片：选科目 / 学期 / 多张图 → 串行逐个 POST /wrongbook/import
//    → 进度条「第 N/M 个，正在处理 xxx.jpg」+ 每个文件独立的结果行
//  · 图库卡片：GET /wrongbook/captures → 逐个显示分类、原文件名、宽高、大小、状态、图片
//  · 原有两张卡片（数据库连接 / 科目与学期）保留，作为环境自检入口
//
// 遵守的约束：
//  - 用 slot 注册 React 组件，不用 iframe
//  - 不 require 任何 Harness Client 包（会随时变更）
//  - 颜色一律用 --dsw-alias-* 主题 token，不写死色值、不写 var() 第二参 fallback
//  - 可见文本目前仍是中文硬编码（已知限制，见 plugin/README.md 第 8 节）；
//   locale 化留到后续步骤统一做，避免现在半途改造
window.__ModuleLoader__.load({
  id: 'dsh-wrongbook',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL = 'wrongbook'
    const API = '/wrongbook'

    // 单张上传上限：与 Host 端 config.upload_max_bytes 默认值一致（用户已确认 32 MiB）。
    // 客户端提前拦一次只是为了少传 30 MiB 无用字节；**真正的权威检查在 Host**，
    // 改这里的常量不会放宽任何安全边界。
    const UPLOAD_MAX_BYTES = 33554432

    // ---- 样式 ------------------------------------------------------------
    // 以 React 元素渲染 <style>，随组件卸载自动移除；不直接操作 document.head，
    // 避免在组件外写 DOM（规范要求）。只引用 --dsw-alias-* 主题 token，
    // 且不写 var() 第二参 fallback —— 组件样式里内嵌色值会被规范拒绝；
    // 主题缺失时宁可无色，也不要落回硬编码色（那会让暗色主题失效）。
    // token 名逐个核对过 @deepseek-ai/dsh-client-ui-theme 的 design_platform_css_default。
    const CSS = `
      .wb-page { box-sizing: border-box; flex: 1 1 auto; min-height: 0; width: 100%; max-width: 880px; margin: 0 auto; padding: 24px; overflow-y: auto; overflow-x: hidden; font-size: 14px; color: var(--dsw-alias-label-primary); }
      .wb-title { font-size: 20px; font-weight: 600; margin: 0 0 4px; color: var(--dsw-alias-label-primary); }
      .wb-sub { margin: 0 0 20px; color: var(--dsw-alias-label-tertiary); }
      .wb-card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 16px; margin-bottom: 16px; background: var(--dsw-alias-bg-layer-2); }
      .wb-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
      .wb-card-title { font-weight: 600; margin: 0; color: var(--dsw-alias-label-primary); }
      .wb-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-button-elevated-fill); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 7px 14px; font-size: 13px; cursor: pointer; }
      .wb-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
      .wb-btn:disabled { opacity: .55; cursor: default; }
      .wb-btn-primary { background: var(--dsw-alias-button-primary-fill); border-color: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
      .wb-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
      .wb-row { display: flex; justify-content: space-between; gap: 16px; padding: 6px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .wb-row:last-child { border-bottom: 0; }
      .wb-key { color: var(--dsw-alias-label-tertiary); }
      .wb-val { font-variant-numeric: tabular-nums; text-align: right; word-break: break-all; }
      .wb-ok { color: var(--dsw-alias-state-success-primary); font-weight: 600; }
      .wb-err { color: var(--dsw-alias-state-error-primary); font-weight: 600; }
      .wb-warn { color: var(--dsw-alias-state-warn-primary); font-weight: 600; }
      .wb-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
      .wb-note { margin: 8px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
      .wb-placeholder { color: var(--dsw-alias-label-tertiary); font-size: 13px; }
      .wb-form { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
      .wb-field { display: flex; flex-direction: column; gap: 5px; min-width: 160px; }
      .wb-field-label { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
      .wb-select, .wb-file { appearance: auto; border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 6px 8px; font-size: 13px; max-width: 100%; }
      .wb-file { padding: 4px; }
      .wb-status { margin-top: 12px; font-size: 13px; }
      .wb-preview { margin-top: 12px; }
      .wb-preview img { display: block; max-width: 100%; max-height: 420px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
      .wb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
      .wb-tile { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; overflow: hidden; background: var(--dsw-alias-bg-layer-1); display: flex; flex-direction: column; }
      .wb-tile-img { width: 100%; height: 140px; object-fit: cover; display: block; background: var(--dsw-alias-bg-skeleton); }
      .wb-tile-body { padding: 8px 10px; display: flex; flex-direction: column; gap: 3px; }
      .wb-tile-name { font-size: 12px; font-weight: 600; word-break: break-all; }
      .wb-tile-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
      .wb-badge { display: inline-block; border: 1px solid var(--dsw-alias-border-l3); border-radius: 999px; padding: 1px 8px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .wb-img-missing { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; justify-content: center; padding: 10px; border: 1px dashed var(--dsw-alias-border-l3); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); font-size: 12px; min-height: 72px; }
      .wb-img-url { color: var(--dsw-alias-label-tertiary); word-break: break-all; font-size: 11px; }

      /* ---- 批量导入：进度条 / 文件清单 / 逐条结果 ---------------------- */
      /* 进度条用两层 div（轨道 + 填充），不用 <progress> —— 原生控件在各浏览器
         的默认样式无法用主题 token 覆盖，暗色主题下会突然变成白底蓝条。 */
      .wb-progress { margin-top: 12px; }
      .wb-progress-track { height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-skeleton); overflow: hidden; }
      .wb-progress-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-state-success-primary); transition: width .18s linear; }
      .wb-progress-text { margin-top: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
      .wb-filelist { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
      .wb-fileitem { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); font-size: 12px; }
      .wb-fileitem-name { flex: 1 1 auto; word-break: break-all; }
      .wb-fileitem-size { color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap; }
      .wb-fileitem-action { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; font-size: 12px; padding: 0 2px; }
      .wb-fileitem-action:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary); }
      .wb-fileitem-action:disabled { opacity: .5; cursor: default; }
      .wb-badge-ok { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
      .wb-badge-dup { border-color: var(--dsw-alias-border-l3); color: var(--dsw-alias-label-tertiary); }
      .wb-badge-err { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
      .wb-summary { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 12px; font-size: 13px; }
      .wb-summary-item { font-variant-numeric: tabular-nums; }
      .wb-err-detail { font-size: 11px; color: var(--dsw-alias-label-tertiary); word-break: break-all; }

      /* ---- 第 6 步：待整理 / 人工归组 / 页面图库 ------------------------- */
      /* 列表项整体做成 <button>（而不是 div + 内部按钮）：键盘可达、语义正确，
         也避免「点整条」和「点里面的按钮」互相抢事件。所以这里要显式清掉
         原生按钮的字体与外观，否则会跟周围的文字排版不一致。 */
      .wb-pending-list, .wb-page-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
      .wb-pending-item, .wb-page-row { display: flex; align-items: center; gap: 10px; width: 100%; appearance: none; text-align: left; font: inherit; color: inherit; cursor: pointer; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 8px 10px; background: var(--dsw-alias-bg-layer-1); }
      .wb-pending-item:hover, .wb-page-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
      /* 选中态用边框色 + 内阴影两层标记：只换背景色在暗色主题下不够明显，
         用户会分不清「悬停」和「已选中」。 */
      .wb-pending-item-active, .wb-page-row-active { border-color: var(--dsw-alias-button-primary-fill); background: var(--dsw-alias-interactive-bg-hover); box-shadow: inset 0 0 0 1px var(--dsw-alias-button-primary-fill); }
      .wb-thumb { flex: 0 0 auto; width: 64px; height: 64px; object-fit: cover; border-radius: 6px; display: block; background: var(--dsw-alias-bg-skeleton); }
      /* 小尺寸缩略图放不下「原件无法加载…」整句和 URL，所以裁掉 URL 只留一句短提示；
         大图（并排比较）仍用完整说明，因为那里有空间、也需要能核对路径。 */
      .wb-thumb-missing { width: 64px; height: 64px; min-height: 0; padding: 4px; overflow: hidden; font-size: 10px; }
      .wb-thumb-missing .wb-img-url { display: none; }
      .wb-detail-missing { width: 48px; height: 48px; min-height: 0; padding: 2px; overflow: hidden; font-size: 9px; }
      .wb-detail-missing .wb-img-url { display: none; }
      .wb-pane-missing { width: 100%; height: 200px; min-height: 0; font-size: 12px; overflow: hidden; }
      .wb-thumb-empty { display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--dsw-alias-label-tertiary); text-align: center; }
      .wb-item-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .wb-item-title { font-size: 12px; font-weight: 600; word-break: break-all; }
      .wb-item-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary); word-break: break-all; }
      .wb-cover-tag { font-size: 11px; color: var(--dsw-alias-state-warn-primary); }
      /* 左右并排，但窄容器（侧栏收窄、小窗口）自动堆成上下：强行 1fr 1fr
         会把两张图挤到只剩几十像素，反而看不出是不是同一页。 */
      .wb-split { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin-top: 10px; }
      .wb-pane { min-width: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 10px; background: var(--dsw-alias-bg-layer-1); }
      .wb-pane-title { margin: 0 0 8px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
      /* 归组比较必须看全整页，不能像缩略图那样裁切：cover 会切掉边角，
         而「是不是同一页」恰恰靠边角的版式来判断。 */
      .wb-pane-img { display: block; width: 100%; height: 200px; object-fit: contain; border-radius: 6px; background: var(--dsw-alias-bg-skeleton); }
      .wb-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
      .wb-toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; margin-top: 14px; }
      .wb-input { appearance: auto; border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 6px 8px; font-size: 13px; min-width: 180px; max-width: 100%; }
      .wb-btn-sm { padding: 4px 10px; font-size: 12px; }
      .wb-page-card { display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; overflow: hidden; background: var(--dsw-alias-bg-layer-1); }
      .wb-detail { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--dsw-alias-border-l2); }
      .wb-detail-item { display: flex; align-items: center; gap: 8px; }
      .wb-detail-thumb { flex: 0 0 auto; width: 48px; height: 48px; object-fit: cover; border-radius: 4px; display: block; background: var(--dsw-alias-bg-skeleton); }
      .wb-group-notice { display: block; margin-bottom: 16px; padding: 8px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); font-size: 13px; word-break: break-all; }
    `

    // ---- 数据获取 --------------------------------------------------------
    // 直接用 fetch 打 Host 注册的 HTTP 路由。不经过 session，不需要 Remote 权限。
    // credentials: 'same-origin' —— Host 端用 connection.requestRejection 鉴权，
    // 依赖浏览器的 cookie，漏掉这个选项会一律 401。
    async function getJson(path) {
      const response = await fetch(`${API}${path}`, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`)
      }
      return response.json()
    }

    /**
     * 把 Host 的失败响应读成 `{code, message}`。
     *
     * Host 的成功/失败结构分别是 `{ok:true,...}` 与 `{ok:false,error:{code,message,retryable}}`。
     * 批量清单需要**分开**拿到 code 和 message（code 用于让用户/排查者区分
     * 「格式不支持」和「服务内部错误」，message 用于直接展示），所以这里返回对象
     * 而不是拼好的字符串；拼装交给调用方按场景决定。
     *
     * 非 JSON 响应（网关错误页之类）统一退回状态码，不假装读到了业务错误。
     */
    async function parseFailure(response) {
      try {
        const body = await response.json()
        const error = body && body.error
        if (error && typeof error.message === 'string' && error.message !== '') {
          return {
            code: typeof error.code === 'string' ? error.code : `HTTP_${response.status}`,
            message: error.message,
            retryable: error.retryable === true,
          }
        }
      } catch {
        // 落到下面的状态码兜底
      }
      return {
        code: `HTTP_${response.status}`,
        message: `HTTP ${response.status} ${response.statusText}`,
        retryable: false,
      }
    }

    /**
     * POST JSON 到 Host，**成功和失败都不抛错**，一律返回 `{ok:true, body}` 或
     * `{ok:false, error:{code,message,retryable,extra}}`。
     *
     * 为什么不复用 getJson 的 throw 风格：归组三个动作（创建页 / 附加 / 换首选）
     * 的失败里有一种是**业务状态**而非异常 —— CAPTURE_ALREADY_GROUPED 带着
     * `extra.pageId`，UI 要拿它告诉用户「这张已经属于某个页面」并刷新列表。
     * 如果走 throw，那个 pageId 只能塞进 Error 的自定义属性，调用方每处都要
     * 再解析一遍，容易漏掉 extra 而把 409 显示成一句无信息量的失败。
     */
    async function postJson(path, body) {
      try {
        const response = await fetch(`${API}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        })
        // 只读一次 body（用 text 再自己 JSON.parse），而不是先 clone 再交给
        // parseFailure：clone 在部分旧浏览器上有已知的流问题，而这里本来就要
        // 从同一个 envelope 里同时取 code/message 和 extra。
        const raw = await response.text()
        let payload = null
        try {
          payload = raw === '' ? null : JSON.parse(raw)
        } catch {
          payload = null
        }
        const envelope = payload && payload.error && typeof payload.error === 'object' ? payload.error : null
        const extra = envelope && envelope.extra && typeof envelope.extra === 'object' ? envelope.extra : null

        if (!response.ok || !payload || payload.ok !== true) {
          return {
            ok: false,
            error: {
              code: envelope && typeof envelope.code === 'string'
                ? envelope.code
                : `HTTP_${response.status}`,
              message: envelope && typeof envelope.message === 'string' && envelope.message !== ''
                ? envelope.message
                : `HTTP ${response.status} ${response.statusText}`,
              retryable: Boolean(envelope && envelope.retryable === true),
              extra,
            },
          }
        }
        return { ok: true, body: payload }
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'NETWORK_ERROR',
            message: `请求失败：${error.message}`,
            retryable: true,
            extra: null,
          },
        }
      }
    }

    /** 人类可读的字节数。 */
    function formatBytes(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—'
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      return `${(value / (1024 * 1024)).toFixed(2)} MB`
    }

    // ---- 批量导入：协议层 -------------------------------------------------

    /**
     * 上传一个文件（复用现有的单文件 raw body 协议）。
     *
     * 为什么批量不是「一个请求传多个文件」：
     *  · /wrongbook/import 的 raw body 协议已经过 112 条断言，语义是「一个请求体 =
     *    一个文件」，multipart 会引入 boundary 解析、部分失败和临时文件生命周期，
     *    而浏览器 File API 本来就能逐文件读；
     *  · 逐文件请求让「第 N/M 个、正在处理 xxx.jpg」天然成立（同一时刻只有一个在传），
     *    失败也只影响这一次请求。
     *
     * 返回统一的条目形状，**不抛错**：单个文件失败要能被批量循环当成一条结果收下，
     * 而不是让整个循环跳出。真正需要中断的只有「请求被取消」。
     *
     * @param {{subject_code: string, term_code: string}} codes 统一分类
     * @param {File} file 浏览器 File
     * @param {number} index 该文件在批次里的序号（1 基）
     * @param {AbortSignal} signal 取消信号
     * @returns {Promise<object>} 条目结果
     */
    async function uploadOne(codes, file, index, signal) {
      const query = new URLSearchParams({
        subject_code: codes.subject_code,
        term_code: codes.term_code,
        filename: file.name,
      })
      try {
        const response = await fetch(`${API}/import?${query.toString()}`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          credentials: 'same-origin',
          body: file,
          signal,
        })

        if (!response.ok) {
          // 失败响应是 Host 的结构化 envelope：把 code 一起带出来，
          // 这样 UI 不需要为「格式不支持」和「服务内部错误」写两套判断。
          const failure = await parseFailure(response)
          return { index, filename: file.name, outcome: 'failed', error: failure }
        }

        const payload = await response.json()
        if (payload.ok !== true) {
          const error = payload.error || {}
          return {
            index,
            filename: file.name,
            outcome: 'failed',
            error: {
              code: error.code ?? 'UNKNOWN',
              message: error.message ?? '导入失败',
              retryable: error.retryable === true,
            },
          }
        }
        // outcome 只可能是 imported / duplicate；Host 已保证这一点
        return { index, filename: file.name, outcome: payload.outcome, capture: payload.capture }
      } catch (error) {
        // AbortError 由调用方识别并终止循环，其余归为网络失败（这一条失败，不中断整批）
        if (error && error.name === 'AbortError') throw error
        return {
          index,
          filename: file.name,
          outcome: 'failed',
          error: { code: 'NETWORK_ERROR', message: `请求失败：${error.message}`, retryable: true },
        }
      }
    }

    /** 条目 → 展示用的标签与样式类（重复/新导入/失败三态一眼可分）。 */
    function outcomeBadge(item) {
      if (item.outcome === 'duplicate') return { text: '已存在（未复制）', className: 'wb-badge wb-badge-dup' }
      if (item.outcome === 'imported') return { text: '新导入', className: 'wb-badge wb-badge-ok' }
      return { text: '失败', className: 'wb-badge wb-badge-err' }
    }

    /**
     * 带「加载失败」可见反馈的图片。
     *
     * 为什么需要它：数据库里有一条记录，不等于归档目录里的文件还在（用户
     * 手工移动、Windows 盘掉线、上次写入后被清理）。<img> 加载失败时浏览器
     * 只画一个空白框或破图标，看起来和「加载中」没区别 —— 那就等于把坏
     * 引用伪装成成功导入（DESIGN §10.2「不得显示为成功导入」）。
     *
     * 失败时明确换成一段错误提示，并把原始 URL 以等宽小字附上，便于核对。
     */
    function SafeImage(props) {
      const [failed, setFailed] = React.useState(false)
      // URL 变了要重置：同一个组件复用到另一张图时必须重新尝试加载
      React.useEffect(() => {
        setFailed(false)
      }, [props.src])

      if (failed) {
        // 小尺寸缩略图（64px/48px）放不下完整句子，调用方可以传更短的 errorText；
        // 不传时保持原来的完整说明，避免大图上信息量下降。
        //
        // errorTag 默认 div；缩略图在 <button> 里（列表整条可点）时调用方传 'span'，
        // 因为 button 的内容模型只允许 phrasing content —— 塞 div 浏览器照样能画，
        // 但那是无效 HTML，读屏与某些表单行为会跟着变得不可预期。
        const wrapper = props.errorTag || 'div'
        return h(wrapper, { className: props.errorClassName || 'wb-img-missing' },
          h('span', { className: 'wb-err' }, props.errorText || '原件无法加载（归档文件可能已被移动或删除）'),
          h('span', { className: 'wb-mono wb-img-url' }, String(props.src || '')),
        )
      }
      return h('img', {
        className: props.className,
        src: props.src,
        alt: props.alt,
        loading: props.loading,
        onError: () => setFailed(true),
      })
    }

    // ---- 第 6 步：人工归组的展示零件 -------------------------------------

    /**
     * 归组动作的失败文案。
     *
     * CAPTURE_ALREADY_GROUPED 单独处理：它的 message 只说「已归组」，不告诉用户
     * 属于哪一页；而 Host 在 error.extra.pageId 里给了答案。把它拼进去，用户
     * 才能判断「是不是我上次已经点过、只是没看到结果」——这比一句「操作失败」
     * 有用，也避免用户反复点同一个按钮。
     */
    function groupErrorMessage(error) {
      if (!error) return '操作失败'
      if (error.code === 'CAPTURE_ALREADY_GROUPED') {
        const pageId = error.extra && error.extra.pageId
        return pageId
          ? `这张照片已经属于某个页面（页面 ID ${pageId}），没有重复归组。列表已刷新。`
          : '这张照片已经属于某个页面，没有重复归组。列表已刷新。'
      }
      return error.message
    }

    /** 时间戳 → 「2026-11-27 20:49」。手写格式化不用 toLocaleString：后者依赖
     *  浏览器 locale，同一份数据在不同机器上会显示成不同格式，截图核对时会乱。 */
    function formatDateTime(value) {
      if (typeof value !== 'string' || value === '') return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** PageCard → 「数学 · 一年级上」。两边都可能为空（历史数据没分类），
     *  用 — 占位而不是拼出「undefined」。 */
    function pageSubjectTerm(card) {
      const subject = card && card.subject ? card.subject.displayName : '—'
      const term = card && card.term ? card.term.displayName : '—'
      return `${subject} · ${term}`
    }

    /** Capture → 「1024×768 · 1.20 MB · 2026-11-27 20:49」。 */
    function captureMeta(capture) {
      if (!capture) return '—'
      const size = `${capture.width ?? '?'}×${capture.height ?? '?'} · ${formatBytes(capture.byteSize)}`
      return `${size} · ${formatDateTime(capture.createdAt)}`
    }

    /**
     * 待整理区的一条。
     *
     * 整条做成 <button>：键盘可 Tab 到、回车即选中；且不会出现「点整条」和
     * 「点里面的按钮」抢事件的问题（button 里再套 button 是非法嵌套）。
     * 所以「整理这张」做成条目内部的一段文字提示，而不是第二个按钮。
     */
    function PendingCaptureItem(props) {
      const item = props.capture
      return h('button', {
        type: 'button',
        className: props.active ? 'wb-pending-item wb-pending-item-active' : 'wb-pending-item',
        onClick: () => props.onSelect(item.id),
        'aria-pressed': props.active ? 'true' : 'false',
      },
        h(SafeImage, {
          className: 'wb-thumb',
          errorClassName: 'wb-img-missing wb-thumb-missing',
          errorText: '无法加载',
          errorTag: 'span',
          src: item.originalUrl,
          alt: item.originalFilename,
          loading: 'lazy',
        }),
        h('span', { className: 'wb-item-main' },
          h('span', { className: 'wb-item-title wb-mono' }, item.originalFilename),
          h('span', { className: 'wb-item-meta' }, captureMeta(item)),
        ),
        h('span', { className: 'wb-badge' + (props.active ? ' wb-badge-ok' : '') },
          props.active ? '已选中' : '整理这张'),
      )
    }

    /** 归组区左右并排的一侧：标题 + 图 + 元信息。 */
    function ComparePane(props) {
      const capture = props.capture
      return h('div', { className: 'wb-pane' },
        h('h3', { className: 'wb-pane-title' }, props.title),
        capture === null
          ? h('p', { className: 'wb-placeholder' }, props.emptyText || '—')
          : h(React.Fragment, null,
            h(SafeImage, {
              className: 'wb-pane-img',
              errorClassName: 'wb-img-missing wb-pane-missing',
              src: capture.originalUrl,
              alt: capture.originalFilename,
            }),
            h('div', { className: 'wb-item-meta wb-mono' }, capture.originalFilename),
            h('div', { className: 'wb-item-meta' }, captureMeta(capture)),
          ),
        props.footer || null,
      )
    }

    /** 候选页面列表里的一行。 */
    function PageCandidateRow(props) {
      const card = props.card
      const cover = card.preferredCapture
      return h('button', {
        type: 'button',
        className: props.active ? 'wb-page-row wb-page-row-active' : 'wb-page-row',
        onClick: () => props.onSelect(card.page.id),
        'aria-pressed': props.active ? 'true' : 'false',
      },
        cover === null
          ? h('span', { className: 'wb-thumb wb-thumb-empty' }, '无封面')
          : h(SafeImage, {
            className: 'wb-thumb',
            errorClassName: 'wb-img-missing wb-thumb-missing',
            errorText: '无法加载',
            errorTag: 'span',
            src: cover.originalUrl,
            alt: cover.originalFilename,
            loading: 'lazy',
          }),
        h('span', { className: 'wb-item-main' },
          h('span', { className: 'wb-item-title' }, pageSubjectTerm(card)),
          h('span', { className: 'wb-item-meta' },
            `共 ${card.captureCount} 张照片 · 最近拍摄 ${formatDateTime(card.latestCaptureAt)}`),
          card.displayCaptureSource === 'fallback'
            ? h('span', { className: 'wb-cover-tag' }, '临时封面（未选首选）')
            : null,
        ),
        props.active ? h('span', { className: 'wb-badge wb-badge-ok' }, '已选中') : null,
      )
    }

    /**
     * 页面图库的一张卡：一个 Page 一张（不是一张 Capture 一张）。
     *
     * 详情（该页全部 Capture）放在卡片内部的局部状态里，而不是提到父组件：
     * 展开/收起是纯展示状态，提上去会让父组件的 state 跟着页面数量线性增长，
     * 且一次展开只影响这一张卡。换首选成功后通过 onChanged 通知父组件刷新列表。
     */
    function PageGalleryCard(props) {
      const card = props.card
      const pageId = card.page.id
      const [open, setOpen] = React.useState(false)
      const [detail, setDetail] = React.useState(null)
      const [detailError, setDetailError] = React.useState(null)
      const [loadingDetail, setLoadingDetail] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const cover = card.preferredCapture

      const loadDetail = React.useCallback(async () => {
        setLoadingDetail(true)
        setDetailError(null)
        try {
          const payload = await getJson(`/pages/detail?page_id=${encodeURIComponent(pageId)}`)
          setDetail(payload)
        } catch (error) {
          setDetail(null)
          setDetailError(error.message)
        } finally {
          setLoadingDetail(false)
        }
      }, [pageId])

      // 每次展开都重新读一次：别的标签页/上一轮操作可能已经改过页内成员，
      // 缓存住会让用户看到过期的照片清单。
      const toggle = React.useCallback(() => {
        const next = !open
        setOpen(next)
        setNotice(null)
        if (next) loadDetail()
      }, [open, loadDetail])

      // onChanged 单独取出来放进依赖：props 对象每次渲染都是新的引用，
      // 直接依赖 props 会让这个 useCallback 每帧都重建，等于没缓存。
      const onChanged = props.onChanged

      const makePreferred = React.useCallback(async (captureId) => {
        setBusy(true)
        setNotice(null)
        try {
          const result = await postJson('/pages/preferred', { page_id: pageId, capture_id: captureId })
          if (result.ok) {
            setNotice({ kind: 'ok', text: '已更换首选照片。其他照片仍然保留。' })
            await loadDetail()
            onChanged()
          } else {
            setNotice({ kind: 'error', text: result.error.message })
          }
        } finally {
          setBusy(false)
        }
      }, [pageId, loadDetail, onChanged])

      const captures = detail && Array.isArray(detail.captures) ? detail.captures : []
      const preferredId = detail ? detail.preferredCaptureId : null

      return h('div', { className: 'wb-page-card' },
        h('button', {
          type: 'button',
          className: 'wb-page-row',
          onClick: toggle,
          'aria-expanded': open ? 'true' : 'false',
        },
          cover === null
            ? h('span', { className: 'wb-thumb wb-thumb-empty' }, '无封面')
            : h(SafeImage, {
              className: 'wb-thumb',
              errorClassName: 'wb-img-missing wb-thumb-missing',
              errorText: '无法加载',
              errorTag: 'span',
              src: cover.originalUrl,
              alt: cover.originalFilename,
              loading: 'lazy',
            }),
          h('span', { className: 'wb-item-main' },
            h('span', { className: 'wb-item-title' }, pageSubjectTerm(card)),
            h('span', { className: 'wb-item-meta' }, `共 ${card.captureCount} 张照片`),
            h('span', { className: 'wb-item-meta' },
              `最近拍摄 ${formatDateTime(card.latestCaptureAt)} · 状态 ${card.page.status}`),
            card.displayCaptureSource === 'fallback'
              ? h('span', { className: 'wb-cover-tag' }, '临时封面（未选首选）')
              : null,
          ),
          h('span', { className: 'wb-badge' }, open ? '收起' : '展开'),
        ),

        open && h('div', { className: 'wb-detail' },
          detailError && h('p', { className: 'wb-err' }, `读取页面详情失败：${detailError}`),
          loadingDetail && h('p', { className: 'wb-placeholder' }, '读取中…'),
          notice && h('span', {
            className: notice.kind === 'ok' ? 'wb-ok' : 'wb-err',
          }, notice.text),
          captures.length === 0 && !loadingDetail && h('p', { className: 'wb-placeholder' }, '这个页面还没有照片。'),
          captures.map((capture) => h('div', { className: 'wb-detail-item', key: capture.id },
            h(SafeImage, {
              className: 'wb-detail-thumb',
              errorClassName: 'wb-img-missing wb-detail-missing',
              errorText: '无法加载',
              src: capture.originalUrl,
              alt: capture.originalFilename,
              loading: 'lazy',
            }),
            h('span', { className: 'wb-item-main' },
              h('span', { className: 'wb-item-meta wb-mono' }, capture.originalFilename),
              h('span', { className: 'wb-item-meta' }, captureMeta(capture)),
            ),
            capture.id === preferredId
              ? h('span', { className: 'wb-badge wb-badge-ok' }, '当前首选')
              : h('button', {
                type: 'button',
                className: 'wb-btn wb-btn-sm',
                disabled: busy,
                onClick: () => makePreferred(capture.id),
              }, '设为首选'),
          )),
        ),
      )
    }


    // ---- 页面 ------------------------------------------------------------
    function WrongbookPage() {
      const [health, setHealth] = React.useState(null)
      const [healthError, setHealthError] = React.useState(null)
      const [loadingHealth, setLoadingHealth] = React.useState(false)

      const [dict, setDict] = React.useState(null)
      const [dictError, setDictError] = React.useState(null)
      const [loadingDict, setLoadingDict] = React.useState(false)

      // ---- 导入卡片状态 ---------------------------------------------------
      // subjectCode / termCode 初值为空串表示「还没选」，提交时在客户端先拦下，
      // 让用户看到明确提示，而不是等一次往返。
      const [subjectCode, setSubjectCode] = React.useState('')
      const [termCode, setTermCode] = React.useState('')
      const [importing, setImporting] = React.useState(false)
      const [importStatus, setImportStatus] = React.useState(null)
      const [importResult, setImportResult] = React.useState(null)
      const fileInputRef = React.useRef(null)

      // ---- 批量导入状态（DESIGN §15 第 5 步）------------------------------
      // selected[] 是「待导入队列」，一次性从文件选择器收进来，允许逐个移除。
      // 串行循环期间不再读 selected 的实时值，而是用运行时快照 —— 否则用户
      // 在中途移除/追加文件会让「第 N/M 个」的 M 在过程中变化，进度条会自己
      // 往回跳。
      const [selected, setSelected] = React.useState([])
      const [batchProgress, setBatchProgress] = React.useState(null)
      const [batchResults, setBatchResults] = React.useState([])
      const [batchNotice, setBatchNotice] = React.useState(null)
      // 取消用 AbortController：中断的是「还没开始的请求」，已完成的不撤销
      const abortRef = React.useRef(null)

      // ---- 图库卡片状态 ---------------------------------------------------
      const [captures, setCaptures] = React.useState(null)
      const [capturesError, setCapturesError] = React.useState(null)
      const [loadingCaptures, setLoadingCaptures] = React.useState(false)

      // ---- 第 6 步：待整理 / 人工归组状态 ---------------------------------
      // 待整理区单独取 limit=200 的 captures，再在前端按 pageId === null 过滤。
      // 为什么不给 /captures 加「只看未归组」的参数：那要改 Host 路由与 SQL，
      // 而这一步的验收范围只有前端；200 条足够覆盖当前数据量，且过滤逻辑
      // 放在前端也便于在列表里同时看到「已归组」的对照（当前不展示，但数据在）。
      const [pendingItems, setPendingItems] = React.useState(null)
      const [pendingError, setPendingError] = React.useState(null)
      const [loadingPending, setLoadingPending] = React.useState(false)
      // 当前待归组的 Capture id。只存 id 不存对象：刷新列表后对象会换新引用，
      // 存对象会拿着一张已经不在列表里的旧快照去比较。
      const [pendingCaptureId, setPendingCaptureId] = React.useState(null)

      // 候选页面列表 + 筛选条件。filters 是「输入中的值」，query 是「已提交的
      // 值」——分开存是为了让搜索只在点按钮/回车时生效，避免每敲一个字就发一次
      // 请求（列表会闪，且用户看到的是中间态的残缺结果）。
      //
      // candidateItems 与 galleryItems **故意分成两份状态**：搜索是「找某一页」
      // 的临时动作，页面图库是「现在有哪些页」的全景。共用一份会让用户搜一次
      // 之后图库永久只剩搜索结果，看起来像页面丢了。
      const [candidateItems, setCandidateItems] = React.useState(null)
      const [candidateError, setCandidateError] = React.useState(null)
      const [loadingCandidates, setLoadingCandidates] = React.useState(false)
      const [galleryItems, setGalleryItems] = React.useState(null)
      const [galleryError, setGalleryError] = React.useState(null)
      const [loadingGallery, setLoadingGallery] = React.useState(false)
      const [filterSubject, setFilterSubject] = React.useState('')
      const [filterTerm, setFilterTerm] = React.useState('')
      const [filterKeyword, setFilterKeyword] = React.useState('')
      const [pageQuery, setPageQuery] = React.useState({ subject_code: '', term_code: '', q: '' })

      // 选中的目标 Page（存整张卡：右侧并排图要用它的 preferredCapture）
      const [selectedPageId, setSelectedPageId] = React.useState(null)

      // 归组动作的进行中标记与结果提示。busy 是**字符串**而不是布尔：三个动作
      // 各自要有独立的按钮文案（「正在创建…」），布尔会让三个按钮同时变灰
      // 又看不出是哪个在跑。
      const [groupBusy, setGroupBusy] = React.useState(null)
      const [groupNotice, setGroupNotice] = React.useState(null)

      const checkHealth = React.useCallback(async () => {
        setLoadingHealth(true)
        setHealthError(null)
        try {
          setHealth(await getJson('/health'))
        } catch (error) {
          setHealth(null)
          setHealthError(error.message)
        } finally {
          setLoadingHealth(false)
        }
      }, [])

      const loadDictionaries = React.useCallback(async () => {
        setLoadingDict(true)
        setDictError(null)
        try {
          setDict(await getJson('/dictionaries'))
        } catch (error) {
          setDict(null)
          setDictError(error.message)
        } finally {
          setLoadingDict(false)
        }
      }, [])

      const loadCaptures = React.useCallback(async () => {
        setLoadingCaptures(true)
        setCapturesError(null)
        try {
          const payload = await getJson('/captures')
          setCaptures(Array.isArray(payload.items) ? payload.items : [])
        } catch (error) {
          setCaptures(null)
          setCapturesError(error.message)
        } finally {
          setLoadingCaptures(false)
        }
      }, [])

      // 进页面自动读一次字典：导入表单没有字典就是不可用的，
      // 让用户先点一次按钮没有意义（原有卡片的手动按钮保留不动）。
      React.useEffect(() => {
        loadDictionaries()
      }, [loadDictionaries])

      /**
       * 待整理区：GET /captures?limit=200 → 前端过滤 pageId === null。
       *
       * 不把「已归组」也算进去：待整理区回答的是「还有哪些照片没归组」，
       * 混进已归组的会让列表随每次归组变得越来越长，反而看不出还剩什么。
       */
      const loadPending = React.useCallback(async () => {
        setLoadingPending(true)
        setPendingError(null)
        try {
          const payload = await getJson('/captures?limit=200')
          const items = Array.isArray(payload.items) ? payload.items : []
          setPendingItems(items.filter((item) => item.pageId === null || item.pageId === undefined))
        } catch (error) {
          setPendingItems(null)
          setPendingError(error.message)
        } finally {
          setLoadingPending(false)
        }
      }, [])

      /**
       * 候选页面列表：GET /pages?limit=50（+ 可选的科目/学期/关键词）。
       *
       * 这些页面**只用于导航**，不是相似度推荐 —— 响应里根本没有分数，
       * 排序就是最近导入（Host 的 listPages 固定按 latest_capture_at 倒序）。
       */
      const loadCandidates = React.useCallback(async (query) => {
        setLoadingCandidates(true)
        setCandidateError(null)
        try {
          const params = new URLSearchParams({ limit: '50' })
          if (query.subject_code !== '') params.set('subject_code', query.subject_code)
          if (query.term_code !== '') params.set('term_code', query.term_code)
          if (query.q !== '') params.set('q', query.q)
          const payload = await getJson(`/pages?${params.toString()}`)
          setCandidateItems(Array.isArray(payload.items) ? payload.items : [])
        } catch (error) {
          setCandidateItems(null)
          setCandidateError(error.message)
        } finally {
          setLoadingCandidates(false)
        }
      }, [])

      /**
       * 页面图库：GET /pages?limit=50（不带筛选条件）。
       *
       * 与候选列表分开请求是刻意的：图库要回答「现在一共有哪些页」，
       * 不能被「归组」区的搜索条件影响。
       */
      const loadGallery = React.useCallback(async () => {
        setLoadingGallery(true)
        setGalleryError(null)
        try {
          const payload = await getJson('/pages?limit=50')
          setGalleryItems(Array.isArray(payload.items) ? payload.items : [])
        } catch (error) {
          setGalleryItems(null)
          setGalleryError(error.message)
        } finally {
          setLoadingGallery(false)
        }
      }, [])

      // 首屏把两块新数据都读一次：归组入口如果先要用户点「刷新」才出现，
      // 就等于把这一步藏起来了。
      React.useEffect(() => {
        loadPending()
      }, [loadPending])

      React.useEffect(() => {
        loadCandidates(pageQuery)
      }, [loadCandidates, pageQuery])

      React.useEffect(() => {
        loadGallery()
      }, [loadGallery])

      /**
       * 一次动作成功后要刷的三块数据。
       *
       * 为什么不各自刷各自那块：创建新页会同时改变「待整理」（少一条）、
       * 「候选页面」（多一页）、「页面图库」（多一张卡），漏刷任何一块都会让
       * 用户看到互相矛盾的两个界面。
       */
      const refreshAfterGroup = React.useCallback(async () => {
        await Promise.all([loadPending(), loadCandidates(pageQuery), loadGallery()])
      }, [loadPending, loadCandidates, pageQuery, loadGallery])

      /** 搜索：把输入框的值提交成查询条件。 */
      const submitPageSearch = React.useCallback(() => {
        setPageQuery({
          subject_code: filterSubject,
          term_code: filterTerm,
          q: filterKeyword.trim(),
        })
      }, [filterSubject, filterTerm, filterKeyword])

      /**
       * 「不同页，创建新页面」：POST /pages {capture_id}。
       *
       * 无论选中了哪个候选 Page 都可以用 —— 这正是本步的核心语义：
       * 系统不做自动判断，用户说不同页就新建，说同一页就附加。
       */
      const createNewPage = React.useCallback(async () => {
        if (pendingCaptureId === null || groupBusy !== null) return
        setGroupBusy('create')
        setGroupNotice(null)
        try {
          const result = await postJson('/pages', { capture_id: pendingCaptureId })
          if (result.ok) {
            setGroupNotice({ kind: 'ok', text: '已创建新页面，这张照片已放入该页面。' })
            // 这张照片已经归组，不再属于待整理；清空选中，避免用户对着
            // 一条已经不存在的条目继续操作
            setPendingCaptureId(null)
            setSelectedPageId(null)
            await refreshAfterGroup()
          } else {
            setGroupNotice({ kind: 'error', text: groupErrorMessage(result.error) })
            if (result.error.code === 'CAPTURE_ALREADY_GROUPED') await refreshAfterGroup()
          }
        } finally {
          setGroupBusy(null)
        }
      }, [pendingCaptureId, groupBusy, refreshAfterGroup])

      /** 「同一页，添加为另一张照片」：POST /pages/attach {page_id, capture_id}。 */
      const attachToPage = React.useCallback(async () => {
        if (pendingCaptureId === null || selectedPageId === null || groupBusy !== null) return
        setGroupBusy('attach')
        setGroupNotice(null)
        try {
          const result = await postJson('/pages/attach', {
            page_id: selectedPageId,
            capture_id: pendingCaptureId,
          })
          if (result.ok) {
            setGroupNotice({ kind: 'ok', text: '已添加为该页面的另一张照片。原照片全部保留。' })
            setPendingCaptureId(null)
            await refreshAfterGroup()
          } else {
            setGroupNotice({ kind: 'error', text: groupErrorMessage(result.error) })
            // 已经属于某页是真实状态而不是临时故障：刷新让用户看到真实归属，
            // 绝不能让界面停在「看起来还没归组」的样子
            if (result.error.code === 'CAPTURE_ALREADY_GROUPED') {
              setPendingCaptureId(null)
              await refreshAfterGroup()
            }
          }
        } finally {
          setGroupBusy(null)
        }
      }, [pendingCaptureId, selectedPageId, groupBusy, refreshAfterGroup])

      // 字典到了之后给下拉框一个默认值：第一项即可，减少一次点击。
      React.useEffect(() => {
        if (dict === null) return
        const subjects = dict.subjects || []
        const terms = dict.terms || []
        setSubjectCode((current) => (current === '' && subjects.length > 0 ? subjects[0].code : current))
        setTermCode((current) => (current === '' && terms.length > 0 ? terms[0].code : current))
      }, [dict])

      /**
       * 文件选择器回调：一次收进整个选择（支持多选）。
       *
       * 收进来的是一份**队列**，不是「当前文件」——批量导入的语义是「用户一次
       * 选择为整批提供目标目录」，中途允许移除个别误选（DESIGN §10.1）。
       * 每次重新选择都覆盖队列：文件选择器本身没有「追加」语义，混着加会让
       * 「第 N/M 个」的分母变得不可预期。
       */
      const handleFilesPicked = React.useCallback((event) => {
        const picked = event.target.files ? Array.from(event.target.files) : []
        setSelected(picked)
        setImportStatus(null)
        setImportResult(null)
        setBatchResults([])
        setBatchProgress(null)
        setBatchNotice(null)
      }, [])

      /** 从队列里移除一个文件（批量选择里的误选修正）。 */
      const removeSelected = React.useCallback((index) => {
        setSelected((current) => current.filter((_, position) => position !== index))
      }, [])

      /**
       * 串行批量导入（DESIGN §10.2「对选中的每个文件依次」+ §15 第 5 步）。
       *
       * 为什么串行、为什么前端循环调单文件接口：
       *  1. 32 MiB × N 并发会同时占满带宽与 pg 连接池（maxConnections=4），
       *     超过 4 个文件并行后剩下的全在排队，整体反而更慢；
       *  2. 进度反馈只有在「同一时刻只有一个文件在跑」时才有意义 ——
       *     「第 3/10 个，正在处理 xxx.jpg」比「3 个进行中」有用得多；
       *  3. 并发安全性由数据库的 uq_captures_sha256 + ON CONFLICT 兜底
       *     （DESIGN §14.1-7），不需要靠客户端并发来保证，也不该靠它验证；
       *  4. 逐文件请求让一个失败只影响一条结果，天然满足「一个失败不影响其他」。
       *
       * 关于 React 状态：每个文件之间隔着一次真实网络往返（await fetch），
       * 每次 setState 都落在不同的宏任务里，React 18 的自动批处理不会把它们
       * 合成一次渲染 —— 所以进度条会逐条推进，不需要额外 await 一个 setTimeout。
       */
      const startImport = React.useCallback(async () => {
        setImportResult(null)
        setBatchNotice(null)

        // 队列快照：串行期间用户改动 selected 不应改变本次的 M 和顺序
        const queue = selected.slice()
        if (queue.length === 0) {
          setImportStatus({ kind: 'error', text: '请先选择图片文件。' })
          return
        }
        if (subjectCode === '' || termCode === '') {
          setImportStatus({ kind: 'error', text: '请选择科目和学期。' })
          return
        }

        // 客户端预检只为省掉无用的大文件传输；权威上限仍在 Host。
        //
        // 关键：**单个**文件超限不能成为「整批不开始」的理由。
        // 一个 40 MiB 的误选夹在 9 张正常图里时，把这 9 张也一起挡下来，
        // 就等于让一个文件的错误拖垮整批 —— 那正是 DESIGN §14.4-19 与
        // 本轮「单文件失败隔离」要禁止的行为。Host 的 importBatch 对超限
        // 文件本来就是「该条 failed、其余继续」（见 verify_batch_import.mjs
        // 用例 7），UI 必须与它保持一致，否则同一个批次在两层得到两种结论。
        //
        // 唯一例外：整批**全都**超限时一条都传不了，这时提前说清楚，
        // 比让用户看 M 条一模一样的失败更有用。
        const oversized = new Set(
          queue
            .map((file, position) => (file.size > UPLOAD_MAX_BYTES ? position : -1))
            .filter((position) => position >= 0),
        )
        if (oversized.size === queue.length) {
          setImportStatus({
            kind: 'error',
            text: `所有文件都超过 ${formatBytes(UPLOAD_MAX_BYTES)} 上限，请先压缩或换文件。`,
          })
          return
        }

        const codes = { subject_code: subjectCode, term_code: termCode }
        const controller = new AbortController()
        abortRef.current = controller

        setImporting(true)
        setBatchResults([])
        // 初始进度：index 指向第一个文件，done=0，避免渲染出「第 0/M 个」或 NaN%
        setBatchProgress({ index: 1, total: queue.length, filename: queue[0].name, phase: 'start', done: 0 })
        setImportStatus({
          kind: 'pending',
          text: queue.length === 1 ? '正在上传并校验 …' : `共 ${queue.length} 个文件，正在逐个导入 …`,
        })

        const collected = []
        let aborted = false

        try {
          for (let offset = 0; offset < queue.length; offset += 1) {
            const file = queue[offset]
            if (controller.signal.aborted) {
              aborted = true
              break
            }

            // 进度必须在请求**之前**更新：用户看到「正在处理」应当早于耗时本身
            setBatchProgress({
              index: offset + 1,
              total: queue.length,
              filename: file.name,
              phase: 'start',
              done: offset,
            })

            let item
            try {
              // 单个文件超限：**不发请求**直接记为该条失败。
              // 为什么不在发请求后再拦：32 MiB 会真的开始上传，白耗带宽
              // 和服务端的一次 staging 写入，而结果必然是被 Host 以
              // PAYLOAD_TOO_LARGE 拒掉。错误码与 Host 完全同名，UI 文案统一。
              if (oversized.has(offset)) {
                item = {
                  index: offset + 1,
                  filename: file.name,
                  outcome: 'failed',
                  error: {
                    code: 'PAYLOAD_TOO_LARGE',
                    message: `超过 ${formatBytes(UPLOAD_MAX_BYTES)} 上限，请先压缩或单独处理`,
                    retryable: false,
                  },
                }
              } else {
                item = await uploadOne(codes, file, offset + 1, controller.signal)
              }
            } catch (error) {
              // uploadOne 只在 AbortError 时抛出：中断是用户意图，不是失败
              if (error && error.name === 'AbortError') {
                aborted = true
                break
              }
              throw error
            }

            collected.push(item)
            setBatchResults(collected.slice())
            setBatchProgress({
              index: offset + 1,
              total: queue.length,
              filename: file.name,
              phase: 'done',
              done: offset + 1,
            })

            // 单文件时保留原有的结果预览卡（含大图），多文件时只看清单即可 ——
            // 一次渲染 N 张大图既慢又没必要。
            if (queue.length === 1 && item.outcome !== 'failed') {
              setImportResult({ outcome: item.outcome, capture: item.capture })
            }
          }
        } finally {
          abortRef.current = null
          setImporting(false)
          setBatchProgress(null)
          // 清空文件选择器本身的值：<input type=file> 的 value 不变时，
          // 用户再选**同一个文件**不会触发 change 事件 —— 那就没法验证
          // 「重复导入显示已存在」这条验收路径了。队列展示走 selected 状态，
          // 所以清空 DOM 值不会弄丢待重试的文件。
          if (fileInputRef.current !== null) fileInputRef.current.value = ''
        }

        const imported = collected.filter((item) => item.outcome === 'imported').length
        const duplicate = collected.filter((item) => item.outcome === 'duplicate').length
        const failed = collected.filter((item) => item.outcome === 'failed').length

        if (aborted) {
          // 已完成的条目一律保留：中断不撤销任何已归档原件（DESIGN §14.4-18）
          setBatchNotice({
            kind: 'warn',
            text: `已取消。已完成 ${collected.length}/${queue.length} 个（成功 ${imported}、重复 ${duplicate}、失败 ${failed}），已导入的不会撤销。`,
          })
        } else if (failed === 0) {
          setImportStatus({
            kind: 'ok',
            text: `全部完成：新导入 ${imported} 个、重复 ${duplicate} 个。`,
          })
        } else {
          setImportStatus({
            kind: 'error',
            text: `完成 ${collected.length} 个：成功 ${imported}、重复 ${duplicate}、失败 ${failed}。失败的文件可以单独重试。`,
          })
        }

        // 队列里已处理完的条目（新导入 + 已存在）从待导入列表移走，避免下一次
        // 点击时把同一批再传一遍；只留下失败的，方便「单独重试」。
        //
        // 按**队列下标**识别，不按文件名：用户完全可能从不同目录选到同名文件
        // （手机导出常见 IMG_0001.jpg），按名字删会把根本没处理过的那个也删掉。
        // item.index 是 1 基，恰好对应本次 queue 快照里的位置。
        const processedPositions = new Set(
          collected
            .filter((item) => item.outcome === 'imported' || item.outcome === 'duplicate')
            .map((item) => item.index - 1),
        )
        setSelected((current) => {
          // 用户可能在串行期间动过队列；只有长度与快照一致时下标才可靠，
          // 否则保守地只按文件引用比对，宁可多留也不误删。
          if (current.length !== queue.length) {
            const processed = new Set(
              collected
                .filter((item) => item.outcome === 'imported' || item.outcome === 'duplicate')
                .map((item) => queue[item.index - 1]),
            )
            return current.filter((file) => !processed.has(file))
          }
          return current.filter((_, position) => !processedPositions.has(position))
        })

        // 有任何一个文件落库了就刷新图库与待整理：新导入的照片 pageId 为 null，
        // 它必须立刻出现在「待整理」里，否则用户会以为导入没成功。
        if (imported > 0 || duplicate > 0) {
          loadCaptures()
          loadPending()
        }
      }, [selected, subjectCode, termCode, loadCaptures, loadPending])

      /**
       * 只重试某一条失败的文件（把队列缩成那一条再跑一遍）。
       *
       * 按文件名匹配并保留**全部**同名项：结果显示行里只有文件名可用，
       * 而同名文件属于少数情况；重试一个已经导入过的文件是无害的
       * （哈希判重会给出 duplicate，不会复制第二份），所以宁可多带一个，
       * 也不要因为「找不到」而让用户白点一次。
       */
      const retryOne = React.useCallback((name) => {
        const targets = selected.filter((file) => file.name === name)
        if (targets.length === 0) {
          setBatchNotice({ kind: 'error', text: `「${name}」已不在待导入列表里，请重新选择文件。` })
          return
        }
        setSelected(targets)
        setBatchNotice({ kind: 'pending', text: `已把「${name}」设为唯一待导入文件，点「导入」重试。` })
      }, [selected])

      const cancelImport = React.useCallback(() => {
        if (abortRef.current !== null) abortRef.current.abort()
      }, [])

      const rows = health && health.ok ? Object.entries(health.rowCounts || {}) : []

      // ---- 第 6 步：渲染用的派生值 ---------------------------------------
      // 选中项每次都从当前列表里重新找，不缓存对象：刷新后如果这张已经归组，
      // 查找自然得到 null，界面就不会继续显示一条已不存在于待整理的对照图。
      const pendingCapture = pendingItems === null
        ? null
        : pendingItems.find((item) => item.id === pendingCaptureId) || null
      // 选中项在候选列表里找不到时再查一遍图库列表：用户可能先选了某页、
      // 再改搜索条件把它筛掉，这时右侧对照图不应该突然变空。
      const selectedPageCard = (() => {
        if (selectedPageId === null) return null
        const pools = [candidateItems, galleryItems]
        for (const pool of pools) {
          if (pool === null) continue
          const hit = pool.find((card) => card.page.id === selectedPageId)
          if (hit) return hit
        }
        return null
      })()
      // 科目/学期下拉的数据来自已加载的字典；字典没到就先给空数组，
      // 筛选框会只剩「全部」一项，不会把筛选条件卡成不可用。
      const dictSubjects = dict && Array.isArray(dict.subjects) ? dict.subjects : []
      const dictTerms = dict && Array.isArray(dict.terms) ? dict.terms : []
      const groupDisabled = groupBusy !== null

      return h('div', { className: 'wb-page' },
        h('style', null, CSS),
        h('h1', { className: 'wb-title' }, '错题本'),
        h('p', { className: 'wb-sub' }, '把手机拍的试卷归档到本地，按学期和科目浏览。'),

        // 卡片 A：单文件导入（本轮纵切面的主路径）
        h('section', { className: 'wb-card' },
          h('div', { className: 'wb-card-head' },
            h('h2', { className: 'wb-card-title' }, '导入图片'),
          ),

          dictError && h('p', { className: 'wb-err' }, `字典读取失败：${dictError}`),

          h('div', { className: 'wb-form' },
            h('div', { className: 'wb-field' },
              h('label', { className: 'wb-field-label', htmlFor: 'wb-subject' }, '科目'),
              h('select', {
                id: 'wb-subject',
                className: 'wb-select',
                value: subjectCode,
                // 批量导入的语义是「本次选择为整个批次提供目标目录和默认分类」
                // （DESIGN §10.1），所以串行循环期间不允许改分类 —— 否则同一批
                // 文件会被拆到不同目录，用户看着进度条却不知道自己在哪个科目下。
                disabled: importing || dict === null,
                onChange: (event) => setSubjectCode(event.target.value),
              },
                dict === null
                  ? h('option', { value: '' }, '读取中…')
                  : (dict.subjects || []).map((s) => h('option', { key: s.code, value: s.code }, s.display_name)),
              ),
            ),

            h('div', { className: 'wb-field' },
              h('label', { className: 'wb-field-label', htmlFor: 'wb-term' }, '学期'),
              h('select', {
                id: 'wb-term',
                className: 'wb-select',
                value: termCode,
                disabled: importing || dict === null,
                onChange: (event) => setTermCode(event.target.value),
              },
                dict === null
                  ? h('option', { value: '' }, '读取中…')
                  : (dict.terms || []).map((t) => h('option', { key: t.code, value: t.code }, t.display_name)),
              ),
            ),

            h('div', { className: 'wb-field', style: { flex: '1 1 220px' } },
              h('label', { className: 'wb-field-label', htmlFor: 'wb-file' }, '图片文件（可多选）'),
              h('input', {
                id: 'wb-file',
                className: 'wb-file',
                type: 'file',
                // 多选是本轮的核心：DESIGN §13.1「多文件选择」+ §14.1-1。
                // 仍然是 accept=image/*，但真正的格式判定在 Host 的 identify
                // （扩展名不可信，见 import-service.js 文件头）。
                accept: 'image/*',
                multiple: true,
                ref: fileInputRef,
                disabled: importing,
                onChange: handleFilesPicked,
              }),
            ),

            h('button', {
              className: 'wb-btn wb-btn-primary',
              type: 'button',
              onClick: startImport,
              disabled: importing || dict === null || selected.length === 0,
            }, importing
              ? (batchProgress !== null && batchProgress.total > 0
                ? `导入中 ${batchProgress.done ?? 0}/${batchProgress.total}`
                : '导入中…')
              : (selected.length > 1 ? `批量导入 ${selected.length} 个` : '导入')),
          ),

          // 文件队列：显示待导入清单，允许逐个移除误选
          selected.length > 0 && h('div', { className: 'wb-filelist' },
            selected.map((picked, index) => h('div', { className: 'wb-fileitem', key: `${picked.name}-${index}` },
              h('span', { className: 'wb-fileitem-name' }, picked.name),
              h('span', { className: 'wb-fileitem-size' }, formatBytes(picked.size)),
              h('button', {
                className: 'wb-fileitem-action',
                type: 'button',
                title: '从这个批次里移除',
                disabled: importing,
                onClick: () => removeSelected(index),
              }, '移除'),
            )),
          ),

          // 进度条：index/total 用真实的串行位置，而不是估算
          batchProgress !== null && batchProgress.total > 0 && h('div', { className: 'wb-progress' },
            h('div', { className: 'wb-progress-track' },
              h('div', {
                className: 'wb-progress-fill',
                style: { width: `${Math.round((batchProgress.done / batchProgress.total) * 100)}%` },
              }),
            ),
            h('div', { className: 'wb-progress-text' },
              batchProgress.phase === 'done'
                ? `已完成 ${batchProgress.done}/${batchProgress.total} 个（刚刚：${batchProgress.filename}）`
                : `第 ${batchProgress.index}/${batchProgress.total} 个，正在处理 ${batchProgress.filename}`,
            ),
          ),

          importing && h('div', { className: 'wb-status' },
            h('button', { className: 'wb-btn', type: 'button', onClick: cancelImport }, '取消剩余'),
          ),

          importStatus && h('div', { className: 'wb-status' },
            h('span', {
              className: importStatus.kind === 'error' ? 'wb-err'
                : importStatus.kind === 'ok' ? 'wb-ok' : 'wb-key',
            }, importStatus.text),
          ),

          batchNotice && h('div', { className: 'wb-status' },
            h('span', {
              className: batchNotice.kind === 'error' ? 'wb-err'
                : batchNotice.kind === 'warn' ? 'wb-warn' : 'wb-key',
            }, batchNotice.text),
          ),

          // 汇总统计：只在多文件或完成后显示；单文件失败也用清单承载，不重复展示
          batchResults.length > 0 && h('div', { className: 'wb-summary' },
            h('span', { className: 'wb-summary-item wb-ok' },
              `新导入 ${batchResults.filter((item) => item.outcome === 'imported').length}`),
            h('span', { className: 'wb-summary-item wb-key' },
              `已存在 ${batchResults.filter((item) => item.outcome === 'duplicate').length}`),
            h('span', { className: 'wb-summary-item wb-err' },
              `失败 ${batchResults.filter((item) => item.outcome === 'failed').length}`),
          ),

          // 逐条结果：每个文件独立一行，重复/新导入/失败三态用不同颜色与徽标，
          // 让用户一眼分清「这个文件以前导入过」和「这次刚导入成功」
          batchResults.length > 0 && h('div', { className: 'wb-filelist' },
            batchResults.map((item) => {
              const badge = outcomeBadge(item)
              return h('div', { className: 'wb-fileitem', key: `r-${item.index}-${item.filename}` },
                h('span', { className: 'wb-fileitem-name' },
                  `${item.index}. ${item.filename}`,
                  item.outcome === 'failed' && item.error
                    ? h('div', { className: 'wb-err-detail' },
                      `${item.error.message}（${item.error.code}）`)
                    : null,
                ),
                h('span', { className: badge.className }, badge.text),
                item.outcome === 'failed' && h('button', {
                  className: 'wb-fileitem-action',
                  type: 'button',
                  disabled: importing,
                  onClick: () => retryOne(item.filename),
                }, '重试'),
              )
            }),
          ),

          importResult && importResult.capture && h('div', { className: 'wb-preview' },
            h('div', { className: 'wb-row' },
              h('span', { className: 'wb-key' }, '结果'),
              h('span', { className: 'wb-val' }, importResult.outcome === 'duplicate' ? '已存在（未复制）' : '新导入'),
            ),
            h('div', { className: 'wb-row' },
              h('span', { className: 'wb-key' }, '分类'),
              h('span', { className: 'wb-val' },
                `${importResult.capture.subject ? importResult.capture.subject.displayName : '—'} / ${importResult.capture.term ? importResult.capture.term.displayName : '—'}`),
            ),
            h('div', { className: 'wb-row' },
              h('span', { className: 'wb-key' }, '原文件名'),
              h('span', { className: 'wb-val wb-mono' }, importResult.capture.originalFilename),
            ),
            h('div', { className: 'wb-row' },
              h('span', { className: 'wb-key' }, '尺寸 / 大小'),
              h('span', { className: 'wb-val' },
                `${importResult.capture.width ?? '?'}×${importResult.capture.height ?? '?'} · ${formatBytes(importResult.capture.byteSize)}`),
            ),
            h('div', { className: 'wb-row' },
              h('span', { className: 'wb-key' }, 'SHA-256'),
              h('span', { className: 'wb-val wb-mono' }, String(importResult.capture.sha256 || '').slice(0, 32) + '…'),
            ),
            h(SafeImage, {
              src: importResult.capture.originalUrl,
              alt: importResult.capture.originalFilename,
            }),
            h('p', { className: 'wb-note' }, '图片来自归档原件（Host 按数据库登记路径只读提供）。'),
          ),

          h('p', { className: 'wb-note' },
            `单张上限 ${formatBytes(UPLOAD_MAX_BYTES)}；只接受 JPEG / PNG。批量时逐个串行上传，` +
            '每个文件的结果独立显示：以前导入过的显示「已存在（未复制）」，不会复制第二份。'),
        ),

        // 卡片 C：待整理（第 6 步入口 —— 未归组的 Capture）
        h('section', { className: 'wb-card' },
          h('div', { className: 'wb-card-head' },
            h('h2', { className: 'wb-card-title' }, '待整理'),
            h('button', {
              className: 'wb-btn',
              type: 'button',
              onClick: loadPending,
              disabled: loadingPending,
            }, loadingPending ? '读取中…' : '刷新'),
          ),

          pendingError && h('p', { className: 'wb-err' }, `读取待整理照片失败：${pendingError}`),

          pendingItems === null && !pendingError && h('p', { className: 'wb-placeholder' }, '读取中…'),

          pendingItems !== null && pendingItems.length === 0 &&
            h('p', { className: 'wb-placeholder' }, '没有待整理的照片。新导入的照片会先出现在这里。'),

          pendingItems !== null && pendingItems.length > 0 && h('div', { className: 'wb-pending-list' },
            pendingItems.map((item) => h(PendingCaptureItem, {
              key: item.id,
              capture: item,
              active: item.id === pendingCaptureId,
              onSelect: (captureId) => {
                setPendingCaptureId(captureId)
                setGroupNotice(null)
              },
            })),
          ),

          h('p', { className: 'wb-note' },
            '这里只显示还没有归入任何页面的照片。选中一张后，下面的「归组」区会出现。'),
        ),

        // 归组结果提示放在卡片**外面**：创建/附加成功后这张照片已经不在待整理里，
        // 整个「归组」卡片会随之卸载 —— 提示若挂在卡片内部，用户就看不到
        // 「已创建新页面，这张照片已放入该页面。」这句唯一的成功反馈了。
        groupNotice && h('span', {
          className: 'wb-group-notice ' + (groupNotice.kind === 'ok' ? 'wb-ok' : 'wb-err'),
        }, groupNotice.text),

        // 卡片 D：人工归组（选中待整理照片后才出现）
        //
        // 为什么整张卡在没选中时**不渲染**而不是渲染成灰的：这一步的全部内容
        // 都是「拿 A 和 B 比」，没有 A 就没有可比的东西，先给一个空壳只会
        // 让用户以为功能坏了。
        pendingCapture !== null && h('section', { className: 'wb-card' },
          h('div', { className: 'wb-card-head' },
            h('h2', { className: 'wb-card-title' }, '归组'),
            h('button', {
              className: 'wb-btn',
              type: 'button',
              disabled: groupDisabled,
              onClick: () => {
                setPendingCaptureId(null)
                setSelectedPageId(null)
                setGroupNotice(null)
              },
            }, '取消选中'),
          ),

          h('div', { className: 'wb-split' },
            h(ComparePane, {
              title: '这张照片（待归组）',
              capture: pendingCapture,
            }),
            h(ComparePane, {
              title: '选中的页面',
              capture: selectedPageCard ? selectedPageCard.preferredCapture : null,
              // 两种「没有图」的原因不同：没选页面是用户还没动作，选了页面但没封面
              // 是那一页本身还没有照片。用同一句话会把后一种说成前一种。
              emptyText: selectedPageCard
                ? '这个页面还没有可显示的照片。'
                : '从下面选一个页面来比较，或者直接创建新页面',
              footer: selectedPageCard
                ? h('div', { className: 'wb-item-meta' },
                  `${pageSubjectTerm(selectedPageCard)} · 共 ${selectedPageCard.captureCount} 张照片`)
                : null,
            }),
          ),

          h('div', { className: 'wb-actions' },
            h('button', {
              className: 'wb-btn wb-btn-primary',
              type: 'button',
              // 未选页面时「同一页」没有目标可加，必须 disabled；
              // 而「不同页」永远是合法动作（新建），所以始终可用。
              disabled: groupDisabled || selectedPageId === null,
              onClick: attachToPage,
            }, groupBusy === 'attach' ? '正在添加…' : '同一页，添加为另一张照片'),

            h('button', {
              className: 'wb-btn',
              type: 'button',
              disabled: groupDisabled,
              onClick: createNewPage,
            }, groupBusy === 'create' ? '正在创建…' : '不同页，创建新页面'),
          ),

          h('p', { className: 'wb-note' },
            '相似度不做自动判断：系统不会自动合并任何照片，全部由你确认。'),

          // 手动搜索：关键词 + 科目 + 学期。只在提交时发请求。
          h('div', { className: 'wb-toolbar' },
            h('div', { className: 'wb-field' },
              h('label', { className: 'wb-field-label', htmlFor: 'wb-page-q' }, '关键词'),
              h('input', {
                id: 'wb-page-q',
                className: 'wb-input',
                type: 'search',
                value: filterKeyword,
                placeholder: '资料标题 / 原文件名',
                disabled: groupDisabled,
                onChange: (event) => setFilterKeyword(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') submitPageSearch()
                },
              }),
            ),

            h('div', { className: 'wb-field' },
              h('label', { className: 'wb-field-label', htmlFor: 'wb-page-subject' }, '科目'),
              h('select', {
                id: 'wb-page-subject',
                className: 'wb-select',
                value: filterSubject,
                disabled: groupDisabled,
                onChange: (event) => setFilterSubject(event.target.value),
              },
                h('option', { value: '' }, '全部科目'),
                dictSubjects.map((s) => h('option', { key: s.code, value: s.code }, s.display_name)),
              ),
            ),

            h('div', { className: 'wb-field' },
              h('label', { className: 'wb-field-label', htmlFor: 'wb-page-term' }, '学期'),
              h('select', {
                id: 'wb-page-term',
                className: 'wb-select',
                value: filterTerm,
                disabled: groupDisabled,
                onChange: (event) => setFilterTerm(event.target.value),
              },
                h('option', { value: '' }, '全部学期'),
                dictTerms.map((t) => h('option', { key: t.code, value: t.code }, t.display_name)),
              ),
            ),

            h('button', {
              className: 'wb-btn',
              type: 'button',
              disabled: loadingCandidates || groupDisabled,
              onClick: submitPageSearch,
            }, loadingCandidates ? '搜索中…' : '搜索'),
          ),

          candidateError && h('p', { className: 'wb-err' }, `读取页面列表失败：${candidateError}`),

          // 这句话必须紧贴候选列表：列表按最近导入排序，看起来很像「推荐」，
          // 不写明就一定会被当成相似度推荐（本步已确认不做自动判断）。
          h('p', { className: 'wb-note' },
            '下面是最近导入的页面，仅用于导航，不是内容相似度推荐。'),

          candidateItems !== null && candidateItems.length === 0 &&
            h('p', { className: 'wb-placeholder' }, '没有找到匹配的页面。可以直接创建新页面。'),

          candidateItems !== null && candidateItems.length > 0 && h('div', { className: 'wb-page-list' },
            candidateItems.map((card) => h(PageCandidateRow, {
              key: card.page.id,
              card,
              active: card.page.id === selectedPageId,
              onSelect: (pageId) => setSelectedPageId(pageId),
            })),
          ),
        ),

        // 卡片 E：页面图库（一个 Page 一张卡，不是一张 Capture 一张）
        h('section', { className: 'wb-card' },
          h('div', { className: 'wb-card-head' },
            h('h2', { className: 'wb-card-title' }, '页面图库'),
            h('button', {
              className: 'wb-btn',
              type: 'button',
              onClick: loadGallery,
              disabled: loadingGallery,
            }, loadingGallery ? '读取中…' : '刷新'),
          ),

          galleryError && h('p', { className: 'wb-err' }, `读取页面失败：${galleryError}`),

          galleryItems === null && !galleryError && h('p', { className: 'wb-placeholder' }, '读取中…'),

          galleryItems !== null && galleryItems.length === 0 &&
            h('p', { className: 'wb-placeholder' }, '还没有页面。先导入照片，再在「待整理」里归组。'),

          galleryItems !== null && galleryItems.length > 0 && h('div', { className: 'wb-page-list' },
            galleryItems.map((card) => h(PageGalleryCard, {
              key: card.page.id,
              card,
              // 换首选后要刷新：封面可能变了，而封面来自列表数据
              onChanged: loadGallery,
            })),
          ),

          h('p', { className: 'wb-note' },
            '一个页面可以有多张照片（同一张纸拍了两次）。展开页面可以查看全部照片并更换首选。'),
        ),

        // 卡片 B：图库
        h('section', { className: 'wb-card' },
          h('div', { className: 'wb-card-head' },
            h('h2', { className: 'wb-card-title' }, '图库'),
            h('button', {
              className: 'wb-btn',
              onClick: loadCaptures,
              disabled: loadingCaptures,
              type: 'button',
            }, loadingCaptures ? '读取中…' : '刷新'),
          ),

          capturesError && h('p', { className: 'wb-err' }, capturesError),

          captures && captures.length === 0 && h('p', { className: 'wb-placeholder' }, '还没有归档的图片。'),

          captures && captures.length > 0 && h('div', { className: 'wb-grid' },
            captures.map((item) => h('div', { className: 'wb-tile', key: item.id },
              h(SafeImage, {
                className: 'wb-tile-img',
                errorClassName: 'wb-tile-img wb-img-missing',
                src: item.originalUrl,
                alt: item.originalFilename,
                loading: 'lazy',
              }),
              h('div', { className: 'wb-tile-body' },
                h('span', { className: 'wb-tile-name' },
                  `${item.subject ? item.subject.displayName : '—'} · ${item.term ? item.term.displayName : '—'}`),
                h('span', { className: 'wb-tile-meta wb-mono' }, item.originalFilename),
                h('span', { className: 'wb-tile-meta' },
                  `${item.width ?? '?'}×${item.height ?? '?'} · ${formatBytes(item.byteSize)}`),
                h('span', { className: 'wb-badge' }, item.status),
              ),
            )),
          ),

          !captures && !capturesError && h('p', { className: 'wb-placeholder' }, '点「刷新」读取已归档的图片。'),
        ),

        // 卡片 1：数据库连接（环境自检，保留原有能力）
        h('section', { className: 'wb-card' },
          h('div', { className: 'wb-card-head' },
            h('h2', { className: 'wb-card-title' }, '数据库连接'),
            h('button', {
              className: 'wb-btn',
              onClick: checkHealth,
              disabled: loadingHealth,
              type: 'button',
            }, loadingHealth ? '检查中…' : '检查数据库连接'),
          ),

          healthError && h('div', { className: 'wb-row' },
            h('span', { className: 'wb-key' }, '请求失败'),
            h('span', { className: 'wb-val wb-err' }, healthError),
          ),

          health && health.ok && h(React.Fragment, null,
            h('div', { className: 'wb-row' },
              h('span', { className: 'wb-key' }, '状态'),
              h('span', { className: 'wb-val wb-ok' }, '已连接'),
            ),
            h('div', { className: 'wb-row' },
              h('span', { className: 'wb-key' }, '数据库'),
              h('span', { className: 'wb-val' }, `${health.database}.${health.schema}`),
            ),
            h('div', { className: 'wb-row' },
              h('span', { className: 'wb-key' }, '服务端版本'),
              h('span', { className: 'wb-val wb-mono' }, String(health.serverVersion || '').split(' ').slice(0, 2).join(' ')),
            ),
            h('div', { className: 'wb-row' },
              h('span', { className: 'wb-key' }, '业务表数量'),
              h('span', { className: 'wb-val' }, String(health.tableCount)),
            ),
            h('div', { className: 'wb-row' },
              h('span', { className: 'wb-key' }, '查询总耗时'),
              h('span', { className: 'wb-val' }, `${health.elapsedMs} ms`),
            ),
            rows.length > 0 && h('div', { style: { marginTop: '10px' } },
              h('div', { className: 'wb-key', style: { marginBottom: '6px' } }, '各表行数'),
              rows.map(([table, count]) => h('div', { className: 'wb-row', key: table },
                h('span', { className: 'wb-key wb-mono' }, table),
                h('span', { className: 'wb-val' }, String(count)),
              )),
            ),
          ),

          health && !health.ok && h(React.Fragment, null,
            h('div', { className: 'wb-row' },
              h('span', { className: 'wb-key' }, '状态'),
              h('span', { className: 'wb-val wb-err' }, '连接失败'),
            ),
            h('div', { className: 'wb-row' },
              h('span', { className: 'wb-key' }, '原因'),
              h('span', { className: 'wb-val wb-mono' }, health.error),
            ),
            health.code && h('div', { className: 'wb-row' },
              h('span', { className: 'wb-key' }, '错误码'),
              h('span', { className: 'wb-val wb-mono' }, health.code),
            ),
          ),

          !health && !healthError && h('p', { className: 'wb-placeholder' }, '还没检查过。点上面的按钮试一下。'),
        ),

        // 卡片 2：科目与学期字典
        h('section', { className: 'wb-card' },
          h('div', { className: 'wb-card-head' },
            h('h2', { className: 'wb-card-title' }, '科目与学期'),
            h('button', {
              className: 'wb-btn',
              onClick: loadDictionaries,
              disabled: loadingDict,
              type: 'button',
            }, loadingDict ? '读取中…' : '读取字典'),
          ),

          dictError && h('p', { className: 'wb-err' }, dictError),

          dict && h(React.Fragment, null,
            h('div', { className: 'wb-key', style: { marginBottom: '6px' } }, `科目（${dict.subjects.length}）`),
            dict.subjects.map((s) => h('div', { className: 'wb-row', key: s.code },
              h('span', { className: 'wb-key' }, s.display_name),
              h('span', { className: 'wb-val wb-mono' }, `${s.code} → ${s.directory_name}`),
            )),
            h('div', { className: 'wb-key', style: { margin: '14px 0 6px' } }, `学期（${dict.terms.length}）`),
            dict.terms.map((t) => h('div', { className: 'wb-row', key: t.code },
              h('span', { className: 'wb-key' }, t.display_name),
              h('span', { className: 'wb-val wb-mono' }, `${t.code} → ${t.directory_name}`),
            )),
            h('p', { className: 'wb-note' }, '目录名用于 Windows 归档路径，显示名用于界面；两者显式映射，不从显示名反推路径。'),
          ),

          !dict && !dictError && h('p', { className: 'wb-placeholder' }, '还没读取过。'),
        ),

        h('p', { className: 'wb-note' },
          '本轮已实现：批量导入（多选文件 → 逐个 SHA-256 查重 → 复制原件 → 登记 Capture → 图库可见），' +
          '重复文件显示「已存在（未复制）」且不会产生第二份原件；以及第 6 步的人工归组' +
          '（待整理 → 同一页附加 / 不同页新建 → 页面图库更换首选）。' +
          '标准化与复习留到后续步骤。',
        ),
      )
    }

    // ---- 侧栏图标 --------------------------------------------------------
    function WrongbookIcon(props) {
      const size = (props && props.size) || 18
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        // 一本翻开的作业本，右下角一个勾
        h('path', { d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z' }),
        h('path', { d: 'M11 4h7.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H11' }),
        h('path', { d: 'M13.5 12l1.6 1.6 3-3' }),
      )
    }

    // ---- 插件装配 --------------------------------------------------------
    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL, order: 8, label: () => '错题本' },
          WrongbookIcon,
        ),
      )
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL }, WrongbookPage),
      )
    }

    return {
      isPlugin: true,
      inject: ['slots'],
      apply,
    }
  },
})
