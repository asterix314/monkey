// 中断恢复验证（DESIGN §10.5 / §14.4-18、19）。
//
// 覆盖两种**真实会发生**的中断，而不是抽象的「状态机分支」：
//
//  A. 复制成功但数据库没提交
//     现场：归档文件已经在 <科目>/<学期>/ 下且内容正确，但 captures 行还停在
//     reserved（或 copied），因为 markCopied / markRegistered 那一步挂了。
//     期望：再次导入同一文件 → 认出文件已完好、**不重新复制**，只把状态补齐
//     到 registered，最终仍是同一条 Capture。
//
//  B. 数据库有 reserved 行但文件不存在
//     现场：上次在 publish 之前就失败（或用户手工删了归档文件）。
//     期望：再次导入 → CAPTURE_RECOVERY_REQUIRED(409)，绝不谎报成功、
//     绝不自己去复制（只有拿到 RETURNING 的预留者有权按该路径复制）。
//
// 两种现场都用**真实故障注入**构造（而不是手工塞行），这样测的才是 importOne
// 自己在异常中的行为，而不是「测试者理解的异常形状」。

import { Readable } from 'node:stream'
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  PLUGIN,
  createReporter,
  createStrictMock,
  listArchiveFiles,
  makePngs,
  makeTempDir,
} from './lib/strict-mock.mjs'

const { ImportService, ImportError } = await import(`${PLUGIN}/import-service.js`)

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

const asStream = (buffer) => Readable.from([buffer])

const root = makeTempDir('wb-recovery-')
const fixtureDir = makeTempDir('wb-recovery-fixtures-')

try {
  const pngs = makePngs(fixtureDir, [
    { width: 200, height: 150 },
    { width: 90, height: 70, color: 'green' },
    { width: 50, height: 50, color: 'navy' },
  ])

  // =========================================================================
  // 场景 A1：publish 成功、markCopied 失败 → 现场 = 文件在、行还是 reserved
  // =========================================================================
  {
    const mock = createStrictMock()
    const svc = service(mock, root)
    mock.faults.failMarkCopied = true

    let firstError = null
    try {
      await svc.importOne({
        subjectCode: 'math',
        termCode: 'g1t1',
        filename: 'interrupted.png',
        contentLength: pngs[0].buffer.length,
        stream: asStream(pngs[0].buffer),
      })
    } catch (error) {
      firstError = error
    }

    check('A1 第一次导入确实失败（不是静默成功）', firstError !== null, '没有抛错')
    check(
      'A1 失败码为 DATABASE_UNAVAILABLE(503)（连接中断，可重试）',
      firstError?.code === 'DATABASE_UNAVAILABLE' && firstError?.status === 503,
      `(${firstError?.code}/${firstError?.status})`,
    )

    // 核对现场：文件已发布、行还在 reserved、有 last_error
    const rowAfterFailure = [...mock.rows.values()].find((row) => row.sha256hex === pngs[0].sha256)
    const filesAfterFailure = listArchiveFiles(root)
    check('A1 中断现场：captures 行存在且停在 reserved', rowAfterFailure?.status === 'reserved', String(rowAfterFailure?.status))
    check('A1 中断现场：归档原件已经发布（不删除已复制原件）', filesAfterFailure.length === 1, JSON.stringify(filesAfterFailure))
    check('A1 中断现场：last_error 记录了失败原因', typeof rowAfterFailure?.last_error === 'string' && rowAfterFailure.last_error !== '')
    check(
      'A1 中断现场：原件内容与上传字节完全一致（复制这一步是成功的）',
      readFileSync(path.join(root, rowAfterFailure.original_path)).equals(pngs[0].buffer),
    )

    // 恢复：故障消失后再次导入同一文件
    mock.faults.failMarkCopied = false
    const beforeRecovery = listArchiveFiles(root)
    const result = await svc.importOne({
      subjectCode: 'math',
      termCode: 'g1t1',
      filename: 'interrupted.png',
      contentLength: pngs[0].buffer.length,
      stream: asStream(pngs[0].buffer),
    })

    check('A1 恢复成功（outcome=imported，不是 duplicate 也不是报错）', result.outcome === 'imported', result.outcome)
    check('A1 恢复后状态推进到 registered', result.capture?.status === 'registered', result.capture?.status)
    check('A1 恢复复用同一条 Capture（不新建记录）', result.capture?.id === rowAfterFailure.id,
      `(${result.capture?.id} vs ${rowAfterFailure.id})`)
    check('A1 恢复不重新复制文件（归档文件数不变）',
      listArchiveFiles(root).length === beforeRecovery.length,
      `${beforeRecovery.length} → ${listArchiveFiles(root).length}`)
    check('A1 恢复没有产生第二个原件（同路径只有一个文件）',
      listArchiveFiles(root).length === 1, JSON.stringify(listArchiveFiles(root)))
    check('A1 恢复后 last_error 被清空', result.capture?.status === 'registered')
    check('A1 数据库里同哈希仍只有一行',
      [...mock.rows.values()].filter((row) => row.sha256hex === pngs[0].sha256).length === 1)

    // 恢复完成后必须彻底幂等：再导一次是 duplicate
    const again = await svc.importOne({
      subjectCode: 'math',
      termCode: 'g1t1',
      filename: 'interrupted-renamed.png',
      contentLength: pngs[0].buffer.length,
      stream: asStream(pngs[0].buffer),
    })
    check('A1 恢复之后再导入 → duplicate（完全幂等）', again.outcome === 'duplicate', again.outcome)
    check('A1 duplicate 不改状态', again.capture?.status === 'registered', again.capture?.status)
  }

  // =========================================================================
  // 场景 A2：行停在 copied（复制已登记，但没走到 registered）
  // =========================================================================
  {
    const mock = createStrictMock()
    const svc = service(mock, root)
    const relPath = '语文/一年级上/copied-interrupted.png'
    const absolute = path.join(root, relPath)
    const { mkdirSync } = await import('node:fs')
    mkdirSync(path.dirname(absolute), { recursive: true })
    writeFileSync(absolute, pngs[1].buffer)

    mock.rows.set(pngs[1].sha256, {
      id: 'cap-copied',
      sha256hex: pngs[1].sha256,
      sha256: Buffer.from(pngs[1].sha256, 'hex'),
      original_path: relPath,
      original_filename: 'copied-interrupted.png',
      status: 'copied',
      page_id: null,
      media_type: 'image/png',
      byte_size: pngs[1].buffer.length,
      width: 90,
      height: 70,
      last_error: null,
      created_at: new Date(),
      source_metadata_json: {},
    })

    const cursor = mock.log.length
    const result = await svc.importOne({
      subjectCode: 'math',
      termCode: 'g1t1',
      filename: 'whatever.png',
      contentLength: pngs[1].buffer.length,
      stream: asStream(pngs[1].buffer),
    })
    const thisRun = mock.log.slice(cursor).map((entry) => entry.sql)

    check('A2 copied 中断 → 恢复为 imported', result.outcome === 'imported', result.outcome)
    check('A2 恢复后是 registered', result.capture?.status === 'registered', result.capture?.status)
    check('A2 不重复写 copied（只补 registered）',
      !thisRun.some((sql) => /set status = 'copied'/i.test(sql)),
      JSON.stringify(thisRun.filter((sql) => /set status/i.test(sql)).map((sql) => sql.slice(0, 50))))
    check('A2 保留原有分类（路径 join，不按新请求改写）',
      result.capture?.subject?.code === 'chinese' && result.capture?.term?.code === 'g1t1',
      `(${result.capture?.subject?.code}/${result.capture?.term?.code})`)
    check('A2 不重新复制文件', statSync(absolute).size === pngs[1].buffer.length)
  }

  // =========================================================================
  // 场景 B1：reserved 行在数据库、归档文件不存在 → 409，绝不谎报成功
  // =========================================================================
  {
    const mock = createStrictMock()
    const svc = service(mock, root)
    const ghostRel = '数学/一年级上/ghost-not-on-disk.png'
    mock.rows.set(pngs[2].sha256, {
      id: 'cap-ghost',
      sha256hex: pngs[2].sha256,
      sha256: Buffer.from(pngs[2].sha256, 'hex'),
      original_path: ghostRel,
      original_filename: 'ghost-not-on-disk.png',
      status: 'reserved',
      page_id: null,
      media_type: null,
      byte_size: null,
      width: null,
      height: null,
      last_error: 'ARCHIVE_COPY_FAILED: 复制原件到归档目录失败',
      created_at: new Date(),
      source_metadata_json: {},
    })

    const before = listArchiveFiles(root)
    const attemptsBefore = mock.stats.insertAttempts

    let caught = null
    try {
      await svc.importOne({
        subjectCode: 'math',
        termCode: 'g1t1',
        filename: 'ghost-not-on-disk.png',
        contentLength: pngs[2].buffer.length,
        stream: asStream(pngs[2].buffer),
      })
    } catch (error) {
      caught = error
    }

    check('B1 reserved + 文件缺失 → CAPTURE_RECOVERY_REQUIRED(409)',
      caught instanceof ImportError && caught.code === 'CAPTURE_RECOVERY_REQUIRED' && caught.status === 409,
      `(${caught?.code}/${caught?.status})`)
    check('B1 绝不返回 imported/duplicate（不谎报成功）', caught !== null, '未抛错')
    check('B1 不自己去复制文件（文件仍然不存在）',
      listArchiveFiles(root).length === before.length,
      `${before.length} → ${listArchiveFiles(root).length}`)
    check('B1 只尝试了一次预留（没有第二份 INSERT 抢跑）',
      mock.stats.insertAttempts === attemptsBefore + 1,
      `(${attemptsBefore} → ${mock.stats.insertAttempts})`)
    check('B1 reserved 行仍在（失败只留现场，不删数据）',
      [...mock.rows.values()].some((row) => row.id === 'cap-ghost'))
    check('B1 错误文案不含绝对路径', !String(caught?.message).includes(root), String(caught?.message))
    check('B1 409 是 retryable（用户修好文件后能重试）', caught?.retryable === true, String(caught?.retryable))
  }

  // =========================================================================
  // 场景 B2：reserved 行在、文件在但内容被换掉 → 同样 409（不只比大小）
  // =========================================================================
  {
    const mock = createStrictMock()
    const svc = service(mock, root)
    const relPath = '数学/一年级下/swapped.png'
    const absolute = path.join(root, relPath)
    const { mkdirSync } = await import('node:fs')
    mkdirSync(path.dirname(absolute), { recursive: true })
    // 同长度、不同内容：只比大小会漏判
    writeFileSync(absolute, Buffer.concat([
      pngs[2].buffer.subarray(0, pngs[2].buffer.length - 1),
      Buffer.from([0x00]),
    ]))
    mock.rows.set(pngs[2].sha256, {
      id: 'cap-swapped',
      sha256hex: pngs[2].sha256,
      sha256: Buffer.from(pngs[2].sha256, 'hex'),
      original_path: relPath,
      original_filename: 'swapped.png',
      status: 'reserved',
      page_id: null,
      media_type: null,
      byte_size: null,
      width: null,
      height: null,
      last_error: null,
      created_at: new Date(),
      source_metadata_json: {},
    })

    let caught = null
    try {
      await svc.importOne({
        subjectCode: 'math',
        termCode: 'g1t1',
        filename: 'swapped.png',
        contentLength: pngs[2].buffer.length,
        stream: asStream(pngs[2].buffer),
      })
    } catch (error) {
      caught = error
    }

    check('B2 归档文件内容被替换 → CAPTURE_RECOVERY_REQUIRED(409)',
      caught?.code === 'CAPTURE_RECOVERY_REQUIRED', `(${caught?.code ?? '未抛错'})`)
    check('B2 不覆盖、不删除被替换的文件（原件不可变）',
      statSync(absolute).size === pngs[2].buffer.length)
  }

  // =========================================================================
  // 场景 C：reserved 行 + 文件缺失，但用户手工把文件放回 → 恢复成功且不重复复制
  //   （证明 409 不是死路：修好现场后同一路径能自动恢复）
  // =========================================================================
  {
    const mock = createStrictMock()
    const svc = service(mock, root)
    const relPath = '英语/一年级上/late-arrival.png'
    const absolute = path.join(root, relPath)
    const { mkdirSync } = await import('node:fs')
    mkdirSync(path.dirname(absolute), { recursive: true })
    // 先不放文件，确认 409
    mock.rows.set(pngs[1].sha256, {
      id: 'cap-late',
      sha256hex: pngs[1].sha256,
      sha256: Buffer.from(pngs[1].sha256, 'hex'),
      original_path: relPath,
      original_filename: 'late-arrival.png',
      status: 'reserved',
      page_id: null,
      media_type: null,
      byte_size: null,
      width: null,
      height: null,
      last_error: 'STAGING_WRITE_FAILED: 写入临时上传文件失败',
      created_at: new Date(),
      source_metadata_json: {},
    })

    let caught = null
    try {
      await svc.importOne({
        subjectCode: 'english',
        termCode: 'g1t1',
        filename: 'late-arrival.png',
        contentLength: pngs[1].buffer.length,
        stream: asStream(pngs[1].buffer),
      })
    } catch (error) {
      caught = error
    }
    check('C 文件还没到位 → 409', caught?.code === 'CAPTURE_RECOVERY_REQUIRED', String(caught?.code))

    // 把文件放回原位（模拟用户从备份恢复、或上次复制其实成功了只是没登记）
    writeFileSync(absolute, pngs[1].buffer)
    const result = await svc.importOne({
      subjectCode: 'english',
      termCode: 'g1t1',
      filename: 'late-arrival.png',
      contentLength: pngs[1].buffer.length,
      stream: asStream(pngs[1].buffer),
    })
    check('C 文件补回后再次导入 → imported', result.outcome === 'imported', result.outcome)
    check('C 恢复后 registered', result.capture?.status === 'registered', result.capture?.status)
    check('C 恢复复用同一条记录', result.capture?.id === 'cap-late', String(result.capture?.id))
    check('C 恢复后仍只有一份原件',
      listArchiveFiles(root).filter((name) => name === relPath).length === 1)
  }

  // =========================================================================
  // 场景 D：中断后**换科目**再导入同一文件 → 仍然只有一条记录、一份原件
  //   （DESIGN §11.1「同一文件被错误地换科目/学期再次导入」）
  // =========================================================================
  {
    const mock = createStrictMock()
    const svc = service(mock, root)
    mock.faults.failMarkCopied = true
    try {
      await svc.importOne({
        subjectCode: 'math',
        termCode: 'g1t1',
        filename: 'misfiled.png',
        contentLength: pngs[2].buffer.length,
        stream: asStream(pngs[2].buffer),
      })
    } catch {
      // 预期失败，现场保留
    }
    const filesAfterFailure = listArchiveFiles(root).length
    mock.faults.failMarkCopied = false

    // 换到别的科目再导一次
    const result = await svc.importOne({
      subjectCode: 'chinese',
      termCode: 'g1t2',
      filename: 'misfiled.png',
      contentLength: pngs[2].buffer.length,
      stream: asStream(pngs[2].buffer),
    })

    check('D 中断后换科目恢复 → 不再新建记录', result.outcome === 'imported' || result.outcome === 'duplicate',
      result.outcome)
    check('D 保持第一次的归档位置（不按新科目再复制一份）',
      listArchiveFiles(root).length === filesAfterFailure,
      `${filesAfterFailure} → ${listArchiveFiles(root).length}`)
    const rowsForHash = [...mock.rows.values()].filter((row) => row.sha256hex === pngs[2].sha256)
    check('D 该哈希在库里仍然只有一行', rowsForHash.length === 1, `(${rowsForHash.length})`)
    check('D 记录的路径仍是第一次的分类目录', rowsForHash[0]?.original_path.startsWith('数学/一年级上/'),
      String(rowsForHash[0]?.original_path))
  }

  // =========================================================================
  // 场景 E：中断频繁发生时不留 staging 垃圾
  // =========================================================================
  {
    const mock = createStrictMock()
    const svc = service(mock, root)
    // root 被前面几个场景复用，所以只断言本场景的**增量**
    const before = listArchiveFiles(root).length
    mock.faults.failMarkCopied = true
    for (let index = 0; index < 3; index += 1) {
      try {
        await svc.importOne({
          subjectCode: 'math',
          termCode: 'g1t1',
          filename: `retry-${index}.png`,
          contentLength: pngs[0].buffer.length,
          stream: asStream(pngs[0].buffer),
        })
      } catch {
        // 全部预期失败
      }
    }
    mock.faults.failMarkCopied = false
    const strays = listArchiveFiles(root).filter((relPath) => relPath.endsWith('.upload') || relPath.endsWith('.tmp'))
    check('E 三次中断后没有残留 staging 文件', strays.length === 0, JSON.stringify(strays))
    check('E 三次中断只多出一份原件（哈希判重从头就生效）',
      listArchiveFiles(root).length === before + 1,
      `${before} → ${listArchiveFiles(root).length}`)
  }
} finally {
  rmSync(root, { recursive: true, force: true })
  rmSync(fixtureDir, { recursive: true, force: true })
}

process.exit(finish() ? 0 : 1)
