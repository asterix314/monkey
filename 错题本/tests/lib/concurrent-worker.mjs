// 真并发的单个参与者 —— 由 verify_concurrent_import.mjs 用独立**进程**启动。
//
// 为什么必须是独立进程而不是同一个进程里的 Promise：
//  同一个事件循环里的并发只是交替执行，测不出「两个请求同时读到没有行，
//  于是都以为自己该复制」这种竞态。独立进程（各自一个 V8 isolate、各自
//  一个 libuv 线程池）才是真正的并行。
//
// 起跑线用文件屏障：所有 worker 先在这里空转，等父进程写出 barrier 文件后
// 同时起跑，把「几乎同时」压到毫秒级。

import { readFile, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '../../plugin/wrongbook')

const { ImportService } = await import(`${PLUGIN}/import-service.js`)
const { createFileBackedPool, waitForBarrier } = await import(`${HERE}/file-backed-pool.mjs`)

const argsPath = process.argv[2]
const args = JSON.parse(await readFile(argsPath, 'utf8'))

const pool = createFileBackedPool({ dir: args.poolDir })
const service = new ImportService({
  pool,
  schema: 'app',
  originalsRoot: args.root,
  uploadMaxBytes: 33554432,
  identifyTimeoutMs: 10000,
  // 并发测试关心的是仲裁结果，不需要日志噪音
  log: { warn() {}, info() {}, error() {} },
})

const record = {
  worker: args.worker,
  startedAt: null,
  finishedAt: null,
  outcome: null,
  captureId: null,
  errorCode: null,
  errorStatus: null,
}

// 等所有人到齐再起跑
const ready = await waitForBarrier(args.barrierPath)
if (!ready) {
  record.errorCode = 'BARRIER_TIMEOUT'
  await writeFile(args.resultPath, JSON.stringify(record), 'utf8')
  process.exit(0)
}

record.startedAt = Date.now()
try {
  const result = await service.importOne({
    subjectCode: args.subjectCode,
    termCode: args.termCode,
    filename: args.filename,
    contentLength: args.byteSize,
    stream: createReadStream(args.filePath),
  })
  record.outcome = result.outcome
  record.captureId = result.capture?.id ?? null
} catch (error) {
  // 409 CAPTURE_RECOVERY_REQUIRED 是允许的结果（别人正在复制，先到先得）
  record.outcome = 'error'
  record.errorCode = error?.code ?? 'UNKNOWN'
  record.errorStatus = error?.status ?? null
}
record.finishedAt = Date.now()

await writeFile(args.resultPath, JSON.stringify(record), 'utf8')
