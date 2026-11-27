// 错题本插件 · 原件归档存储层（DESIGN §6.1 原件目录 / §6.2 相对路径 / §10.2 复制与校验）
//
// 这一层只做文件系统的事，不认识 SQL、不认识 HTTP：
//  · 相对路径 <-> 绝对路径的换算与越界防护（数据库只存相对路径，DESIGN §6.2）
//  · staging 文件：上传先落到 originals_root/.wrongbook-tmp/<uuid>.upload，
//   边收边算 SHA-256，避免把 32 MiB 全读进内存
//  · 原子发布：先在同目录写唯一临时名，再 fs.rename —— rename 在同一文件系统内
//   是原子的，但目标已存在时会被静默替换，所以发布前必须确认目标不存在
//  · 复算哈希：复制完成后再算一遍最终文件的摘要，和预留时比（DESIGN §10.2）
//
// 铁律：任何失败都不删除、不覆盖已归档原件。staging 文件可以删（它还没进归档树）。

import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, createReadStream } from 'node:fs'
import { copyFile, mkdir, open, realpath, rename, rm, stat, unlink } from 'node:fs/promises'
import path from 'node:path'

/** staging 子目录名：放在 originals_root 下以便与归档同文件系统（rename 才原子）。 */
export const STAGING_DIR_NAME = '.wrongbook-tmp'

/** 控制字符（captures CHECK 里用 [[:cntrl:]] 表达，JS 侧需要显式列出）。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/**
 * 判断一个字符串是否是合法的原件相对路径。
 *
 * 这是 sql/001_schema_v1.sql 中 chk_captures_relative_path 的应用层复刻。
 * 复刻的目的不是"再信任一次"，而是**在写库之前**就把坏路径变成可读错误，
 * 而不是把 PostgreSQL 的约束名抛给用户。两处规则必须保持一致。
 *
 * @param {string} relPath 待检查的相对路径（POSIX 分隔符）
 * @returns {boolean} 合法为 true
 */
export function isSafeRelativePath(relPath) {
  if (typeof relPath !== 'string' || relPath === '') return false
  if (relPath !== relPath.trim()) return false
  if (relPath.startsWith('/')) return false
  if (/^[A-Za-z]:/.test(relPath)) return false
  if (relPath.includes('\\')) return false
  if (relPath.includes('//')) return false
  if (relPath.endsWith('/')) return false
  if (CONTROL_CHARS.test(relPath)) return false
  // 逐段检查：任何一段是 . 或 .. 都拒（不做「规范化后再说」的宽容处理）
  for (const segment of relPath.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false
  }
  return true
}

/**
 * 由「科目目录名 + 学期目录名 + 存储文件名」拼出数据库里的相对路径。
 *
 * 只用 path.posix.join：数据库里的路径永远是 POSIX 形式，与宿主机的 path.sep
 * 解耦，将来即使换到 Windows 侧解析也不会变成反斜杠。参数一律来自数据库字典
 * （subjects/terms 的 directory_name），**绝不来自客户端**（DESIGN §6.2：不接受客户端传路径）。
 *
 * @param {string} subjectDirectory subjects.directory_name
 * @param {string} termDirectory terms.directory_name
 * @param {string} storageName 已生成的碰撞安全文件名
 * @returns {string} 形如 `数学/一年级上/20261126-235959.a1b2....jpg`
 */
export function buildRelativePath(subjectDirectory, termDirectory, storageName) {
  const joined = path.posix.join(subjectDirectory, termDirectory, storageName)
  if (!isSafeRelativePath(joined)) {
    // 字典表的 chk_*_directory_name_safe 已经拦过一道，这里再兜一次：
    // 万一数据被手工改坏，宁可报错也不要拼出一个能越界的路径。
    throw new ArchiveError('ARCHIVE_COPY_FAILED', '归档相对路径不安全（目录名或文件名含非法字符）', 'buildRelativePath')
  }
  return joined
}

/**
 * 按冻结规则生成存储文件名：
 *  YYYYMMDD-HHMMSS.<sha256 前 12 hex>-<randomUUID 去横线>.<identify 确认的小写扩展名>
 *
 * 三段各自解决一个冲突出问题：
 *  · 时间戳给人看，便于在资源管理器里按时间排序；
 *  · sha256 前 12 位让「同一个文件」在目录里肉眼可辨；
 *  · randomUUID 提供真正的碰撞安全 —— 前两段都可能重复，只有它有约 122 bit 随机性。
 *
 * @param {Buffer} sha256Digest 32 字节摘要
 * @param {string} extension 小写扩展名（不含点），如 `jpg`
 * @param {Date} [now] 用于测试注入的时间
 * @returns {string} 存储文件名
 */
export function buildStorageName(sha256Digest, extension, now = new Date()) {
  const p2 = (value) => String(value).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}` +
    `-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`
  const hashHead = sha256Digest.subarray(0, 6).toString('hex')
  const unique = randomUUID().replace(/-/g, '')
  return `${stamp}.${hashHead}-${unique}.${extension}`
}

/** 让错误带上 HTTP 层要用的错误码，避免上层去嗅探 error.message 文本。 */
export class ArchiveError extends Error {
  /**
   * @param {string} code 业务错误码（见 import-service.js 的 ERROR_TABLE）
   * @param {string} message 面向用户的中文说明（不得含绝对路径）
   * @param {string} [stage] 出错阶段，便于日志定位
   */
  constructor(code, message, stage) {
    super(message)
    this.name = 'ArchiveError'
    this.code = code
    this.stage = stage
  }
}

/**
 * 一次上传对应一个 staging 文件。
 *
 * 生命周期：openStaging → write* → commit（落盘并 close）→ publish 复制进归档树
 *     任意阶段失败 → discard()（只删 staging，绝不动归档树）
 */
class StagingFile {
  /**
   * @param {string} filePath staging 绝对路径
   * @param {import('node:fs/promises').FileHandle} handle 已打开的写句柄
   */
  constructor(filePath, handle) {
    this.filePath = filePath
    this.handle = handle
    this.hasher = createHash('sha256')
    this.bytesWritten = 0
    this.closed = false
  }

  /**
   * 追加一块字节，同时更新摘要与累计字节数（导入流程第 3 步：边收边算）。
   *
   * @param {Buffer} chunk 数据块
   * @returns {Promise<void>} 写入完成
   */
  async write(chunk) {
    // 顺序 await：同一个句柄并发 write 会打乱字节顺序，必须串行。
    await this.handle.write(chunk)
    this.hasher.update(chunk)
    this.bytesWritten += chunk.length
  }

  /**
   * 落盘并关闭，返回摘要（导入流程第 4 步 close/sync staging）。
   *
   * 先 sync 再 close：/mnt/c 走的是 9p/drvfs，不显式 sync 时后续 rename
   * 之后仍可能读到未落盘的内容。
   *
   * @returns {Promise<{digest: Buffer, byteSize: number}>} 摘要与字节数
   */
  async commit() {
    if (this.closed) throw new Error('staging 已关闭')
    await this.handle.sync()
    await this.handle.close()
    this.closed = true
    return { digest: this.hasher.digest(), byteSize: this.bytesWritten }
  }

  /** 关闭句柄（忽略错误）并删除 staging 文件；归档树不受影响。 */
  async discard() {
    if (!this.closed) {
      try {
        await this.handle.close()
      } catch {
        // 已经坏掉的句柄再关一次没有意义
      }
      this.closed = true
    }
    try {
      await unlink(this.filePath)
    } catch {
      // 文件可能根本没创建成功；残留最多占一份临时空间，不影响正确性
    }
  }
}

/**
 * 原件归档存储。
 *
 * 构造函数不碰文件系统 —— 插件 apply() 期间 originals_root 可能还不可用
 * （比如 Windows 盘尚未挂载），此时应该让插件照常起来，把失败暴露在真正导入的那一刻。
 */
export class ArchiveStore {
  /**
   * @param {{ root: string }} options root 必须是配置里的绝对路径
   */
  constructor({ root }) {
    this.root = path.resolve(root)
    /** @type {Promise<string> | undefined} realpath 结果缓存（失败会清空以便重试） */
    this._canonicalRoot = undefined
  }

  /**
   * 解析 originals_root 的真实路径（穿透 symlink）。
   *
   * 越界检查必须基于真实路径：否则 originals_root 自身是符号链接时，
   * `startsWith(root)` 会通过，而实际写到了链接指向的位置。
   *
   * @returns {Promise<string>} 规范化后的根目录绝对路径
   */
  async canonicalRoot() {
    if (this._canonicalRoot === undefined) {
      this._canonicalRoot = realpath(this.root).catch(() => {
        // 失败不缓存：用户挂载/创建目录后，下一次导入应该能成功
        this._canonicalRoot = undefined
        throw new ArchiveError(
          'ARCHIVE_COPY_FAILED',
          '原件根目录不可访问（originals_root 指向的目录不存在或没有权限）',
          'canonicalRoot',
        )
      })
    }
    return this._canonicalRoot
  }

  /**
   * 把数据库里的相对路径解析成绝对路径，并确保它没有越出归档根。
   *
   * 三道闸门：
   *  1. 相对路径本身必须符合 captures 的 CHECK 规则（不接受客户端传路径）；
   *  2. path.resolve 之后必须仍在 root + sep 之下（防 `../`）；
   *  3. 存在时用 realpath 复核（防归档目录里有人放了指向外面的符号链接）。
   *
   * @param {string} relPath 数据库 original_path 字段
   * @param {{ mustExist?: boolean }} [options] mustExist=true 时要求文件存在
   * @returns {Promise<string>} 绝对路径
   */
  async resolveOriginal(relPath, { mustExist = true } = {}) {
    const root = await this.canonicalRoot()
    const absolute = this.resolveLexically(root, relPath)

    if (mustExist) {
      const canonical = await this.realpathInsideRoot(root, absolute, 'NOT_FOUND', '原件不存在', '原件路径越界（符号链接指向归档根之外）')
      return canonical
    }

    // 不要求文件已存在时（发布前），只保证词法上在根内即可；
    // 真正的 realpath 复核放到 ensureDirectory + verifyExistingTarget 里，
    // 因为此时目标子目录可能还没被创建（第一次往新科目/新学期导入）。
    return absolute
  }

  /**
   * 纯词法解析：只做字符串层面的越界检查，不碰文件系统。
   *
   * @param {string} root 规范化的根目录
   * @param {string} relPath 相对路径
   * @returns {string} 绝对路径（词法上保证在 root 之下）
   */
  resolveLexically(root, relPath) {
    if (!isSafeRelativePath(relPath)) {
      throw new ArchiveError('NOT_FOUND', '原件路径不合法', 'resolveLexically')
    }
    const absolute = path.resolve(root, relPath)
    // 必须带 trailing separator：否则 /root2/x 会被 /root 前缀匹配放过
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      throw new ArchiveError('NOT_FOUND', '原件路径越界', 'resolveLexically')
    }
    return absolute
  }

  /**
   * realpath 复核一个已存在的路径确实仍在根内。
   *
   * @param {string} root 规范化的根目录
   * @param {string} absolute 待复核路径
   * @param {string} missingCode 路径不存在时的错误码
   * @param {string} missingMessage 路径不存在时的说明
   * @param {string} escapeMessage 越界时的说明
   * @returns {Promise<string>} 真实路径
   */
  async realpathInsideRoot(root, absolute, missingCode, missingMessage, escapeMessage) {
    let canonical
    try {
      canonical = await realpath(absolute)
    } catch {
      throw new ArchiveError(missingCode, missingMessage, 'realpathInsideRoot')
    }
    if (canonical !== root && !canonical.startsWith(root + path.sep)) {
      throw new ArchiveError(missingCode, escapeMessage, 'realpathInsideRoot')
    }
    return canonical
  }

  /**
   * 创建 staging 文件：originals_root/.wrongbook-tmp/<request-uuid>.upload（导入流程第 2 步（DESIGN §10.2））
   *
   * 放在 originals_root 内而不是 os.tmpdir()：/tmp 和 /mnt/c 通常不是同一个
   * 文件系统，跨设备时 rename 会退化成「复制+删除」，原子性就没了。
   *
   * @returns {Promise<StagingFile>} 可写的 staging 句柄
   */
  async openStaging() {
    const root = await this.canonicalRoot()
    const stagingDir = path.join(root, STAGING_DIR_NAME)
    try {
      await mkdir(stagingDir, { recursive: true })
    } catch {
      throw new ArchiveError('STAGING_WRITE_FAILED', '无法创建临时上传目录', 'openStaging')
    }
    // 用请求级 uuid 命名：并发上传互不覆盖，且进程崩溃后残留文件名可追溯
    const stagingPath = path.join(stagingDir, `${randomUUID()}.upload`)
    let handle
    try {
      // 'wx'：目标已存在则失败。uuid 撞车概率极低，但撞了就应该换名而不是覆盖。
      handle = await open(stagingPath, 'wx')
    } catch {
      throw new ArchiveError('STAGING_WRITE_FAILED', '无法创建临时上传文件', 'openStaging')
    }
    return new StagingFile(stagingPath, handle)
  }

  /**
   * 把 staging 文件原子发布到归档目录（导入流程第 7 步）。
   *
   * 步骤：目标目录 mkdir -p → 同目录唯一临时名 → copy → rename 到最终名。
   * 之所以不直接写最终名：rename 会**静默替换**已存在的目标，一旦文件名规则
   * 出现意外重复就会覆盖用户原件。先在临时名写完再 rename，配合发布前的存在性
   * 检查，把「覆盖」变成「报错」。
   *
   * @param {string} stagingPath staging 绝对路径
   * @param {string} relPath 目标相对路径（已通过 buildRelativePath）
   * @returns {Promise<{absolutePath: string, byteSize: number}>} 最终绝对路径与字节数
   */
  async publish(stagingPath, relPath) {
    const root = await this.canonicalRoot()
    const destination = this.resolveLexically(root, relPath)
    const destinationDir = path.dirname(destination)

    try {
      await mkdir(destinationDir, { recursive: true })
    } catch {
      throw new ArchiveError('ARCHIVE_COPY_FAILED', '无法创建归档子目录', 'publish')
    }

    // mkdir 之后复核：子目录可能存在，也可能是本次刚建好的，现在必须真实地落在根内
    await this.realpathInsideRoot(
      root,
      destinationDir,
      'ARCHIVE_COPY_FAILED',
      '归档目标目录不可访问',
      '归档目标目录越界（符号链接指向归档根之外）',
    )

    const tempPath = path.join(destinationDir, `.${path.basename(destination)}.${randomUUID()}.tmp`)
    try {
      // COPYFILE_EXCL：临时名必须不存在，防止并发请求互相踩踏
      await copyFile(stagingPath, tempPath, fsConstants.COPYFILE_EXCL)
    } catch {
      throw new ArchiveError('ARCHIVE_COPY_FAILED', '复制原件到归档目录失败', 'publish')
    }

    // 发布前确认目标不存在：窗口很小，但宁可报错也不要覆盖用户原件
    let destinationExists = false
    try {
      await stat(destination)
      destinationExists = true
    } catch (error) {
      if (error.code !== 'ENOENT') {
        await rm(tempPath, { force: true })
        throw new ArchiveError('ARCHIVE_COPY_FAILED', '无法确认归档目标状态', 'publish')
      }
    }
    if (destinationExists) {
      await rm(tempPath, { force: true })
      throw new ArchiveError('ARCHIVE_COPY_FAILED', '归档目标文件已存在，拒绝覆盖', 'publish')
    }

    try {
      await rename(tempPath, destination)
    } catch {
      await rm(tempPath, { force: true })
      throw new ArchiveError('ARCHIVE_COPY_FAILED', '归档文件发布失败', 'publish')
    }

    // 字节数用于回填 captures.byte_size，直接从落盘文件取，避免与 staging 计数漂移
    const info = await stat(destination)
    return { absolutePath: destination, byteSize: info.size }
  }

  /**
   * 计算一个已存在文件的 SHA-256（导入流程第 8 步（DESIGN §10.2「校验复制后文件 SHA-256」）：复制后复算，和预留摘要比对）。
   *
   * 用流式读取：既避免大文件整读进内存，也避免同步读阻塞事件循环。
   *
   * @param {string} absolutePath 文件绝对路径
   * @returns {Promise<Buffer>} 32 字节摘要
   */
  async hashFile(absolutePath) {
    const hasher = createHash('sha256')
    await new Promise((resolve, reject) => {
      const stream = createReadStream(absolutePath)
      stream.on('data', (chunk) => hasher.update(chunk))
      stream.on('error', reject)
      stream.on('end', resolve)
    })
    return hasher.digest()
  }

  /**
   * 打开原件读流，供 GET /wrongbook/originals/* 使用。
   *
   * 只接受数据库里登记过的相对路径（由调用方先查库），本方法只负责越界防护。
   *
   * @param {string} relPath 数据库 original_path
   * @returns {Promise<{absolutePath: string, stream: import('node:stream').Readable, size: number}>}
   */
  async openOriginalStream(relPath) {
    const absolutePath = await this.resolveOriginal(relPath, { mustExist: true })
    const info = await stat(absolutePath)
    if (!info.isFile()) {
      throw new ArchiveError('NOT_FOUND', '原件不是普通文件', 'openOriginalStream')
    }
    return { absolutePath, stream: createReadStream(absolutePath), size: info.size }
  }
}
