// 批量导入验证（DESIGN §15 第 5 步 / §13.1 / §14.1）。
//
// 只覆盖 importBatch 这一层的行为契约，不重复 verify_e2e_mock.mjs 已经验证过的
// 单文件细节（那里 66 条断言仍然是 importOne 的权威回归网）：
//   · 串行顺序：进度事件的 index 严格 1..N，而且 start 早于该文件的实际处理
//   · 单文件失败隔离：一个坏文件不影响其后的文件，已成功的不回滚
//   · 重复检测：同一批次里出现同一个文件两次 → 第二次 duplicate，且只有一份原件
//   · 汇总统计：imported / duplicate / failed 三个计数与 items 一致
//   · 整批失败：科目非法 → ImportBatchError，且一个文件都没碰
//   · 进度回调抛错不得把已成功的导入变成失败
//
// 全部走 mock 池 + 临时目录，不连数据库、不碰真实归档目录。

import { Readable } from 'node:stream'
import { readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import {
  PLUGIN,
  createReporter,
  createStrictMock,
  listArchiveFiles,
  makePngs,
  makeTempDir,
} from './lib/strict-mock.mjs'

const { ImportService, ImportBatchError, ImportError } = await import(`${PLUGIN}/import-service.js`)

const { check, finish } = createReporter()

const service = (mock, root) =>
  new ImportService({
    pool: mock,
    schema: 'app',
    originalsRoot: root,
    uploadMaxBytes: 33554432,
    identifyTimeoutMs: 10000,
    log: { warn() {}, info() {}, error() {} },
  })

/** 把 Buffer 包成一个「一次性可读流」，模拟一次上传的请求体。 */
const asStream = (buffer) => Readable.from([buffer])

const root = makeTempDir('wb-batch-')
const fixtureDir = makeTempDir('wb-batch-fixtures-')

try {
  // 四张互不相同的 PNG：A/B/C 正常，D 是「不是图片」的伪 jpg
  const pngs = makePngs(fixtureDir, [
    { width: 120, height: 90 },
    { width: 100, height: 80, color: 'red' },
    { width: 60, height: 40, color: 'blue' },
  ])
  const notImage = Buffer.from('这不是图片，只是一段文本（用来触发 identify 失败）\n', 'utf8')

  // =========================================================================
  // 用例 1：三个正常文件串行导入 → 全部 imported，进度有序、结果条数一致
  // =========================================================================
  {
    const mock = createStrictMock()
    const svc = service(mock, root)
    const events = []

    const result = await svc.importBatch({
      subjectCode: 'math',
      termCode: 'g1t1',
      files: [
        { filename: 'a.png', stream: asStream(pngs[0].buffer), contentLength: pngs[0].buffer.length, label: 'a.png' },
        { filename: 'b.png', stream: asStream(pngs[1].buffer), contentLength: pngs[1].buffer.length, label: 'b.png' },
        { filename: 'c.png', stream: asStream(pngs[2].buffer), contentLength: pngs[2].buffer.length, label: 'c.png' },
      ],
      onProgress: (event) => events.push(event),
    })

    check('批量 3 个正常文件 → items 长度 3', result.items.length === 3, `(${result.items.length})`)
    check(
      '三个文件全部 imported',
      result.items.every((item) => item.outcome === 'imported'),
      JSON.stringify(result.items.map((item) => item.outcome)),
    )
    check(
      '汇总统计：imported=3 / duplicate=0 / failed=0',
      result.totals.imported === 3 && result.totals.duplicate === 0 && result.totals.failed === 0,
      JSON.stringify(result.totals),
    )

    // 串行顺序：done 事件的 index 必须是 1,2,3（乱序或并发就会暴露）
    const doneIndexes = events.filter((event) => event.phase === 'done').map((event) => event.index)
    check(
      '进度 done 事件按 1,2,3 严格有序（证明串行，不是并发）',
      JSON.stringify(doneIndexes) === JSON.stringify([1, 2, 3]),
      JSON.stringify(doneIndexes),
    )
    // 每个文件必须是 start → done 交替：若是并发，会出现 start,start,done,done
    const phases = events.map((event) => event.phase)
    check(
      '进度事件 start/done 成对交替（start 早于该文件处理）',
      JSON.stringify(phases) === JSON.stringify(['start', 'done', 'start', 'done', 'start', 'done']),
      JSON.stringify(phases),
    )
    check(
      '进度事件带「第 N/M 个 + 文件名」所需字段',
      events.every((event) => Number.isInteger(event.index) && Number.isInteger(event.total) && event.total === 3) &&
        events[0].filename === 'a.png' && events[2].filename === 'b.png',
      JSON.stringify(events.map((event) => [event.index, event.total, event.filename])),
    )

    // 文件系统侧：三个文件 → 三个归档原件，且都在 math/g1t1 下
    const archived = listArchiveFiles(root)
    check('三个文件 → 三个归档原件', archived.length === 3, JSON.stringify(archived))
    check(
      '归档都落在 数学/一年级上/ 下',
      archived.every((relPath) => relPath.startsWith('数学/一年级上/')),
      JSON.stringify(archived),
    )
    check('每条结果的 capture 都带 originalUrl', result.items.every((item) => typeof item.capture?.originalUrl === 'string'))

    // 串行的证据二：INSERT 尝试次数 === 文件数（并发重试会出现更多）
    check('每个文件只尝试一次预留（无并发重试）', mock.stats.insertAttempts === 3, `(${mock.stats.insertAttempts})`)
  }

  // =========================================================================
  // 用例 2：中间一个坏文件 → 该条 failed，其余 imported，已成功的保留
  // =========================================================================
  {
    const mock = createStrictMock()
    const svc = service(mock, root)
    const events = []

    const result = await svc.importBatch({
      subjectCode: 'chinese',
      termCode: 'g1t2',
      files: [
        { filename: 'ok-1.png', stream: asStream(pngs[0].buffer), contentLength: pngs[0].buffer.length },
        { filename: 'broken.jpg', stream: asStream(notImage), contentLength: notImage.length },
        { filename: 'ok-2.png', stream: asStream(pngs[1].buffer), contentLength: pngs[1].buffer.length },
      ],
      onProgress: (event) => events.push(event),
    })

    check('坏文件不中断批量：items 仍是 3 条', result.items.length === 3, `(${result.items.length})`)
    check(
      '中间坏文件 → 该条 failed，前后两条 imported',
      result.items[0].outcome === 'imported' &&
        result.items[1].outcome === 'failed' &&
        result.items[2].outcome === 'imported',
      JSON.stringify(result.items.map((item) => item.outcome)),
    )
    check(
      '失败条目带 error.code / message / retryable',
      typeof result.items[1].error?.code === 'string' &&
        result.items[1].error.code !== '' &&
        typeof result.items[1].error?.message === 'string' &&
        result.items[1].error.message !== '' &&
        typeof result.items[1].error?.retryable === 'boolean',
      JSON.stringify(result.items[1].error),
    )
    check(
      '失败条目不带 capture（不谎报有记录）',
      result.items[1].capture === undefined,
      JSON.stringify(result.items[1].capture),
    )
    check(
      '汇总统计：imported=2 / failed=1',
      result.totals.imported === 2 && result.totals.failed === 1 && result.totals.duplicate === 0,
      JSON.stringify(result.totals),
    )
    check(
      '失败之后仍然继续处理了第 3 个（进度 done 有 3 条，index 到 3）',
      events.filter((event) => event.phase === 'done').length === 3 &&
        events.filter((event) => event.phase === 'done').at(-1).index === 3,
      JSON.stringify(events.filter((event) => event.phase === 'done').map((event) => event.index)),
    )

    // 关键：失败不回滚已成功的
    const archived = listArchiveFiles(root).filter((relPath) => relPath.startsWith('语文/一年级下/'))
    check('坏文件不产生归档原件，好文件的两个都在（不整体回滚）', archived.length === 2, JSON.stringify(archived))
    check('两条成功的 capture 都是 registered', result.items[0].capture?.status === 'registered' && result.items[2].capture?.status === 'registered')
  }

  // =========================================================================
  // 用例 3：同一批次里同一个文件出现两次 → 第二次 duplicate，只有一份原件
  // =========================================================================
  {
    const mock = createStrictMock()
    const svc = service(mock, root)
    const before = listArchiveFiles(root)

    const result = await svc.importBatch({
      subjectCode: 'english',
      termCode: 'g1t1',
      files: [
        { filename: 'same.png', stream: asStream(pngs[2].buffer), contentLength: pngs[2].buffer.length },
        // 改名再传一次：哈希相同，必须判重复（DESIGN §11.1「同一文件被改名」）
        { filename: 'same-renamed.png', stream: asStream(pngs[2].buffer), contentLength: pngs[2].buffer.length },
      ],
    })

    check(
      '同批次重复文件 → 第一条 imported、第二条 duplicate',
      result.items[0].outcome === 'imported' && result.items[1].outcome === 'duplicate',
      JSON.stringify(result.items.map((item) => item.outcome)),
    )
    check(
      'duplicate 与 imported 指向同一条 Capture（同一个 id）',
      result.items[0].capture.id === result.items[1].capture.id,
      `(${result.items[0].capture.id} vs ${result.items[1].capture.id})`,
    )
    check(
      'duplicate 保留第一次的原文件名（不按新名字改写）',
      result.items[1].capture.originalFilename === 'same.png',
      result.items[1].capture.originalFilename,
    )
    check(
      '汇总统计：imported=1 / duplicate=1',
      result.totals.imported === 1 && result.totals.duplicate === 1 && result.totals.failed === 0,
      JSON.stringify(result.totals),
    )
    const after = listArchiveFiles(root)
    check('重复文件只产生一份归档原件', after.length === before.length + 1, `${before.length} → ${after.length}`)
    check(
      '数据库里同哈希只有一行',
      [...mock.rows.values()].filter((row) => row.sha256hex === pngs[2].sha256).length === 1,
      `(${[...mock.rows.values()].filter((row) => row.sha256hex === pngs[2].sha256).length})`,
    )
    check('第二次预留是冲突（ON CONFLICT 生效，只赢一次）', mock.stats.insertAttempts === 2 && mock.stats.insertWins === 1,
      `attempts=${mock.stats.insertAttempts} wins=${mock.stats.insertWins}`)
  }

  // =========================================================================
  // 用例 4：整批参数非法 → ImportBatchError，一个文件都没碰
  // =========================================================================
  {
    const mock = createStrictMock()
    const svc = service(mock, root)
    const before = listArchiveFiles(root)
    let caught = null
    try {
      await svc.importBatch({
        subjectCode: 'nope',
        termCode: 'g1t1',
        files: [{ filename: 'a.png', stream: asStream(pngs[0].buffer) }],
      })
    } catch (error) {
      caught = error
    }

    check('科目非法 → 抛 ImportBatchError', caught instanceof ImportBatchError, `${caught?.name}`)
    check('ImportBatchError 也是 ImportError（路由层只认一种类型）', caught instanceof ImportError)
    check(
      '整批失败的 code 是 INVALID_SUBJECT_CODE / status 400',
      caught?.code === 'INVALID_SUBJECT_CODE' && caught?.status === 400,
      `(${caught?.code}/${caught?.status})`,
    )
    check('整批失败时没有任何预留语句', mock.stats.insertAttempts === 0, `(${mock.stats.insertAttempts})`)
    check('整批失败时没有新归档文件', listArchiveFiles(root).length === before.length)
    check('整批失败时 items 为空（没有处理过任何文件）', Array.isArray(caught?.items) && caught.items.length === 0)
  }

  // 空文件列表同样属于「整批无法开始」
  {
    const mock = createStrictMock()
    const svc = service(mock, root)
    let caught = null
    try {
      await svc.importBatch({ subjectCode: 'math', termCode: 'g1t1', files: [] })
    } catch (error) {
      caught = error
    }
    check('空文件列表 → ImportBatchError(INVALID_BATCH/400)',
      caught instanceof ImportBatchError && caught.code === 'INVALID_BATCH' && caught.status === 400,
      `(${caught?.code}/${caught?.status})`)
  }

  // =========================================================================
  // 用例 5：进度回调抛错不得把已成功的导入变成失败
  // =========================================================================
  {
    const mock = createStrictMock()
    const svc = service(mock, root)
    const before = listArchiveFiles(root)

    const result = await svc.importBatch({
      subjectCode: 'math',
      termCode: 'g1t1',
      files: [
        { filename: 'p1.png', stream: asStream(pngs[0].buffer), contentLength: pngs[0].buffer.length },
        { filename: 'p2.png', stream: asStream(pngs[1].buffer), contentLength: pngs[1].buffer.length },
      ],
      // UI 卸载后回调会失效；它抛错不能让业务状态回滚
      onProgress: () => {
        throw new Error('React 已卸载，回调不可用')
      },
    })

    check('进度回调抛错仍完整跑完两个文件', result.items.length === 2, `(${result.items.length})`)
    check('回调抛错不影响 outcome（仍全是 imported）',
      result.items.every((item) => item.outcome === 'imported'),
      JSON.stringify(result.items.map((item) => item.outcome)))
    check('回调抛错时文件仍然真的归档了', listArchiveFiles(root).length === before.length + 2,
      `${before.length} → ${listArchiveFiles(root).length}`)
  }

  // =========================================================================
  // 用例 6：失败的文件只影响自己 —— 后续文件仍能正确判重
  // （证明失败分支没有把 captures 表写成半条脏数据挡住后面的正常导入）
  // =========================================================================
  {
    const mock = createStrictMock()
    const svc = service(mock, root)

    const result = await svc.importBatch({
      subjectCode: 'math',
      termCode: 'g1t1',
      files: [
        { filename: 'bad.jpg', stream: asStream(notImage), contentLength: notImage.length },
        { filename: 'good.png', stream: asStream(pngs[2].buffer), contentLength: pngs[2].buffer.length },
        { filename: 'good-again.png', stream: asStream(pngs[2].buffer), contentLength: pngs[2].buffer.length },
      ],
    })

    check(
      '失败 → 成功 → 重复：三态各自正确',
      result.items[0].outcome === 'failed' &&
        result.items[1].outcome === 'imported' &&
        result.items[2].outcome === 'duplicate',
      JSON.stringify(result.items.map((item) => item.outcome)),
    )
    check(
      '前面失败不影响后面判重（good-again 与 good 同 id）',
      result.items[1].capture.id === result.items[2].capture.id,
    )
  }

  // =========================================================================
  // 用例 7：单个文件超限 → 该条 failed，不影响同批其他文件
  // =========================================================================
  {
    const mock = createStrictMock()
    const svc = service(mock, root)
    // 同一个 root 被多个用例复用，所以只断言本用例的**增量**，不断言绝对数量
    const before = listArchiveFiles(root).length

    const result = await svc.importBatch({
      subjectCode: 'math',
      termCode: 'g1t1',
      files: [
        { filename: 'small.png', stream: asStream(pngs[0].buffer), contentLength: pngs[0].buffer.length },
        { filename: 'huge.png', stream: asStream(pngs[0].buffer), contentLength: 33554433 },
        { filename: 'small-2.png', stream: asStream(pngs[1].buffer), contentLength: pngs[1].buffer.length },
      ],
    })

    check(
      '超限文件 → 该条 failed，前后仍 imported',
      result.items[0].outcome === 'imported' &&
        result.items[1].outcome === 'failed' &&
        result.items[2].outcome === 'imported',
      JSON.stringify(result.items.map((item) => item.outcome)),
    )
    check('超限错误码是 PAYLOAD_TOO_LARGE',
      result.items[1].error?.code === 'PAYLOAD_TOO_LARGE', result.items[1].error?.code)
    check('超限文件不落盘（只多出 2 个归档原件）',
      listArchiveFiles(root).length === before + 2,
      `${before} → ${listArchiveFiles(root).length}`)
  }

  // =========================================================================
  // 用例 8：取消（signal.aborted）→ 只停止新文件，已完成的不撤销
  // =========================================================================
  {
    const mock = createStrictMock()
    const svc = service(mock, root)
    const before = listArchiveFiles(root)
    const signal = { aborted: false }

    const result = await svc.importBatch({
      subjectCode: 'math',
      termCode: 'g1t1',
      files: [
        { filename: 'c1.png', stream: asStream(pngs[0].buffer), contentLength: pngs[0].buffer.length },
        { filename: 'c2.png', stream: asStream(pngs[1].buffer), contentLength: pngs[1].buffer.length },
        { filename: 'c3.png', stream: asStream(pngs[2].buffer), contentLength: pngs[2].buffer.length },
      ],
      onProgress: (event) => {
        // 第一个文件完成后用户点了取消
        if (event.phase === 'done' && event.index === 1) signal.aborted = true
      },
      signal,
    })

    check('取消后只处理了已开始的那个文件', result.items.length === 1, `(${result.items.length})`)
    check('取消不撤销已完成的那条', result.items[0].outcome === 'imported', result.items[0].outcome)
    check('取消后已完成的文件仍然在归档里（原件不可变）',
      listArchiveFiles(root).length === before.length + 1,
      `${before.length} → ${listArchiveFiles(root).length}`)
    check('取消后 totals.total 仍是原始队列长度（UI 能算出剩余）', result.totals.total === 3, `(${result.totals.total})`)
  }

  // =========================================================================
  // 用例 9：last_error 现场 —— 失败文件留下可恢复的线索，且不泄露绝对路径
  // =========================================================================
  {
    const mock = createStrictMock()
    const svc = service(mock, root)
    // 用一张「能过 staging 探测、但归档后探测失败」的文件不好构造，
    // 这里改用失败发生在预留之后的方式：让 markCopied 抛连接错误。
    mock.faults.failMarkCopied = true

    const result = await svc.importBatch({
      subjectCode: 'math',
      termCode: 'g1t1',
      files: [{ filename: 'fault.png', stream: asStream(pngs[0].buffer), contentLength: pngs[0].buffer.length }],
    })
    mock.faults.failMarkCopied = false

    check('DB 在 markCopied 阶段失败 → 该条 failed', result.items[0].outcome === 'failed', result.items[0].outcome)
    check(
      '失败条目错误码是 DATABASE_UNAVAILABLE(503)',
      result.items[0].error?.code === 'DATABASE_UNAVAILABLE' && result.items[0].error?.status === 503,
      `(${result.items[0].error?.code}/${result.items[0].error?.status})`,
    )
    const row = [...mock.rows.values()].find((candidate) => candidate.sha256hex === pngs[0].sha256)
    check('失败现场被保留（reserved 行还在，没被删）', row !== undefined, '行被删了')
    check('失败现场写了 last_error（可恢复线索）',
      typeof row?.last_error === 'string' && row.last_error !== '', String(row?.last_error))
    check('last_error 不含本机绝对路径',
      !String(row?.last_error).includes(root), String(row?.last_error))
    check('失败但原件已发布（不删除已归档原件）',
      listArchiveFiles(root).some((relPath) => relPath.startsWith('数学/一年级上/')),
      JSON.stringify(listArchiveFiles(root)))
  }
} finally {
  rmSync(root, { recursive: true, force: true })
  rmSync(fixtureDir, { recursive: true, force: true })
}

process.exit(finish() ? 0 : 1)
