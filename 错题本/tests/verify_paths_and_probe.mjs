// 路径安全 + 图片探测的回归脚本（把此前只做过一次性手验的两组用例沉淀下来）。
//
// 覆盖：
//  · archive-store.isSafeRelativePath   —— 相对路径规则（captures 的 CHECK 在应用层的复刻）
//  · ArchiveStore.resolveOriginal       —— 词法越界 + realpath 复核（防符号链接逃逸）
//  · image-probe.probeImage             —— 真实解码、白名单、单帧判定、失败语义
//
// 全部在临时目录里跑，不连数据库、不碰真实归档目录。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '../plugin/wrongbook')

const { ArchiveError, ArchiveStore, isSafeRelativePath } = await import(`${PLUGIN}/archive-store.js`)
const { ImageProbeError, probeImage } = await import(`${PLUGIN}/image-probe.js`)

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log('PASS ', label, detail)
  } else {
    fail += 1
    console.log('FAIL ', label, detail)
  }
}

const sha256hex = (buffer) => createHash('sha256').update(buffer).digest('hex')

const root = mkdtempSync(path.join(tmpdir(), 'wb-paths-'))
const outside = mkdtempSync(path.join(tmpdir(), 'wb-paths-outside-'))

try {
  // -------------------------------------------------------------------------
  // 1. isSafeRelativePath：拒
  // -------------------------------------------------------------------------
  const rejected = [
    ['绝对路径', '/数学/一年级上/x.png'],
    ['Windows 盘符', 'C:/数学/x.png'],
    ['父目录穿越', '数学/../x.png'],
    ['父目录段', '数学/..'],
    ['空路径段（双斜杠）', '数学//x.png'],
    ['尾斜杠', '数学/一年级上/'],
    ['反斜杠', '数学\\一年级上\\x.png'],
    ['空字符串', ''],
    ['首尾空白', ' 数学/一年级上/x.png'],
    ['当前目录段', '数学/./x.png'],
    ['控制字符', '数学/\u0001x.png'],
  ]
  for (const [label, candidate] of rejected) {
    check(`isSafeRelativePath 拒绝${label}`, isSafeRelativePath(candidate) === false, JSON.stringify(candidate))
  }
  check(
    'isSafeRelativePath 接受正常相对路径',
    isSafeRelativePath('数学/一年级上/20261126-235959.abc-def.png') === true,
  )
  check(
    'isSafeRelativePath 拒绝非字符串',
    isSafeRelativePath(null) === false && isSafeRelativePath(42) === false,
  )

  // -------------------------------------------------------------------------
  // 2. resolveOriginal：词法闸门 + realpath 闸门
  // -------------------------------------------------------------------------
  const store = new ArchiveStore({ root })
  const safeRel = '数学/一年级上/ok.png'
  mkdirSync(path.join(root, '数学/一年级上'), { recursive: true })
  writeFileSync(path.join(root, safeRel), Buffer.from('png'))

  {
    const resolved = await store.resolveOriginal(safeRel)
    check('resolveOriginal 正常路径解析到根内', resolved === path.join(root, safeRel), resolved.replace(root, '<root>'))
  }

  for (const [label, candidate] of [
    ['父目录穿越', '../escape.png'],
    ['绝对路径', '/etc/passwd'],
    ['盘符路径', 'C:/Windows/win.ini'],
    ['空路径段', '数学//x.png'],
  ]) {
    let caught = null
    try {
      await store.resolveOriginal(candidate)
    } catch (error) {
      caught = error
    }
    check(
      `resolveOriginal 拒绝${label}（ArchiveError/NOT_FOUND）`,
      caught instanceof ArchiveError && caught.code === 'NOT_FOUND',
      `${caught?.name}:${caught?.code}`,
    )
  }

  // 符号链接逃逸：词法检查通过（路径在根内），必须由 realpath 复核拦下
  {
    writeFileSync(path.join(outside, 'secret.txt'), 'outside')
    symlinkSync(outside, path.join(root, 'linkdir'))
    let caught = null
    try {
      await store.resolveOriginal('linkdir/secret.txt')
    } catch (error) {
      caught = error
    }
    check(
      'resolveOriginal 拦下符号链接指向归档根之外',
      caught instanceof ArchiveError && caught.code === 'NOT_FOUND',
      `${caught?.name}:${caught?.code}`,
    )
  }

  // 发布侧（mustExist=false）同样不能越界
  {
    let caught = null
    try {
      await store.resolveOriginal('../evil/x.png', { mustExist: false })
    } catch (error) {
      caught = error
    }
    check('publish 侧（mustExist=false）也不接受越界路径', caught instanceof ArchiveError, `${caught?.name}`)
  }

  // -------------------------------------------------------------------------
  // 3. probeImage：真实解码、白名单、失败语义
  // -------------------------------------------------------------------------
  const convert = (args) => execFileSync('convert', args, { stdio: 'pipe' })

  const pngPath = path.join(root, 'probe.png')
  convert(['-size', '800x600', 'xc:white', pngPath])
  {
    const probe = await probeImage(pngPath, { timeoutMs: 10000 })
    check(
      '真实 PNG → image/png + 正确宽高',
      probe.mediaType === 'image/png' && probe.extension === 'png' && probe.width === 800 && probe.height === 600,
      `${probe.mediaType}/${probe.width}x${probe.height}`,
    )
  }

  const jpgPath = path.join(root, 'probe.jpg')
  convert(['-size', '120x90', 'xc:white', jpgPath])
  {
    const probe = await probeImage(jpgPath, { timeoutMs: 10000 })
    check(
      '真实 JPEG → image/jpeg（扩展名与媒体类型各自独立给出）',
      probe.mediaType === 'image/jpeg' && probe.extension === 'jpg' && probe.width === 120,
      `${probe.mediaType}/${probe.width}`,
    )
  }

  const textJpg = path.join(root, 'notimage.jpg')
  writeFileSync(textJpg, '这不是图片，只是一段文本\n')
  {
    let caught = null
    try {
      await probeImage(textJpg, { timeoutMs: 10000 })
    } catch (error) {
      caught = error
    }
    check(
      '非图片（文本改名 .jpg）→ IMAGE_PROBE_FAILED',
      caught instanceof ImageProbeError && caught.code === 'IMAGE_PROBE_FAILED',
      `${caught?.name}:${caught?.code}`,
    )
  }

  {
    const pngBytes = readFileSync(pngPath)
    const truncatedPath = path.join(root, 'truncated.png')
    writeFileSync(truncatedPath, pngBytes.subarray(0, Math.max(16, Math.floor(pngBytes.length / 2))))
    let caught = null
    try {
      await probeImage(truncatedPath, { timeoutMs: 10000 })
    } catch (error) {
      caught = error
    }
    check(
      '截断 PNG → IMAGE_PROBE_FAILED',
      caught instanceof ImageProbeError && caught.code === 'IMAGE_PROBE_FAILED',
      `${caught?.name}:${caught?.code}`,
    )
  }

  {
    let caught = null
    try {
      await probeImage(path.join(root, 'no-such-file.png'), { timeoutMs: 10000 })
    } catch (error) {
      caught = error
    }
    check(
      '不存在的文件 → IMAGE_PROBE_FAILED',
      caught instanceof ImageProbeError && caught.code === 'IMAGE_PROBE_FAILED',
      `${caught?.name}:${caught?.code}`,
    )
  }

  // 415 与 422 的分界：能解码但不在白名单 → 415；解不出/多帧 → 422
  const bmpPath = path.join(root, 'probe.bmp')
  convert(['-size', '40x30', 'xc:white', `bmp3:${bmpPath}`])
  {
    let caught = null
    try {
      await probeImage(bmpPath, { timeoutMs: 10000 })
    } catch (error) {
      caught = error
    }
    check(
      '白名单外但可解码（BMP）→ UNSUPPORTED_MEDIA_TYPE(415)',
      caught instanceof ImageProbeError && caught.code === 'UNSUPPORTED_MEDIA_TYPE',
      `${caught?.name}:${caught?.code}`,
    )
  }

  const gifSingle = path.join(root, 'single.gif')
  convert(['-size', '20x20', 'xc:red', gifSingle])
  {
    let caught = null
    try {
      await probeImage(gifSingle, { timeoutMs: 10000 })
    } catch (error) {
      caught = error
    }
    check(
      '单帧 GIF（可解码、不在白名单）→ UNSUPPORTED_MEDIA_TYPE',
      caught instanceof ImageProbeError && caught.code === 'UNSUPPORTED_MEDIA_TYPE',
      `${caught?.name}:${caught?.code}`,
    )
  }

  const gifMulti = path.join(root, 'anim.gif')
  convert(['-size', '20x20', 'xc:red', 'xc:blue', '-delay', '10', gifMulti])
  {
    let caught = null
    try {
      await probeImage(gifMulti, { timeoutMs: 10000 })
    } catch (error) {
      caught = error
    }
    check(
      '多帧 GIF（输出首尾相接）→ IMAGE_PROBE_FAILED(422)，不是 415',
      caught instanceof ImageProbeError && caught.code === 'IMAGE_PROBE_FAILED',
      `${caught?.name}:${caught?.code}`,
    )
  }

  // -------------------------------------------------------------------------
  // 4. 探测不看扩展名：.png 后缀的 JPEG 仍按真实字节判为 image/jpeg
  // -------------------------------------------------------------------------
  {
    const mislabeled = path.join(root, 'mislabeled.png')
    convert(['-size', '60x40', 'xc:white', `jpeg:${mislabeled}`])
    const probe = await probeImage(mislabeled, { timeoutMs: 10000 })
    check(
      '媒体类型来自解码结果而非扩展名（.png 里其实是 JPEG）',
      probe.mediaType === 'image/jpeg' && probe.extension === 'jpg',
      `${probe.mediaType}`,
    )
  }
} finally {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
}

console.log(`\n${pass}/${pass + fail} 通过`)
process.exit(fail === 0 ? 0 : 1)
