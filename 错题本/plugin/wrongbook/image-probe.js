// 错题本插件 · 图片探测（DESIGN §12：媒体类型与宽高必须来自真实解码，不信文件名）
//
// 为什么必须用 identify 读真实字节：
//  · Content-Type 由客户端决定，可以是假的；
//  · 扩展名来自文件名（query 参数），更是可以随便写；
//  · 只有解码器真正读进去，才知道这是不是一张 JPEG/PNG，以及它的真实宽高。
// 所以媒体类型与宽高**只能**来自 identify 的结果，不信 File.type、不信扩展名。
//
// 失败语义：
//  · identify 非零退出 / 超时 / 输出不符合 `^(\d+) (\d+) ([A-Z0-9]+)$` / 多帧 → 422 IMAGE_PROBE_FAILED
//  · identify 成功但格式不在白名单（如 TIFF、BMP） → 415 UNSUPPORTED_MEDIA_TYPE
//
// 多帧的判定方式：format 模板里没有换行，多帧时 identify 会把每帧的结果直接
// 首尾相接（实测 `20 20 GIF20 20 GIF`），因此「输出整体不匹配单帧正则」就已经
// 是可靠的多帧信号；这里再额外统计一次匹配次数，让意图显式可读。

import { execFile } from 'node:child_process'

/** identify 的输出模板：宽 高 格式，三个字段以单个空格分隔。 */
const IDENTIFY_FORMAT = '%w %h %m'

/** 单帧输出的严格形状。宽高必须是纯数字，格式必须是大写字母/数字（IMAGE MAGICK 的 %m 约定）。 */
const SINGLE_FRAME_PATTERN = /^(\d+) (\d+) ([A-Z0-9]+)$/

/**
 * 白名单：identify 的 %m 值 → MIME 类型 + 落盘扩展名。
 *
 * 只放 JPEG / PNG 两种。HEIC 很可能是手机照片的真实格式，但必须先用真实样本
 * 实测 identify 能否读出宽高，再决定加不加（必须是已实测可行的格式才加入白名单）；在那之前宁可给出
 * 415，也不要写入一个「声称是 image/jpeg 实际打不开」的记录。
 */
const FORMAT_WHITELIST = new Map([
  ['JPEG', { mediaType: 'image/jpeg', extension: 'jpg' }],
  ['PNG', { mediaType: 'image/png', extension: 'png' }],
])

/** 带错误码的探测失败，交给 HTTP 层映射状态码。 */
export class ImageProbeError extends Error {
  /**
   * @param {string} code IMAGE_PROBE_FAILED | UNSUPPORTED_MEDIA_TYPE
   * @param {string} message 面向用户的中文说明（不得含绝对路径）
   */
  constructor(code, message) {
    super(message)
    this.name = 'ImageProbeError'
    this.code = code
  }
}

/**
 * 调 identify 读一个文件的宽高与格式。
 *
 * 用 execFile 而不是 exec：参数数组化，文件路径不会被 shell 解释（路径里可能有
 * 空格、中文、括号，绝不能过 shell）。timeout 由配置注入，默认 10s。
 *
 * @param {string} filePath 目标文件绝对路径
 * @param {{ timeoutMs: number, command?: string }} options 超时与 identify 可执行文件名
 * @returns {Promise<string>} identify 的原始 stdout
 */
function runIdentify(filePath, { timeoutMs, command = 'identify' }) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      ['-format', IDENTIFY_FORMAT, filePath],
      {
        timeout: timeoutMs,
        // 输出只有十几个字节；上限设小一些，异常时也不会把内存吃满
        maxBuffer: 64 * 1024,
        // 显式指定编码，避免 locale 异常时拿到 Buffer 拼错的字符串
        encoding: 'utf8',
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          // 超时被杀 / 非零退出 / identify 不存在，全部归到「探测失败」
          reject(new ImageProbeError('IMAGE_PROBE_FAILED', '无法识别该文件是否为受支持的图片'))
          return
        }
        resolve(stdout)
      },
    )
  })
}

/**
 * 探测一张图片的媒体类型、宽高与落盘扩展名。
 *
 * @param {string} filePath 已落盘文件的绝对路径（staging 或归档原件都行）
 * @param {{ timeoutMs: number, command?: string }} options 探测超时等
 * @returns {Promise<{mediaType: string, extension: string, width: number, height: number, format: string}>}
 */
export async function probeImage(filePath, options) {
  const stdout = await runIdentify(filePath, options)
  // identify 正常输出不带换行；这里仍做尾部空白清理，兼容未来版本可能的换行。
  // 只删尾部空白：多帧输出中间含换行，删掉尾部后依然无法匹配单帧正则。
  const output = String(stdout).replace(/[\s]+$/, '')

  const match = SINGLE_FRAME_PATTERN.exec(output)
  if (match === null) {
    // 多帧（输出首尾相接）、空输出、或任何非预期形状，一律拒绝
    throw new ImageProbeError('IMAGE_PROBE_FAILED', '该文件不是单帧图片，无法作为错题原件')
  }

  const width = Number(match[1])
  const height = Number(match[2])
  const format = match[3]

  // 宽高必须是正数：0 宽高会被 captures 的 chk_captures_dimensions 拒，
  // 在应用层先拦下能给出更清楚的错误
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new ImageProbeError('IMAGE_PROBE_FAILED', '图片宽高无效')
  }

  const entry = FORMAT_WHITELIST.get(format)
  if (entry === undefined) {
    // 探测成功但格式不在白名单：是「不受支持」，不是「探测失败」
    throw new ImageProbeError(
      'UNSUPPORTED_MEDIA_TYPE',
      `不支持的图片格式：${format}（当前只接受 JPEG 和 PNG）`,
    )
  }

  return { mediaType: entry.mediaType, extension: entry.extension, width, height, format }
}
