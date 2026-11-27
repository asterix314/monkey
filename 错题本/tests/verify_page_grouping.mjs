// 第 6 步 · Page 人工归组 — 归组事务与并发
//
// 覆盖范围（DESIGN §14.2 验收 8/10/11/12 的 Host 侧）：
//  · createPage 建独立 Document + pending Page，并把 Capture 挂上去
//  · attachCapture 把第二张照片挂到已有 Page，原件一张不少
//  · 并发重复归组只有一个成功，另一个 409（不能静默改挂，也不能建两个 Page）
//  · 非 registered 的 Capture 不可归组
//  · setPreferredCapture 只能在本页内切，跨页 409
//  · 全程不 DELETE、不写 status、不碰 visual_fingerprint
//
// 这个脚本用一个**带事务语义的内存池**替身（tests/lib/grouping-pool.mjs），
// 而不是 strict-mock：strict-mock 只认识导入状态机的那几条 SQL，且没有
// BEGIN/COMMIT/ROLLBACK 概念，无法验证「回滚后不留孤儿 document」。
//
// 真实 PostgreSQL 上的并发仲裁另有一次人工验证（见 plugin/README.md），
// 因为内存替身无论如何都只是「复刻」约束，不是约束本身。

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReporter, PLUGIN } from './lib/strict-mock.mjs'
import { createGroupingPool } from './lib/grouping-pool.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
void HERE

const { check, finish } = createReporter()

const { PageService, PageError } = await import(path.join(PLUGIN, 'page-service.js'))

/** 造一个 PageService，池子是带事务语义的内存替身。 */
function makeService(options = {}) {
  const pool = createGroupingPool(options)
  const service = new PageService({
    pool,
    schema: 'app',
    importService: {
      // PageService 复用 ImportService 的这两个成员，这里给出等价替身。
      captureSelect: `
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
          from app.captures c
          left join app.subjects s on s.directory_name = split_part(c.original_path, '/', 1)
          left join app.terms  t on t.directory_name = split_part(c.original_path, '/', 2)
      `,
      // PageService.translateDatabaseError 会转调它，只为了复用「连接类失败 → 503」
      // 与「非业务错误原样返回」这两条口径。这里给出等价的最小实现：
      // 连接类 SQLSTATE 归为 DATABASE_UNAVAILABLE，其余原样抛出。
      translateDatabaseError: (error) => {
        const connectionCodes = new Set(['57P01', '57P02', '57P03', '08000', '08003', '08006', '08001', '08004'])
        if (connectionCodes.has(error?.code)) {
          const wrapped = new Error('数据库暂时不可用')
          wrapped.name = 'ImportError'
          wrapped.code = 'DATABASE_UNAVAILABLE'
          wrapped.status = 503
          wrapped.retryable = true
          return wrapped
        }
        return error
      },
      presentCapture: (row) => ({
        id: row.id,
        sha256: row.sha256,
        originalPath: row.original_path,
        originalFilename: row.original_filename,
        originalUrl: `/wrongbook/originals/${String(row.original_path).split('/').map(encodeURIComponent).join('/')}`,
        mediaType: row.media_type,
        byteSize: row.byte_size === null ? null : Number(row.byte_size),
        width: row.width,
        height: row.height,
        status: row.status,
        pageId: row.page_id ?? null,
        subject: row.subject_code ? { code: row.subject_code, displayName: row.subject_display_name } : null,
        term: row.term_code ? { code: row.term_code, displayName: row.term_display_name } : null,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      }),
    },
    log: { warn() {}, info() {} },
  })
  return { pool, service }
}

/** 三张真实形状的 Capture：同科目同学期，全部 registered 且未归组。 */
const SEED = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    original_path: '数学/一年级上/20261127-161316.aaaaaaaaaaaa-1.jpg',
    original_filename: 'IMG_0001.jpg',
    status: 'registered',
    page_id: null,
    media_type: 'image/jpeg',
    byte_size: 1000,
    width: 3072,
    height: 4096,
    // 三条必须给**不同**的 created_at：都取默认值时，无论实现按升序还是降序排，
    // 稳定排序的结果都相同，「按 created_at 升序」这条断言就恒真了。
    created_at: new Date('2026-11-27T08:00:00Z'),
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    original_path: '数学/一年级上/20261127-161317.bbbbbbbbbbbb-2.jpg',
    original_filename: 'IMG_0002.jpg',
    status: 'registered',
    page_id: null,
    media_type: 'image/jpeg',
    byte_size: 2000,
    width: 3072,
    height: 4096,
    created_at: new Date('2026-11-27T08:01:00Z'),
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    original_path: '数学/一年级上/20261127-161318.cccccccccccc-3.jpg',
    original_filename: 'IMG_0003.jpg',
    status: 'registered',
    page_id: null,
    media_type: 'image/jpeg',
    byte_size: 3000,
    width: 3072,
    height: 4096,
    created_at: new Date('2026-11-27T08:02:00Z'),
  },
]

// ---------------------------------------------------------------------------
// 1. createPage：建独立 Document + pending Page
// ---------------------------------------------------------------------------
{
  const { pool, service } = makeService({ captures: SEED })
  const result = await service.createPage({ captureId: SEED[0].id })

  check('createPage 返回 outcome=created', result.outcome === 'created', JSON.stringify(result.outcome))
  check('createPage 建了恰好 1 个 document', pool.documents.size === 1, `documents=${pool.documents.size}`)
  check('createPage 建了恰好 1 个 page', pool.pages.size === 1, `pages=${pool.pages.size}`)

  const doc = [...pool.documents.values()][0]
  check('document.source_type 是 other', doc.source_type === 'other', String(doc.source_type))
  check('document.title 为 NULL', doc.title === null, String(doc.title))
  check('document.document_date 为 NULL', doc.document_date === null, String(doc.document_date))

  const page = [...pool.pages.values()][0]
  // 本步不可能 organized：trig_pages_status_transition 要求 ready 的 standardized asset
  check('page.status 是 pending（绝不能是 organized）', page.status === 'pending', String(page.status))
  check('page.page_number 为 NULL', page.page_number === null, String(page.page_number))
  check('page 的首选指向被归组的那张', page.preferred_capture_id === SEED[0].id, String(page.preferred_capture_id))

  const capture = pool.captures.get(SEED[0].id)
  check('capture.page_id 已写入', capture.page_id === page.id, String(capture.page_id))
  check('capture.status 仍是 registered（未被改动）', capture.status === 'registered', String(capture.status))
  check(
    'capture.visual_fingerprint 仍为 NULL（本步不算指纹）',
    capture.visual_fingerprint === null,
    String(capture.visual_fingerprint),
  )
  check(
    'createPage 全程没有 DELETE 语句',
    pool.statements.every((sql) => !/^\s*delete\s/i.test(sql)),
    pool.statements.filter((sql) => /^\s*delete\s/i.test(sql)).join(' | '),
  )

  // 下面两条区分「实现显式写了字面量」与「靠 schema 默认值兜」。
  // 只断言「落库值是 other / pending」是不够的：schema 的 DEFAULT 恰好也是
  // 这两个值，实现把字面量删掉，结果一模一样，断言恒真。
  // 判据改成看 SQL 文本里有没有真的出现该字面量。
  const docInsert = pool.statements.find((sql) => /insert\s+into\s+app\.documents/i.test(sql))
  check(
    "INSERT documents 显式写了 source_type 字面量 'other'（不是靠列默认值）",
    docInsert !== undefined && /source_type/i.test(docInsert) && /'other'/.test(docInsert),
    String(docInsert),
  )
  const pageInsert = pool.statements.find((sql) => /insert\s+into\s+app\.pages/i.test(sql))
  check(
    "INSERT pages 显式写了 status 字面量 'pending'（不是靠列默认值）",
    pageInsert !== undefined && /status/i.test(pageInsert) && /'pending'/.test(pageInsert),
    String(pageInsert),
  )
}

// ---------------------------------------------------------------------------
// 2. attachCapture：第二张照片挂到已有 Page，原件一张不少
// ---------------------------------------------------------------------------
{
  const { pool, service } = makeService({ captures: SEED })
  const created = await service.createPage({ captureId: SEED[0].id })
  const pageId = created.page.page.id

  const attached = await service.attachCapture({ pageId, captureId: SEED[1].id })

  check('attachCapture 返回 outcome=attached', attached.outcome === 'attached', String(attached.outcome))
  check('仍然只有 1 个 page（没有多建页）', pool.pages.size === 1, `pages=${pool.pages.size}`)
  check('仍然只有 1 个 document', pool.documents.size === 1, `documents=${pool.documents.size}`)
  check('3 张 capture 全部还在（一张都没删）', pool.captures.size === 3, `captures=${pool.captures.size}`)

  const grouped = [...pool.captures.values()].filter((row) => row.page_id === pageId)
  check('同一页下现在有 2 张 capture', grouped.length === 2, `grouped=${grouped.length}`)

  const page = pool.pages.get(pageId)
  check(
    '首选没有被第二张抢走（首张保持首选）',
    page.preferred_capture_id === SEED[0].id,
    String(page.preferred_capture_id),
  )

  const detail = await service.getPage(pageId)
  check('getPage 返回 2 张 capture', detail.captures.length === 2, `captures=${detail.captures.length}`)
  check(
    'getPage 的 capture 按 created_at 升序（第一张在前）',
    detail.captures[0].id === SEED[0].id,
    JSON.stringify(detail.captures.map((c) => c.id)),
  )
  check('getPage 的 preferredCaptureId 是首张', detail.preferredCaptureId === SEED[0].id, String(detail.preferredCaptureId))
}

// ---------------------------------------------------------------------------
// 3. attachCapture：page 无首选时，首张自动成为首选
// ---------------------------------------------------------------------------
{
  const { pool, service } = makeService({ captures: SEED })
  const created = await service.createPage({ captureId: SEED[0].id })
  const pageId = created.page.page.id
  // 手工把首选清空，模拟「页已建立但用户还没选封面」
  pool.pages.get(pageId).preferred_capture_id = null

  await service.attachCapture({ pageId, captureId: SEED[1].id })
  const page = pool.pages.get(pageId)
  check(
    '首选为 NULL 时 attach 会把首张设为首选',
    page.preferred_capture_id !== null,
    String(page.preferred_capture_id),
  )
}

// ---------------------------------------------------------------------------
// 4. 并发：同一 Capture 被两个请求同时归组，只有一个成功
// ---------------------------------------------------------------------------
{
  const { pool, service } = makeService({ captures: SEED })
  // 两个并发 createPage，各自建页并抢同一张 capture
  const settled = await Promise.allSettled([
    service.createPage({ captureId: SEED[0].id }),
    service.createPage({ captureId: SEED[0].id }),
  ])
  const fulfilled = settled.filter((entry) => entry.status === 'fulfilled')
  const rejected = settled.filter((entry) => entry.status === 'rejected')

  check('并发 createPage 只有一个成功', fulfilled.length === 1, `fulfilled=${fulfilled.length}`)
  check('另一个被拒', rejected.length === 1, `rejected=${rejected.length}`)
  check(
    '被拒的是 CAPTURE_ALREADY_GROUPED(409)',
    rejected[0]?.reason instanceof PageError &&
      rejected[0].reason.code === 'CAPTURE_ALREADY_GROUPED' &&
      rejected[0].reason.status === 409,
    rejected[0]?.reason ? `${rejected[0].reason.code}/${rejected[0].reason.status}` : 'none',
  )
  check('并发后只建了 1 个 page', pool.pages.size === 1, `pages=${pool.pages.size}`)
  check('并发后只建了 1 个 document（失败方回滚干净）', pool.documents.size === 1, `documents=${pool.documents.size}`)
  check('3 张 capture 仍在', pool.captures.size === 3, `captures=${pool.captures.size}`)
}

// ---------------------------------------------------------------------------
// 5. 已归组的 Capture 不能再归组（幂等边界）
// ---------------------------------------------------------------------------
{
  const { service } = makeService({ captures: SEED })
  const created = await service.createPage({ captureId: SEED[0].id })
  const pageId = created.page.page.id

  let error = null
  try {
    await service.createPage({ captureId: SEED[0].id })
  } catch (caught) {
    error = caught
  }
  check('重复 createPage 同一 capture 报 CAPTURE_ALREADY_GROUPED', error?.code === 'CAPTURE_ALREADY_GROUPED', String(error?.code))
  check('该错误的 extra 带当前 pageId（供 UI 直接跳转）', error?.extra?.pageId === pageId, JSON.stringify(error?.extra))

  let attachError = null
  try {
    await service.attachCapture({ pageId, captureId: SEED[0].id })
  } catch (caught) {
    attachError = caught
  }
  check('把已归组的 capture attach 到同一页也报 409', attachError?.code === 'CAPTURE_ALREADY_GROUPED', String(attachError?.code))
}

// ---------------------------------------------------------------------------
// 6. 非 registered 的 Capture 不可归组
// ---------------------------------------------------------------------------
{
  const broken = { ...SEED[0], status: 'copied' }
  const { pool, service } = makeService({ captures: [broken] })
  let error = null
  try {
    await service.createPage({ captureId: broken.id })
  } catch (caught) {
    error = caught
  }
  check('copied 状态的 capture 不可归组', error?.code === 'CAPTURE_NOT_GROUPABLE', String(error?.code))
  check('被拒后没有建 document', pool.documents.size === 0, `documents=${pool.documents.size}`)
  check('被拒后没有建 page', pool.pages.size === 0, `pages=${pool.pages.size}`)
}

// ---------------------------------------------------------------------------
// 7. setPreferredCapture：只在本页内切，跨页 409，且不删任何 Capture
// ---------------------------------------------------------------------------
{
  const { pool, service } = makeService({ captures: SEED })
  const created = await service.createPage({ captureId: SEED[0].id })
  const pageId = created.page.page.id
  await service.attachCapture({ pageId, captureId: SEED[1].id })

  const switched = await service.setPreferredCapture({ pageId, captureId: SEED[1].id })
  check('setPreferredCapture 成功', switched.preferredCaptureId === SEED[1].id, String(switched.preferredCaptureId))
  check('切首选后 capture 数量不变（不删旧照片）', pool.captures.size === 3, `captures=${pool.captures.size}`)
  check(
    '切首选后两张照片仍都在本页',
    [...pool.captures.values()].filter((row) => row.page_id === pageId).length === 2,
    'grouped',
  )

  // 第三张属于另一个页，不能拿来当本页首选
  const otherPage = await service.createPage({ captureId: SEED[2].id })
  let error = null
  try {
    await service.setPreferredCapture({ pageId, captureId: SEED[2].id })
  } catch (caught) {
    error = caught
  }
  check(
    '跨页设首选被拒 PREFERRED_CAPTURE_NOT_IN_PAGE(409)',
    error?.code === 'PREFERRED_CAPTURE_NOT_IN_PAGE' && error.status === 409,
    `${error?.code}/${error?.status}`,
  )
  check('被拒后本页首选没变', pool.pages.get(pageId).preferred_capture_id === SEED[1].id, 'unchanged')
  check('另一页仍然存在', pool.pages.has(otherPage.page.page.id), 'exists')
  // 下面两条是 M4 变异（去掉归属 `and page_id = $2` 条件）的判红点。
  // 只断言「跨页设首选抛了 409」是不够的：若归属校验被删，那一步会直接成功，
  // 本页首选就被改成了别的页的照片，而 captures 的归属也可能被连带改挂。
  // 因此必须回头检查**另一页**的状态没被动过。
  check(
    '跨页设首选被拒后，另一页自己的首选没被动过',
    pool.pages.get(otherPage.page.page.id).preferred_capture_id === SEED[2].id,
    `other preferred=${pool.pages.get(otherPage.page.page.id).preferred_capture_id}`,
  )
  check(
    '跨页设首选被拒后，第三张照片仍属原页（没被改挂）',
    pool.captures.get(SEED[2].id).page_id === otherPage.page.page.id,
    String(pool.captures.get(SEED[2].id).page_id),
  )
}

// ---------------------------------------------------------------------------
// 8. 事务回滚：document 已插入但 page 插入失败时不留孤儿
// ---------------------------------------------------------------------------
{
  const { pool, service } = makeService({
    captures: SEED,
    faults: { failPageInsert: true },
  })
  let error = null
  try {
    await service.createPage({ captureId: SEED[0].id })
  } catch (caught) {
    error = caught
  }
  check('page 插入失败时 createPage 抛错', error !== null, 'no error thrown')
  check('回滚后 document 计数为 0（没有孤儿 document）', pool.documents.size === 0, `documents=${pool.documents.size}`)
  check('回滚后 page 计数为 0', pool.pages.size === 0, `pages=${pool.pages.size}`)
  check('回滚后 capture 仍未归组', pool.captures.get(SEED[0].id).page_id === null, String(pool.captures.get(SEED[0].id).page_id))
}

// ---------------------------------------------------------------------------
// 9. 分类无法反查时 422，且不留半截数据
// ---------------------------------------------------------------------------
{
  const orphan = { ...SEED[0], original_path: '不存在的科目/一年级上/20261127-161316.aaaaaaaaaaaa-1.jpg' }
  const { pool, service } = makeService({ captures: [orphan] })
  let error = null
  try {
    await service.createPage({ captureId: orphan.id })
  } catch (caught) {
    error = caught
  }
  check('字典查不到分类时报 CLASSIFICATION_UNRESOLVED(422)', error?.code === 'CLASSIFICATION_UNRESOLVED' && error.status === 422, `${error?.code}/${error?.status}`)
  check('分类失败后没有建 document', pool.documents.size === 0, `documents=${pool.documents.size}`)
  check('分类失败后没有建 page', pool.pages.size === 0, `pages=${pool.pages.size}`)
}

// ---------------------------------------------------------------------------
// 9b. 事务收尾：每个事务都必须显式 COMMIT 或 ROLLBACK
//
// 这一条不能靠「回滚后没有孤儿 document」来证明：mock 的 overlay 在没 COMMIT 时
// 本来就会被丢弃，所以孤儿断言无论如何都会过。真正能判红的是「连接被归还时
// 事务是否已收尾」——真实 PostgreSQL 下漏收尾会把中止事务留在池化连接上，
// 被下一个复用者 COMMIT 时孤儿数据照样落库。
// ---------------------------------------------------------------------------
{
  const { pool, service } = makeService({ captures: SEED })
  const created = await service.createPage({ captureId: SEED[0].id })
  await service.attachCapture({ pageId: created.page.page.id, captureId: SEED[1].id })
  await service.setPreferredCapture({ pageId: created.page.page.id, captureId: SEED[1].id })

  check(
    '成功路径上每个事务都显式收尾（没有漏 COMMIT/ROLLBACK 的连接）',
    pool.leakedTransactions === 0,
    `leaked=${pool.leakedTransactions} detail=${JSON.stringify(pool.leakedDetail)}`,
  )

  // 失败路径同样必须收尾
  const failing = makeService({ captures: SEED, faults: { failPageInsert: true } })
  try {
    await failing.service.createPage({ captureId: SEED[0].id })
  } catch {
    // 预期抛错
  }
  check(
    '失败路径上事务也被显式收尾（ROLLBACK 没有漏）',
    failing.pool.leakedTransactions === 0,
    `leaked=${failing.pool.leakedTransactions} detail=${JSON.stringify(failing.pool.leakedDetail)}`,
  )
  // leakedTransactions 只在 release() 被调用时计数，测不到「从不 release」。
  // 这条补上那个盲区：借出与归还必须配平。
  check(
    '成功路径上连接全部归还（借出数与归还数配平）',
    pool.openConnections === 0,
    `open=${pool.openConnections}`,
  )
  check(
    '失败路径上连接全部归还',
    failing.pool.openConnections === 0,
    `open=${failing.pool.openConnections}`,
  )
}

// ---------------------------------------------------------------------------
// 9c. 未归组列表：只返回 registered 且 page_id 为 NULL 的 Capture
//
// 这条覆盖 listUngroupedCaptures。之前 59 条断言里没有一条走这个查询，
// 于是「mock 是否替实现补 status='registered' 条件」这件事根本没被测到。
// ---------------------------------------------------------------------------
{
  const mixed = [
    { ...SEED[0], id: '44444444-4444-4444-8444-444444444444', status: 'registered', page_id: null },
    { ...SEED[1], id: '55555555-5555-4555-8555-555555555555', status: 'copied', page_id: null },
    { ...SEED[2], id: '66666666-6666-4666-8666-666666666666', status: 'registered', page_id: 'some-page' },
  ]
  const { service } = makeService({ captures: mixed })
  const { items } = await service.listUngroupedCaptures({ limit: 50 })

  check('未归组列表只返回 1 条（只有那张 registered 且未归组的）', items.length === 1, `len=${items.length}`)
  check(
    '未归组列表排除了 copied 状态的 Capture',
    items.every((item) => item.status === 'registered'),
    JSON.stringify(items.map((item) => item.status)),
  )
  check(
    '未归组列表排除了已归组的 Capture',
    items.every((item) => item.pageId === null),
    JSON.stringify(items.map((item) => item.pageId)),
  )
  check(
    '未归组列表里的正是那张合格的照片',
    items[0]?.id === '44444444-4444-4444-8444-444444444444',
    String(items[0]?.id),
  )
}

// ---------------------------------------------------------------------------
// 10. 全局卫生断言：任何一次成功归组都不改 status、不写指纹、不 DELETE
// ---------------------------------------------------------------------------
{
  const { pool, service } = makeService({ captures: SEED })
  const created = await service.createPage({ captureId: SEED[0].id })
  await service.attachCapture({ pageId: created.page.page.id, captureId: SEED[1].id })
  await service.setPreferredCapture({ pageId: created.page.page.id, captureId: SEED[1].id })

  const allSql = pool.statements.join('\n')
  check('全程没有 DELETE 语句', !/\bdelete\s+from\b/i.test(allSql), 'found DELETE')
  // 逐条判定，不要用 [^;]* 跨语句匹配：归一化后的 SQL 不含分号，`[^;]*` 会
  // 一路吃到后面 SELECT 里的 p.status，产生假阳性（初版就是这么误报的）。
  // 判据收紧为「语句以 update ... pages 开头，且 set 子句里出现 status」。
  const statusWrite = pool.statements.find(
    (sql) => /^update\s+app\.pages\b/i.test(sql) && /\bset\b[\s\S]*\bstatus\s*=/i.test(sql),
  )
  check('全程没有 UPDATE pages SET status', statusWrite === undefined, String(statusWrite))
  check(
    '全程没有写 visual_fingerprint',
    !/visual_fingerprint/i.test(allSql),
    'found fingerprint write',
  )
  check(
    '全程没有 organized 字面量',
    !/'organized'/.test(allSql),
    'found organized',
  )
  check(
    '所有 captures 的 UPDATE 都带 page_id is null 乐观条件',
    pool.statements
      .filter((sql) => /update\s+app\.captures/i.test(sql))
      .every((sql) => /page_id\s+is\s+null/i.test(sql)),
    pool.statements.filter((sql) => /update\s+app\.captures/i.test(sql)).join(' | '),
  )
}

const ok = finish()
process.exit(ok ? 0 : 1)
