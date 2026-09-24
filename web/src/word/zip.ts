// 最小 ZIP 实现（store 无压缩），无第三方依赖。
// 仅用于生成/解析 .docx（本质是 ZIP 包），足以驱动 Word / WPS / LibreOffice。

function makeCRCTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
}

const CRC_TABLE = makeCRCTable()

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function encStr(s: string): Uint8Array {
  // 文档内部路径用 ASCII 即可
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

function push16(view: DataView, off: number, v: number) {
  view.setUint16(off, v & 0xffff, true)
}
function push32(view: DataView, off: number, v: number) {
  view.setUint32(off, v >>> 0, true)
}

export interface ZipFile {
  name: string
  data: Uint8Array
}

/** 生成 store 方式 ZIP，返回字节流 */
export function createZip(files: ZipFile[]): Uint8Array {
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const f of files) {
    const nameBytes = encStr(f.name)
    const crc = crc32(f.data)
    const size = f.data.length

    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    push32(lv, 0, 0x04034b50)
    push16(lv, 4, 20)
    push16(lv, 6, 0)
    push16(lv, 8, 0)
    push16(lv, 10, 0)
    push16(lv, 12, 0)
    push32(lv, 14, crc)
    push32(lv, 18, size)
    push32(lv, 22, size)
    push16(lv, 26, nameBytes.length)
    push16(lv, 28, 0)
    local.set(nameBytes, 30)
    chunks.push(local, f.data)

    const cd = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(cd.buffer)
    push32(cv, 0, 0x02014b50)
    push16(cv, 4, 20)
    push16(cv, 6, 20)
    push16(cv, 8, 0)
    push16(cv, 10, 0)
    push16(cv, 12, 0)
    push16(cv, 14, 0)
    push32(cv, 16, crc)
    push32(cv, 20, size)
    push32(cv, 24, size)
    push16(cv, 28, nameBytes.length)
    push16(cv, 30, 0)
    push16(cv, 32, 0)
    push16(cv, 34, 0)
    push16(cv, 36, 0)
    push32(cv, 38, 0)
    push32(cv, 42, offset)
    cd.set(nameBytes, 46)
    central.push(cd)

    offset += local.length + f.data.length
  }

  const cdStart = offset
  let cdSize = 0
  for (const c of central) {
    chunks.push(c)
    cdSize += c.length
  }

  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  push32(ev, 0, 0x06054b50)
  push16(ev, 4, 0)
  push16(ev, 6, 0)
  push16(ev, 8, files.length)
  push16(ev, 10, files.length)
  push32(ev, 12, cdSize)
  push32(ev, 16, cdStart)
  push16(ev, 20, 0)
  chunks.push(end)

  // 拼接
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let p = 0
  for (const c of chunks) {
    out.set(c, p)
    p += c.length
  }
  return out
}

/** 解析 ZIP，返回文件名 -> 内容 */
export function readZip(buf: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const result = new Map<string, Uint8Array>()
  let off = 0
  // 顺序扫描本地文件头
  while (off + 4 <= buf.length) {
    const sig = view.getUint32(off, true)
    if (sig !== 0x04034b50) break
    const comp = view.getUint16(off + 8, true)
    const crc = view.getUint32(off + 14, true)
    const compSize = view.getUint32(off + 18, true)
    const uncompSize = view.getUint32(off + 22, true)
    const nameLen = view.getUint16(off + 26, true)
    const extraLen = view.getUint16(off + 28, true)
    const nameBytes = buf.subarray(off + 30, off + 30 + nameLen)
    const name = String.fromCharCode(...nameBytes)
    const dataStart = off + 30 + nameLen + extraLen
    const data = buf.subarray(dataStart, dataStart + compSize)
    // 仅处理 store（compression=0）；deflate 本实现不展开
    if (comp === 0) {
      result.set(name, data.slice())
    }
    off = dataStart + compSize
    void crc
    void uncompSize
  }
  return result
}
