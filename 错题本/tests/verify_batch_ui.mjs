// 批量导入 UI 的渲染冒烟验证（DESIGN §13.1「每张文件的处理状态」「精确重复提示」）。
//
// 这不是 DOM 测试，也不启动浏览器。做法是：用一份极小的 React 替身
// （createElement / useState / useRef / useEffect / useCallback）在 vm 里加载
// client.js，然后直接调用主组件，把返回的元素树压成文本再断言关键文案。
//
// 为什么值得单独写：批量 UI 的核心验收点全是**文案**——
//   「第 N/M 个，正在处理 xxx.jpg」、「已存在（未复制）」、「新导入」、「失败 + 原因」、
//   「重试」。这些字串在实现里是拼出来的，只有真的 render 一次才能发现
//   「进度条算了但因为变量名写错一直显示 0/0」这类问题。
//
// 局限（写清楚，避免虚假信心）：它不验证样式、布局、交互时序；
// 那些必须靠真实浏览器验收。

import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.resolve(HERE, '../plugin/wrongbook/client.js')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ← ${detail}`}`)
}

/**
 * 极简 React 替身。
 *
 * useState 与 useCallback/useRef/useEffect 各自独立编号 —— 真实 React 里它们
 * 共享 hook 链表，但这里是为了「让测试能精确设置某几个 useState 的值」，
 * 混在一起会让索引非常脆弱。这处偏离只影响测试写法，不影响被测组件。
 */
function createFakeReact() {
  let stateSlots = []
  let stateCursor = 0
  let otherCursor = 0
  /** 每次 useState setter 的写入历史：`{index, value}`。用于验证「逐文件增量更新」。 */
  const history = []
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const index = stateCursor++
      if (stateSlots.length <= index) {
        stateSlots[index] = typeof initial === 'function' ? initial() : initial
      }
      return [
        stateSlots[index],
        (next) => {
          const value = typeof next === 'function' ? next(stateSlots[index]) : next
          stateSlots[index] = value
          history.push({ index, value })
        },
      ]
    },
    useRef(initial) {
      otherCursor += 1
      return { current: initial }
    },
    useEffect() {
      otherCursor += 1
    },
    useCallback(fn) {
      otherCursor += 1
      return fn
    },
    /** 测试专用：按 useState 调用顺序整体设置状态 */
    __setStates(values) {
      stateSlots = values.slice()
      stateCursor = 0
      otherCursor = 0
      history.length = 0
    },
    __beginRender() {
      stateCursor = 0
      otherCursor = 0
    },
    /** 测试专用：读取写入历史（副本，避免被后续写入改动）。 */
    __history() {
      return history.slice()
    },
  }
}

/** 收集所有 <button> 的可见文本（用来数「重试」「移除」这类按钮）。 */
function buttonsOf(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) buttonsOf(child, out)
    return out
  }
  if (node.type === 'button') out.push(textOf(node))
  buttonsOf(node.children, out)
  return out
}

/**
 * 收集所有「三态徽标」（className 含 wb-badge）的可见文本。
 *
 * 为什么必须按元素而不能再对整个页面做 text.includes：
 * 页面底部的说明文字里本身就写着「以前导入过的显示『已存在（未复制）』」，
 * 于是 `text.includes('已存在（未复制）')` 在徽标文案被改坏时**依然为真** ——
 * 这条断言等于什么都没测（已用变异验证确认过：把徽标文案改成「已存在」，
 * 旧写法仍然 24/24 全绿）。所以徽标类断言一律走这个函数，只测徽标本身。
 */
function badgesOf(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) badgesOf(child, out)
    return out
  }
  const className = node.props && typeof node.props.className === 'string' ? node.props.className : ''
  if (/\bwb-badge\b/.test(className)) out.push(textOf(node))
  badgesOf(node.children, out)
  return out
}

/** 元素树 → 纯文本。 */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('\n')
  return textOf(node.children)
}

const React = createFakeReact()
let plugin = null
const sandbox = {
  require: (name) => (name === 'react' ? React : {}),
  window: {
    __ModuleLoader__: {
      load: ({ factory }) => {
        plugin = factory(sandbox.require)
      },
    },
  },
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  AbortController,
  URLSearchParams,
}
vm.createContext(sandbox)
vm.runInContext(readFileSync(CLIENT, 'utf8'), sandbox, { filename: 'client.js' })

check('client.js 能被模块加载器解析', plugin !== null && plugin.isPlugin === true)
check('插件只声明 slots 依赖（不 require Harness Client 包）',
  Array.isArray(plugin?.inject) && plugin.inject.length === 1 && plugin.inject[0] === 'slots')

let MainComponent = null
plugin.apply({
  slots: {
    inject: (name, fn) => fn(),
    register: (options, component) => {
      if (options.name === 'main') MainComponent = component
      return () => {}
    },
  },
})
check('主组件通过 main slot 注册', typeof MainComponent === 'function')

/** 渲染一次并返回可见文本。 */
function renderNodes(states) {
  React.__beginRender()
  React.__setStates(states)
  React.__beginRender()
  return MainComponent()
}

function render(states) {
  return textOf(renderNodes(states))
}

// ---- 1. 初始状态：没有选文件，批量入口存在但不可点 -------------------
{
  const text = render([null, null, false, null, null, false, 'math', 'g1t1', false, null, null, [], null, [], null, null, null, false])
  check('初始渲染含「导入图片」卡片标题', text.includes('导入图片'), text.slice(0, 120))
  check('文件选择器标注可多选', text.includes('图片文件（可多选）'))
  check('初始渲染说明批量是串行上传', text.includes('批量时逐个串行上传'))
  check('没有选文件时不显示进度条', !text.includes('正在处理'), text.slice(0, 200))
}

// ---- 2. 选了 3 个文件：队列可见、可逐个移除 --------------------------
{
  const files = [
    { name: 'a.jpg', size: 1024 },
    { name: 'b.jpg', size: 2 * 1024 * 1024 },
    { name: 'c.jpg', size: 3000 },
  ]
  const text = render([null, null, false, null, null, false, 'math', 'g1t1', false, null, null, files, null, [], null, null, null, false])
  check('队列显示全部 3 个文件名', text.includes('a.jpg') && text.includes('b.jpg') && text.includes('c.jpg'))
  check('队列显示文件大小（人类可读）', text.includes('2.00 MB') && text.includes('1.0 KB'), text.slice(0, 400))
  check('每个队列项有「移除」按钮（按钮数 = 3）',
    buttonsOf(renderNodes([null, null, false, null, null, false, 'math', 'g1t1', false, null, null, files, null, [], null, null, null, false]))
      .filter((label) => label === '移除').length === 3)
  check('按钮文案反映数量（批量导入 3 个）', text.includes('批量导入 3 个'))
}

// ---- 3. 进行中：第 N/M 个 + 文件名 + 取消 -------------------------------
{
  const files = [{ name: 'a.jpg', size: 1 }, { name: 'b.jpg', size: 1 }, { name: 'c.jpg', size: 1 }]
  const text = render([
    null, null, false,
    null, null, false,
    'math', 'g1t1',
    true,                                  // importing
    { kind: 'pending', text: '共 3 个文件，正在逐个导入 …' },
    null,
    files,
    { index: 2, total: 3, filename: 'b.jpg', phase: 'start', done: 1 },
    [{ index: 1, filename: 'a.jpg', outcome: 'imported', capture: {} }],
    null,
    null, null, false,
  ])
  check('进度文案是「第 2/3 个，正在处理 b.jpg」', text.includes('第 2/3 个，正在处理 b.jpg'), text.slice(0, 300))
  check('进行中显示「取消剩余」', text.includes('取消剩余'))
  check('按钮显示 1/3 进度', text.includes('导入中 1/3'))
}

// ---- 4. 完成：三态徽标 + 汇总 + 失败重试 ------------------------------
{
  const text = render([
    null, null, false,
    null, null, false,
    'math', 'g1t1',
    false,
    { kind: 'error', text: '完成 3 个：成功 1、重复 1、失败 1。失败的文件可以单独重试。' },
    null,
    [{ name: 'c.jpg', size: 1 }],
    null,
    [
      { index: 1, filename: 'a.jpg', outcome: 'imported', capture: {} },
      { index: 2, filename: 'b.jpg', outcome: 'duplicate', capture: {} },
      { index: 3, filename: 'c.jpg', outcome: 'failed', error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '不支持的图片格式：GIF' } },
    ],
    null,
    null, null, false,
  ])
  // 三态断言必须落在**徽标元素**上（理由见 badgesOf 的注释）：
  // 页面说明文字里也含这些词，用整页文本断言等于没测。
  const badges = badgesOf(renderNodes([
    null, null, false,
    null, null, false,
    'math', 'g1t1',
    false,
    { kind: 'error', text: '完成 3 个：成功 1、重复 1、失败 1。失败的文件可以单独重试。' },
    null,
    [{ name: 'c.jpg', size: 1 }],
    null,
    [
      { index: 1, filename: 'a.jpg', outcome: 'imported', capture: {} },
      { index: 2, filename: 'b.jpg', outcome: 'duplicate', capture: {} },
      { index: 3, filename: 'c.jpg', outcome: 'failed', error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '不支持的图片格式：GIF' } },
    ],
    null,
    null, null, false,
  ]))
  check('徽标恰好三个（每条结果一个）', badges.length === 3, JSON.stringify(badges))
  check('新导入条目显示「新导入」', badges.includes('新导入'), JSON.stringify(badges))
  check('重复条目显示「已存在（未复制）」', badges.includes('已存在（未复制）'), JSON.stringify(badges))
  // 「已存在」单独出现是不合格的：必须明确传达「没有复制第二份」
  check('重复徽标不能只是「已存在」（必须写明未复制）',
    !badges.some((text) => text === '已存在'), JSON.stringify(badges))
  check('失败条目显示「失败」', badges.includes('失败'), JSON.stringify(badges))
  check('汇总统计三个计数都在', text.includes('新导入 1') && text.includes('已存在 1') && text.includes('失败 1'),
    text.slice(0, 400))
  check('失败条目显示原因与错误码',
    text.includes('不支持的图片格式：GIF') && text.includes('UNSUPPORTED_MEDIA_TYPE'))
  // 数按钮而不是数字符串：汇总文案里也出现了「重试」一词
  const buttons = buttonsOf(renderNodes([
    null, null, false,
    null, null, false,
    'math', 'g1t1',
    false,
    { kind: 'error', text: '完成 3 个：成功 1、重复 1、失败 1。失败的文件可以单独重试。' },
    null,
    [{ name: 'c.jpg', size: 1 }],
    null,
    [
      { index: 1, filename: 'a.jpg', outcome: 'imported', capture: {} },
      { index: 2, filename: 'b.jpg', outcome: 'duplicate', capture: {} },
      { index: 3, filename: 'c.jpg', outcome: 'failed', error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '不支持的图片格式：GIF' } },
    ],
    null,
    null, null, false,
  ]))
  check('只有失败的那一条有「重试」按钮（按钮数 = 1）',
    buttons.filter((label) => label === '重试').length === 1,
    JSON.stringify(buttons))
  check('完成的条目带序号（1. 2. 3.）',
    text.includes('1. a.jpg') && text.includes('2. b.jpg') && text.includes('3. c.jpg'))
}

// ---- 5. 取消后：保留已完成的结果，提示不撤销 -------------------------
{
  const text = render([
    null, null, false,
    null, null, false,
    'math', 'g1t1',
    false,
    null,
    null,
    [{ name: 'b.jpg', size: 1 }],
    null,
    [{ index: 1, filename: 'a.jpg', outcome: 'imported', capture: {} }],
    { kind: 'warn', text: '已取消。已完成 1/3 个（成功 1、重复 0、失败 0），已导入的不会撤销。' },
    null, null, false,
  ])
  check('取消提示明确「已导入的不会撤销」', text.includes('已导入的不会撤销'))
  check('取消后已完成的条目仍然列出', text.includes('a.jpg'))
  check('取消后不显示进度条（已停止）', !text.includes('正在处理'))
}

// ---- 6. 真正执行一遍批量循环：必须是串行，且失败被隔离 ----------------
//
// 上面 1~5 全部是**静态渲染**断言：它们只证明「给定状态能渲染出正确文案」，
// 从不执行 startImport 里的循环。变异验证暴露过这个问题——把 client.js 的
// 串行 for 循环换成 Promise.all 并发，上面 24 条一条都不会红。
// 而「前端串行」正是本轮最关键的设计决策（planner 决策 1）。
//
// 所以这里真的调用一次导入按钮的 onClick，用一个会记录「同时在途请求数」的
// fetch 替身去观察实际并发度。maxInFlight 必须恒为 1。

/** 在元素树里找第一个 className 含指定类的节点。 */
function findByClass(node, token) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByClass(child, token)
      if (found !== null) return found
    }
    return null
  }
  const className = node.props && typeof node.props.className === 'string' ? node.props.className : ''
  if (className.split(/\s+/).includes(token)) return node
  return findByClass(node.children, token)
}

/** 让出一个宏任务，给「并发请求」留出真正重叠的机会。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

/**
 * 造一个可观测的 fetch 替身。
 *
 * @param {{failAt?: number}} [options] failAt=n 时第 n 个（1 基）上传返回业务失败
 * @returns {{fetch: Function, stat: object}} fetch 与观测数据
 */
function makeObservingFetch({ failAt = 0 } = {}) {
  const stat = { order: [], maxInFlight: 0, inFlight: 0, uploads: 0, captureReads: 0 }
  async function observingFetch(url) {
    // 图库刷新走 GET /captures，不属于「上传」，单独计数以免干扰串行断言
    if (String(url).includes('/captures')) {
      stat.captureReads += 1
      return { ok: true, json: async () => ({ ok: true, items: [] }) }
    }
    stat.uploads += 1
    const index = stat.uploads
    const name = decodeURIComponent(new URL(url, 'http://x').searchParams.get('filename') || '')
    stat.order.push(name)
    stat.inFlight += 1
    stat.maxInFlight = Math.max(stat.maxInFlight, stat.inFlight)
    // 故意拉开每次请求的耗时，让并发实现一定会出现 inFlight > 1
    await tick()
    stat.inFlight -= 1

    if (index === failAt) {
      return {
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        json: async () => ({ ok: false, error: { code: 'IMAGE_PROBE_FAILED', message: '无法识别该文件是否为受支持的图片', retryable: false } }),
      }
    }
    return {
      ok: true,
      json: async () => ({ ok: true, outcome: 'imported', capture: { id: `cap-${index}`, originalFilename: name } }),
    }
  }
  return { fetch: observingFetch, stat }
}

/** 渲染出「已选 3 个文件」的导入卡片，并返回主按钮的 onClick。 */
function renderImportButton(files) {
  const states = [
    null, null, false,      // health / healthError / loadingHealth
    null, null, false,      // dict / dictError / loadingDict
    'math', 'g1t1',         // subjectCode / termCode
    false,                  // importing
    null,                   // importStatus
    null,                   // importResult
    files,                  // selected
    null,                   // batchProgress
    [],                     // batchResults
    null,                   // batchNotice
    null, null, false,      // captures / capturesError / loadingCaptures
  ]
  const nodes = renderNodes(states)
  const button = findByClass(nodes, 'wb-btn-primary')
  return button === null ? null : button.props.onClick
}

{
  const files = [
    { name: 'a.jpg', size: 10 },
    { name: 'b.jpg', size: 20 },
    { name: 'c.jpg', size: 30 },
  ]
  const original = sandbox.fetch
  const { fetch: observingFetch, stat } = makeObservingFetch()
  sandbox.fetch = observingFetch
  try {
    const onClick = renderImportButton(files)
    check('批量导入按钮可被触发（拿到 onClick）', typeof onClick === 'function', String(typeof onClick))
    await onClick()
  } finally {
    sandbox.fetch = original
  }

  check('批量循环真的发出了 3 次上传', stat.uploads === 3, `(${stat.uploads})`)
  check(
    '串行：同时在途的上传请求数恒为 1（并发实现会 > 1）',
    stat.maxInFlight === 1,
    `maxInFlight=${stat.maxInFlight}`,
  )
  check(
    '串行：按队列顺序逐个上传（a→b→c）',
    JSON.stringify(stat.order) === JSON.stringify(['a.jpg', 'b.jpg', 'c.jpg']),
    JSON.stringify(stat.order),
  )
}

{
  // 中间那个文件失败 → 其余两个仍然被上传（单文件失败隔离）
  const files = [
    { name: 'ok-1.jpg', size: 10 },
    { name: 'broken.jpg', size: 20 },
    { name: 'ok-2.jpg', size: 30 },
  ]
  const original = sandbox.fetch
  const { fetch: observingFetch, stat } = makeObservingFetch({ failAt: 2 })
  sandbox.fetch = observingFetch
  try {
    await renderImportButton(files)()
  } finally {
    sandbox.fetch = original
  }
  check('中间文件失败后仍然上传了第 3 个（失败隔离）', stat.uploads === 3, `(${stat.uploads})`)
  check(
    '失败隔离下顺序不变（ok-1→broken→ok-2）',
    JSON.stringify(stat.order) === JSON.stringify(['ok-1.jpg', 'broken.jpg', 'ok-2.jpg']),
    JSON.stringify(stat.order),
  )
  check('失败隔离下仍然是串行', stat.maxInFlight === 1, `maxInFlight=${stat.maxInFlight}`)
}

// client.js 内部的单张上限常量（33554432 = 32 MiB，与 Host config 默认值一致）。
// 测试里复制这个数是为了构造「恰好超限」的 File 替身；client.js 若改了上限，
// 这里必须同步，否则第 7 节会测不到超限路径（会在断言里直接暴露）。
const UPLOAD_MAX_BYTES = 33554432

// ---- 7. 单文件超限不拖垮整批（与 Host 的隔离语义对齐）------------------
//
// 这里的断言对着一个真实发生过的缺陷：预检曾用 `oversized.length > 0`
// 直接 return，于是 9 张正常图 + 1 张 40 MiB 误选 = 整批一个都不传。
// Host 的 importBatch 对超限文件是「该条 failed、其余继续」
// （verify_batch_import.mjs 用例 7），两层必须给出同一个结论。
{
  const tooBig = UPLOAD_MAX_BYTES + 1
  const files = [
    { name: 'ok-1.jpg', size: 10 },
    { name: 'huge.jpg', size: tooBig },
    { name: 'ok-2.jpg', size: 30 },
  ]
  const original = sandbox.fetch
  const { fetch: observingFetch, stat } = makeObservingFetch()
  sandbox.fetch = observingFetch
  try {
    await renderImportButton(files)()
  } finally {
    sandbox.fetch = original
  }
  check('超限文件不阻断整批：两个正常文件仍然上传', stat.uploads === 2, `(${stat.uploads})`)
  check(
    '超限文件根本不发请求（不白耗带宽）',
    !stat.order.includes('huge.jpg'),
    JSON.stringify(stat.order),
  )
  check(
    '超限只影响自己：正常文件仍按顺序上传',
    JSON.stringify(stat.order) === JSON.stringify(['ok-1.jpg', 'ok-2.jpg']),
    JSON.stringify(stat.order),
  )
}

{
  // 全批都超限 → 一条都不该发，且要给出明确提示（这是唯一允许提前中止的情况）
  const tooBig = UPLOAD_MAX_BYTES + 1
  const files = [
    { name: 'h1.jpg', size: tooBig },
    { name: 'h2.jpg', size: tooBig },
  ]
  const original = sandbox.fetch
  const { fetch: observingFetch, stat } = makeObservingFetch()
  sandbox.fetch = observingFetch
  try {
    await renderImportButton(files)()
  } finally {
    sandbox.fetch = original
  }
  check('全批都超限 → 一个请求都不发', stat.uploads === 0, `(${stat.uploads})`)
}

// ---- 8. 逐文件增量更新（不等全部完成）+ 导入期间分类锁定 ---------------
//
// 验收清单第 3 条要求「每文件完成即更新 UI」，第 2 条要求「批量模式下下拉框禁用」。
// 这两条都无法靠静态渲染验证：前者是**时序**（results 是否在整批结束前就在增长），
// 后者要在 importing=true 的状态下读 select 的 disabled。
{
  const files = [
    { name: 'a.jpg', size: 10 },
    { name: 'b.jpg', size: 20 },
    { name: 'c.jpg', size: 30 },
  ]
  const original = sandbox.fetch
  // 每次上传**开始**时记录「此刻 batchResults 的长度」。
  //
  // 采样点必须放在下一个请求开始时，而不是本次请求返回时：
  // 本次请求返回后 UI 才把这条 push 进 results，紧接着才发起下一个请求。
  // 于是「第 N 个请求开始时的长度」正好等于「前 N-1 个已经进到结果里的条数」。
  // 若实现是「全部完成再一次性 set」，这个序列会恒为 0。
  const resultsLengthAtEachStart = []
  const stat = { uploads: 0 }

  /** batchResults 在 WrongbookPage 的 useState 顺序里的下标（见文件头 hook 顺序）。 */
  const BATCH_RESULTS_SLOT = 13

  async function observingFetch(url) {
    if (String(url).includes('/captures')) {
      return { ok: true, json: async () => ({ ok: true, items: [] }) }
    }
    stat.uploads += 1
    const index = stat.uploads
    const name = decodeURIComponent(new URL(url, 'http://x').searchParams.get('filename') || '')
    const writes = React.__history().filter((entry) => entry.index === BATCH_RESULTS_SLOT)
    resultsLengthAtEachStart.push(writes.length === 0 ? 0 : (writes.at(-1).value?.length ?? 0))
    await tick()
    return {
      ok: true,
      json: async () => ({ ok: true, outcome: 'imported', capture: { id: `cap-${index}`, originalFilename: name } }),
    }
  }

  sandbox.fetch = observingFetch
  try {
    await renderImportButton(files)()
  } finally {
    sandbox.fetch = original
  }

  // 第 1 个开始时 0 条、第 2 个开始时 1 条、第 3 个开始时 2 条 → 结果是一条条长出来的
  check(
    '每文件完成即更新：第 2 个开始时第 1 个已在结果里（不是等全部完成）',
    resultsLengthAtEachStart[1] === 1,
    JSON.stringify(resultsLengthAtEachStart),
  )
  check(
    '每文件完成即更新：开始时结果条数 0→1→2（逐条递增）',
    JSON.stringify(resultsLengthAtEachStart) === JSON.stringify([0, 1, 2]),
    JSON.stringify(resultsLengthAtEachStart),
  )
  // 收尾后三条都在
  const finalWrites = React.__history().filter((entry) => entry.index === BATCH_RESULTS_SLOT)
  check(
    '批量结束后结果共 3 条',
    (finalWrites.at(-1)?.value?.length ?? 0) === 3,
    String(finalWrites.at(-1)?.value?.length),
  )
}

{
  // 导入中：两个下拉框必须禁用（否则同一批会被拆到不同科目目录）
  const files = [{ name: 'a.jpg', size: 10 }]
  const nodes = renderNodes([
    null, null, false,
    { subjects: [{ code: 'math', display_name: '数学' }], terms: [{ code: 'g1t1', display_name: '一年级上' }] },
    null, false,
    'math', 'g1t1',
    true,                                   // importing = true
    { kind: 'pending', text: '正在上传并校验 …' },
    null,
    files,
    { index: 1, total: 1, filename: 'a.jpg', phase: 'start', done: 0 },
    [], null,
    null, null, false,
  ])
  const selects = []
  ;(function collect(node) {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(collect)
    if (node.type === 'select') selects.push(node)
    collect(node.children)
  })(nodes)
  check('导入中有两个下拉框（科目 + 学期）', selects.length === 2, `(${selects.length})`)
  check(
    '导入中科目/学期下拉框都被禁用（分类在整批内锁定）',
    selects.length === 2 && selects.every((node) => node.props.disabled === true),
    JSON.stringify(selects.map((node) => node.props.disabled)),
  )
}

// ---- 9. 批量结束后自动刷新图库（验收清单第 10 条）--------------------
//
// 用户导完一批就该在图库里看到它们，不需要再点一次「刷新」。
// 同时验证反面：一条都没落库（全失败）时不该白刷一次。
{
  const files = [{ name: 'a.jpg', size: 10 }, { name: 'b.jpg', size: 20 }]
  const original = sandbox.fetch

  // 场景 1：全部成功 → 必须刷新图库
  const ok = makeObservingFetch()
  sandbox.fetch = ok.fetch
  try {
    await renderImportButton(files)()
  } finally {
    sandbox.fetch = original
  }
  check('批量成功后自动刷新图库（GET /captures 至少一次）', ok.stat.captureReads >= 1, `(${ok.stat.captureReads})`)

  // 场景 2：全部失败 → 不该刷新（没有新图可看）
  const boom = makeObservingFetch({ failAt: 1 })
  // 让第 1、2 个都失败：把 failAt 逻辑扩展为「全失败」
  const failingFetch = async (url) => {
    if (String(url).includes('/captures')) {
      boom.stat.captureReads += 1
      return { ok: true, json: async () => ({ ok: true, items: [] }) }
    }
    boom.stat.uploads += 1
    await tick()
    return {
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      json: async () => ({ ok: false, error: { code: 'IMAGE_PROBE_FAILED', message: '无法识别', retryable: false } }),
    }
  }
  sandbox.fetch = failingFetch
  try {
    await renderImportButton(files)()
  } finally {
    sandbox.fetch = original
  }
  check('全部失败时不刷新图库（没有新图可看）', boom.stat.captureReads === 0, `(${boom.stat.captureReads})`)
}

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
