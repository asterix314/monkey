// 真并发导入验证（DESIGN §14.1-7：两个导入操作同时遇到同一文件时，最终仍只有一个 Capture）。
//
// 这是本轮唯一一个**不能用单进程串行测试**替代的验证，所以做法必须认真：
//  · 4 个独立的 Node **子进程**（不是 worker_threads 里的 Promise）同时导入同一份字节；
//  · 「同一个数据库」用一个由文件系统支撑的池模拟：INSERT 的原子预留用
//    open(path,'wx')（O_EXCL，内核保证只有一个创建者）；
//  · 起跑线用文件屏障，所有进程空转到 barrier 出现后同时起跑；
//  · 断言只看外部可观察事实：captures 行数、归档文件数、每个进程的结果。
//
// 为什么不能只用 mock 的 Map：Map 是进程内对象，Promise.all 只是交替执行，
// 「先 SELECT 再 INSERT」的错误写法在交替里可能恰好通过。独立进程 + O_EXCL
// 才能让「两个人都以为自己是第一个」这种竞态真的暴露出来。

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createReporter, listArchiveFiles, makePngs, makeTempDir } from './lib/strict-mock.mjs'
import { inspectPoolDir } from './lib/file-backed-pool.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKER = path.join(HERE, 'lib/concurrent-worker.mjs')

const { check, finish } = createReporter()

const WORKERS = 4

/** 启动一个 worker 子进程，返回 { promise, kill }。 */
function spawnWorker(argsPath) {
  const child = spawn(process.execPath, [WORKER, argsPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const promise = new Promise((resolve) => {
    child.on('exit', (code) => resolve({ code, stderr }))
  })
  return { child, promise }
}

const root = makeTempDir('wb-concurrent-')
const fixturesDir = makeTempDir('wb-concurrent-fixtures-')
const poolDir = makeTempDir('wb-concurrent-db-')
const stagingDir = makeTempDir('wb-concurrent-args-')

try {
  // 所有进程导入**同一份字节**（这正是「同一文件被导入两次」的定义）
  const [png] = makePngs(fixturesDir, [{ width: 300, height: 200 }])
  const digest = createHash('sha256').update(png.buffer).digest('hex')

  // 池目录里建两个空目录：rows/ 与 locks/
  mkdirSync(path.join(poolDir, 'rows'), { recursive: true })
  mkdirSync(path.join(poolDir, 'locks'), { recursive: true })

  const barrierPath = path.join(stagingDir, 'barrier')
  const results = []

  const workers = []
  for (let index = 0; index < WORKERS; index += 1) {
    const argsPath = path.join(stagingDir, `args-${index}.json`)
    const resultPath = path.join(stagingDir, `result-${index}.json`)
    const args = {
      worker: index,
      poolDir,
      root,
      barrierPath,
      resultPath,
      filePath: path.join(fixturesDir, png.name),
      byteSize: png.buffer.length,
      subjectCode: 'math',
      termCode: 'g1t1',
      // 故意全用不同文件名：证明判重靠内容而不是名字（DESIGN §11.1）
      filename: `concurrent-${index}.png`,
    }
    writeFileSync(argsPath, JSON.stringify(args), 'utf8')
    workers.push({ ...spawnWorker(argsPath), resultPath })
  }

  // 稍等让所有 worker 都进到屏障等待循环，再放行 —— 这样起跑才是同时的
  await new Promise((resolve) => setTimeout(resolve, 400))
  writeFileSync(barrierPath, 'go', 'utf8')

  const exits = await Promise.all(workers.map((worker) => worker.promise))

  for (const [index, worker] of workers.entries()) {
    const exit = exits[index]
    if (exit.code !== 0) {
      check(`worker ${index} 正常退出`, false, `code=${exit.code} stderr=${exit.stderr.slice(0, 400)}`)
      continue
    }
    results.push(JSON.parse(readFileSync(worker.resultPath, 'utf8')))
  }

  check(`4 个 worker 全部正常退出`, exits.every((exit) => exit.code === 0),
    JSON.stringify(exits.map((exit) => exit.code)))

  // ---- 核心断言 1：captures 表里只有一行 --------------------------------
  const pool = await inspectPoolDir(poolDir)
  check('并发结束后 captures 只有 1 行', pool.fileCount === 1, `(${pool.fileCount})`)
  check(
    '这一行的哈希等于导入的文件',
    pool.rows.length === 1 && pool.rows[0].sha256 === digest,
    JSON.stringify(pool.rows.map((row) => row.sha256)),
  )
  check(
    '这一行最终状态是 registered（不是卡在 reserved）',
    pool.rows.length === 1 && pool.rows[0].status === 'registered',
    JSON.stringify(pool.rows.map((row) => row.status)),
  )

  // ---- 核心断言 2：归档目录里只有一份原件 ------------------------------
  const archived = listArchiveFiles(root)
  check('并发结束后归档目录只有 1 个原件', archived.length === 1, JSON.stringify(archived))
  check(
    '原件路径与数据库记录一致（引用可核对）',
    archived.length === 1 && pool.rows.length === 1 && archived[0] === pool.rows[0].original_path,
    JSON.stringify({ archived, recorded: pool.rows[0]?.original_path }),
  )

  // ---- 核心断言 3：只有一个进程拿到 imported，其余 duplicate/409 -------
  const imported = results.filter((record) => record.outcome === 'imported')
  const duplicates = results.filter((record) => record.outcome === 'duplicate')
  const conflicts = results.filter(
    (record) => record.outcome === 'error' && record.errorCode === 'CAPTURE_RECOVERY_REQUIRED',
  )
  const others = results.filter(
    (record) => !['imported', 'duplicate', 'error'].includes(record.outcome),
  )

  check('4 个 worker 都拿到了明确结果', results.length === 4 && others.length === 0,
    JSON.stringify(results.map((record) => record.outcome)))
  check('恰好 1 个 worker 报 imported（只有一个赢家）', imported.length === 1,
    `(${imported.length}) imported, ${duplicates.length} duplicate, ${conflicts.length} conflict`)
  check('其余 3 个是 duplicate 或 409（不是静默成功）',
    duplicates.length + conflicts.length === 3,
    `duplicate=${duplicates.length} conflict=${conflicts.length}`)
  check(
    '所有 worker 拿到的 captureId 相同（都指向同一行）',
    results.every((record) => record.captureId === null || record.captureId === imported[0]?.captureId),
    JSON.stringify(results.map((record) => record.captureId)),
  )

  // ---- 断言 4：确实是「同时」发生的 -----------------------------------
  // 起跑时间跨度很小，说明它们是真的并发（而不是排队串行）
  const starts = results.map((record) => record.startedAt).filter((value) => typeof value === 'number')
  const spread = starts.length > 1 ? Math.max(...starts) - Math.min(...starts) : 0
  check('4 个 worker 的起跑时间跨度 < 500ms（确实是同时）', spread < 500, `(${spread}ms)`)

  // ---- 断言 5：没有留下 staging 垃圾 --------------------------------
  const stray = listArchiveFiles(root).filter((relPath) => relPath.includes('.upload') || relPath.includes('.tmp'))
  check('并发后没有残留 staging / tmp 文件', stray.length === 0, JSON.stringify(stray))

  // ---- 断言 6：这一行没有被并发写坏 --------------------------------
  check(
    '记录携带完整的媒体信息（并发没有写出半条）',
    pool.rows.length === 1 &&
      typeof pool.rows[0].media_type === 'string' &&
      Number(pool.rows[0].byte_size) === png.buffer.length &&
      Number(pool.rows[0].width) === 300 &&
      Number(pool.rows[0].height) === 200,
    JSON.stringify(pool.rows[0] && {
      media_type: pool.rows[0].media_type,
      byte_size: pool.rows[0].byte_size,
      width: pool.rows[0].width,
      height: pool.rows[0].height,
    }),
  )
  check(
    '最后写入的 last_error 为 null（成功路径没有留失败痕迹）',
    pool.rows.length === 1 && pool.rows[0].last_error === null,
    String(pool.rows[0]?.last_error),
  )
} finally {
  rmSync(root, { recursive: true, force: true })
  rmSync(fixturesDir, { recursive: true, force: true })
  rmSync(poolDir, { recursive: true, force: true })
  rmSync(stagingDir, { recursive: true, force: true })
}

process.exit(finish() ? 0 : 1)
