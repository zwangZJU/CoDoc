/**
 * 高保真 .xlsx 写出器
 *
 * SheetJS 社区版**不支持写样式**——字体 / 字号 / 颜色 / 底色 / 边框 / 对齐 / 数字格式
 * 在 `aoa_to_sheet` 之后会全部丢失。这里直接生成 OOXML，保证导出的表格与网页上看到的
 * 完全一致：
 *   - 字体：名称 / 字号 / 粗体 / 斜体 / 下划线 / 删除线 / 字体颜色
 *   - 填充：单元格底色
 *   - 边框：四边各自的线型 + 线宽 + 颜色
 *   - 对齐：水平 / 垂直 / 自动换行（未设置时按网页 CSS 的默认：左对齐 + 垂直居中）
 *   - 数字格式（numFmt）
 *   - 合并单元格 / 列宽 / 行高
 *   - 公式（写入公式本身，并附一份本引擎算出的缓存值，Excel 打开会自动重算）
 *
 * 注意：**没写内容的单元格不写任何样式**，导出后保持 Excel 默认空白，
 * 不会出现"整片空区域被上色"的情况。
 */
import { strToU8, zipSync } from 'fflate'
import { colToIndex, indexToCol } from './refs'
import { BUILTIN_NUMFMT } from './numfmt'
import { evalFormula } from './formula'
import type { CellData, CellStyle, MergeInfo } from './useSheet'

export interface WriteSheet {
  name: string
  rows: CellData[][]
  merges?: MergeInfo[]
  /** 列宽（px），key = 列索引 */
  colw?: Record<number, number>
  /** 行高（px），key = 行索引 */
  rowh?: Record<number, number>
}

/** 网页 --font-sans 在 Windows 上的实际落点（Inter 未安装时走中文黑体） */
const DEFAULT_FONT = 'Microsoft YaHei'
/** 网页网格默认字号 13px ≈ 10pt */
const DEFAULT_SIZE_PT = 10
/** 与 useSheet 的默认列宽 / 行高保持一致（px） */
const DEFAULT_COL_PX = 72
const DEFAULT_ROW_PX = 28

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

// ------------------------------------------------------------------ 基础工具

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // XML 1.0 不允许的控制字符直接剔除
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
}

/** CSS 颜色 -> ARGB（Excel 用 FF 前缀的不透明色） */
function toArgb(color: string | undefined): string | undefined {
  if (!color) return undefined
  let s = String(color).trim()
  if (s.startsWith('#')) s = s.slice(1)
  if (/^[0-9a-fA-F]{8}$/.test(s)) return s.toUpperCase()
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    return ('FF' + s[0] + s[0] + s[1] + s[1] + s[2] + s[2]).toUpperCase()
  }
  if (/^[0-9a-fA-F]{6}$/.test(s)) return 'FF' + s.toUpperCase()
  return undefined
}

/** 网页 px -> Excel 磅值（1pt = 4/3 px） */
function pxToPt(px: number): number {
  return Math.round(px * 0.75 * 4) / 4
}

/** 网页 px -> Excel 列宽（字符数）。与 xlsxRead 的 px ≈ 字符宽 * 7 + 5 互为逆运算 */
function pxToColWidth(px: number): number {
  return Math.max(1, Math.round(((px - 5) / 7) * 100) / 100)
}

/**
 * CSS 字体栈 -> 单一字体名。
 * 网页里存的是完整 font-family（如 `"PingFang SC", "Microsoft YaHei", sans-serif`），
 * 写回 xlsx 时只取第一个「真实可用」的字体：跳过系统 / 通用 / 仅 macOS 有的名字。
 */
const SKIP_FONT_NAMES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'math', 'emoji',
  'system-ui', 'inherit', 'initial', 'default',
  'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded',
  '-apple-system', 'blinkmacsystemfont',
  // 仅 macOS / iOS 自带，Windows 上没有，跳过让后面的中文字体生效
  'pingfang sc', 'songti sc', 'heiti sc', 'stheitisc', 'stsong', 'stkaiti',
  'hiragino sans gb', 'harmonyos sans sc',
])

function fontNameFromCss(css: string | undefined): string | undefined {
  if (!css) return undefined
  const parts = String(css)
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
  for (const p of parts) {
    if (SKIP_FONT_NAMES.has(p.toLowerCase())) continue
    if (p.startsWith('-') || p.startsWith('ui-')) continue
    return p
  }
  return undefined
}

/** 是否写成数值（带前导零的工号 / 邮编等必须保持文本） */
function asNumberLiteral(v: string): string | null {
  const s = v.trim()
  if (s === '') return null
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  const intPart = s.replace(/^[+-]/, '').split(/[.eE]/)[0]
  if (/^0\d/.test(intPart)) return null
  return /^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(s) ? s : String(n)
}

/** 网页边框线宽 / 线型 -> SpreadsheetML 的 border style */
function borderStyleName(w: number, s?: string): string {
  const style = (s || 'solid').toLowerCase()
  if (style === 'double') return 'double'
  if (style === 'dotted') return w >= 2 ? 'mediumDashDot' : 'dotted'
  if (style === 'dashed') return w >= 2 ? 'mediumDashed' : 'dashed'
  return w >= 3 ? 'thick' : w >= 2 ? 'medium' : 'thin'
}

// ------------------------------------------------------------------ 样式表

interface FontDef {
  name: string
  size: number
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  color?: string
}
interface BorderDef {
  t?: { style: string; color: string }
  l?: { style: string; color: string }
  b?: { style: string; color: string }
  r?: { style: string; color: string }
}
interface XfDef {
  numFmtId: number
  fontId: number
  fillId: number
  borderId: number
  h?: string
  v?: string
  wrap?: boolean
}

const BUILTIN_BY_CODE = new Map<string, number>()
for (const key of Object.keys(BUILTIN_NUMFMT)) {
  BUILTIN_BY_CODE.set(BUILTIN_NUMFMT[Number(key)], Number(key))
}

function fontXml(f: FontDef): string {
  let x = '<font>'
  if (f.bold) x += '<b/>'
  if (f.italic) x += '<i/>'
  if (f.strike) x += '<strike/>'
  if (f.underline) x += '<u/>'
  x += `<sz val="${f.size}"/>`
  x += `<color rgb="${f.color || 'FF000000'}"/>`
  x += `<name val="${esc(f.name)}"/>`
  return x + '</font>'
}

function borderXml(b: BorderDef): string {
  const side = (tag: string, d?: { style: string; color: string }) =>
    d ? `<${tag} style="${d.style}"><color rgb="${d.color}"/></${tag}>` : `<${tag}/>`
  return (
    '<border>' +
    side('left', b.l) +
    side('right', b.r) +
    side('top', b.t) +
    side('bottom', b.b) +
    '<diagonal/>' +
    '</border>'
  )
}

function fillXml(color?: string): string {
  if (!color) return '<fill><patternFill patternType="none"/></fill>'
  return `<fill><patternFill patternType="solid"><fgColor rgb="${color}"/><bgColor indexed="64"/></patternFill></fill>`
}

function xfXml(x: XfDef): string {
  let attrs =
    `numFmtId="${x.numFmtId}" fontId="${x.fontId}" fillId="${x.fillId}" borderId="${x.borderId}" xfId="0"`
  if (x.numFmtId) attrs += ' applyNumberFormat="1"'
  if (x.fontId) attrs += ' applyFont="1"'
  if (x.fillId) attrs += ' applyFill="1"'
  if (x.borderId) attrs += ' applyBorder="1"'
  const al: string[] = []
  if (x.h) al.push(`horizontal="${x.h}"`)
  if (x.v) al.push(`vertical="${x.v}"`)
  if (x.wrap) al.push('wrapText="1"')
  if (al.length) attrs += ' applyAlignment="1"'
  return al.length ? `<xf ${attrs}><alignment ${al.join(' ')}/></xf>` : `<xf ${attrs}/>`
}

interface StyleBook {
  /** 单元格样式 -> cellXfs 下标 */
  xfOf: (style: CellStyle | undefined) => number
  stylesXml: () => string
}

function createStyleBook(): StyleBook {
  const fonts: string[] = []
  const fontIndex = new Map<string, number>()
  // fills[0] = none, fills[1] = gray125（Excel 约定必须有这两项）
  const fills: string[] = [fillXml(undefined), '<fill><patternFill patternType="gray125"/></fill>']
  const fillIndex = new Map<string, number>()
  const borders: string[] = [borderXml({})]
  const borderIndex = new Map<string, number>()
  const xfs: string[] = []
  const xfIndex = new Map<string, number>()
  const numFmts: { id: number; code: string }[] = []
  const numFmtIndex = new Map<string, number>()
  let nextNumFmtId = 164

  // fonts[0] 固定为默认字体（Normal 样式），顺手登记进索引，避免重复插入
  const defaultFont: FontDef = {
    name: DEFAULT_FONT,
    size: DEFAULT_SIZE_PT,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
  }
  fonts.push(fontXml(defaultFont))
  fontIndex.set(JSON.stringify(defaultFont), 0)

  const fontIdOf = (f: FontDef): number => {
    const key = JSON.stringify(f)
    const hit = fontIndex.get(key)
    if (hit != null) return hit
    const id = fonts.length
    fonts.push(fontXml(f))
    fontIndex.set(key, id)
    return id
  }

  const fillIdOf = (color?: string): number => {
    if (!color) return 0
    const hit = fillIndex.get(color)
    if (hit != null) return hit
    const id = fills.length
    fills.push(fillXml(color))
    fillIndex.set(color, id)
    return id
  }

  const borderIdOf = (st: CellStyle | undefined): number => {
    const b = st?.border
    if (!b) return 0
    const conv = (side?: { w: number; c: string; s?: string }) =>
      side ? { style: borderStyleName(side.w, side.s), color: toArgb(side.c) || 'FF000000' } : undefined
    const def: BorderDef = { t: conv(b.t), l: conv(b.l), b: conv(b.b), r: conv(b.r) }
    if (!def.t && !def.l && !def.b && !def.r) return 0
    const key = JSON.stringify(def)
    const hit = borderIndex.get(key)
    if (hit != null) return hit
    const id = borders.length
    borders.push(borderXml(def))
    borderIndex.set(key, id)
    return id
  }

  const numFmtIdOf = (code?: string): number => {
    if (!code || code === 'General') return 0
    const hit = numFmtIndex.get(code)
    if (hit != null) return hit
    const builtin = BUILTIN_BY_CODE.get(code)
    const id = builtin != null ? builtin : nextNumFmtId++
    if (builtin == null) numFmts.push({ id, code })
    numFmtIndex.set(code, id)
    return id
  }

  const xfOf = (st: CellStyle | undefined): number => {
    const s = st || {}
    const def: XfDef = {
      numFmtId: numFmtIdOf(s.numfmt),
      fontId: fontIdOf({
        name: fontNameFromCss(s.font) || DEFAULT_FONT,
        size: s.size ? pxToPt(s.size) : DEFAULT_SIZE_PT,
        bold: !!s.bold,
        italic: !!s.italic,
        underline: !!s.underline,
        strike: !!s.strike,
        color: toArgb(s.color),
      }),
      fillId: fillIdOf(toArgb(s.bg)),
      borderId: borderIdOf(s),
      // 未设置时沿用网页 .cell 的 CSS 默认：左对齐 + 垂直居中
      h: s.align || 'left',
      v: s.valign === 'top' ? 'top' : s.valign === 'bottom' ? 'bottom' : 'center',
      wrap: !!s.wrap,
    }
    const key = JSON.stringify(def)
    const hit = xfIndex.get(key)
    if (hit != null) return hit
    const id = xfs.length
    xfs.push(xfXml(def))
    xfIndex.set(key, id)
    return id
  }

  const stylesXml = (): string => {
    let x = XML_DECL + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    if (numFmts.length) {
      x += `<numFmts count="${numFmts.length}">`
      for (const f of numFmts) x += `<numFmt numFmtId="${f.id}" formatCode="${esc(f.code)}"/>`
      x += '</numFmts>'
    }
    x += `<fonts count="${fonts.length}">${fonts.join('')}</fonts>`
    x += `<fills count="${fills.length}">${fills.join('')}</fills>`
    x += `<borders count="${borders.length}">${borders.join('')}</borders>`
    x += '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    x += `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>`
    x += '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    x += '</styleSheet>'
    return x
  }

  return { xfOf, stylesXml }
}

// ------------------------------------------------------------------ 工作表

function safeSheetName(name: string, i: number): string {
  let s = String(name || '').replace(/[\\\/\?\*\[\]:]/g, '_').slice(0, 31).trim()
  if (!s) s = `Sheet${i + 1}`
  return s
}

function buildSheetXml(sheet: WriteSheet, sb: StyleBook): string {
  const rowsIn = sheet.rows || []
  // 1x1 的「合并」没有意义，写出去反而会让 Excel 报错
  const merges = (sheet.merges || []).filter((m) => m && m.rs > 0 && m.cs > 0 && (m.rs > 1 || m.cs > 1))
  const colw = sheet.colw || {}
  const rowh = sheet.rowh || {}

  // 合并区：被覆盖的格子跟随锚点（仅用于补齐边框，不写值）
  const covered = new Map<string, string>()
  for (const m of merges) {
    for (let r = m.r; r < m.r + m.rs; r++) {
      for (let c = m.c; c < m.c + m.cs; c++) {
        if (r === m.r && c === m.c) continue
        covered.set(r + ',' + c, m.r + ',' + m.c)
      }
    }
  }

  const cellAt = (r: number, c: number): CellData => rowsIn[r]?.[c] ?? { v: '' }

  /** 该格是否写了内容 */
  const hasContent = (r: number, c: number): boolean => {
    const cell = cellAt(r, c)
    return cell.v != null && String(cell.v).trim() !== ''
  }

  /** 该格是否带边框（边框是表格的可见结构，空单元格也要保留，否则整行看起来没边框） */
  const hasBorder = (st?: CellStyle): boolean =>
    !!(st?.border && (st.border.t || st.border.l || st.border.b || st.border.r))

  /**
   * 该格是否要写进 xlsx：
   *  - 有内容 → 写（带全部样式，含底色）；
   *  - 没内容但带边框 → 也要写（只保留边框/字体等结构样式，底色剥离，见下方处理），
   *    否则空单元格的边框在导出后会整片消失，导致"最后一行没边框"；
   *  - 既没内容也没边框 → 不写，保持 Excel 默认的空白（不会出现"空白格被整片上色"）。
   * 注意：合并区跟随锚点——只有锚点有内容时才写出，保证边框连续且不过度输出空格。
   */
  const present = (r: number, c: number): boolean => {
    const src = covered.get(r + ',' + c)
    if (src) {
      const [ar, ac] = src.split(',').map(Number)
      return hasContent(ar, ac)
    }
    const cell = cellAt(r, c)
    return hasContent(r, c) || hasBorder(cell.s)
  }

  let maxR = -1
  let maxC = -1
  for (let r = 0; r < rowsIn.length; r++) {
    for (let c = 0; c < (rowsIn[r]?.length ?? 0); c++) {
      if (!present(r, c)) continue
      if (r > maxR) maxR = r
      if (c > maxC) maxC = c
    }
  }
  for (const m of merges) {
    maxR = Math.max(maxR, m.r + m.rs - 1)
    maxC = Math.max(maxC, m.c + m.cs - 1)
  }
  for (const k of Object.keys(colw)) maxC = Math.max(maxC, Number(k))
  if (maxR < 0) maxR = 0
  if (maxC < 0) maxC = 0

  // 公式求值用的取数器（取原始文本，公式单元格交给 Excel 自己重算）
  const getter = (ref: string): string => {
    const m = /^([A-Z]+)(\d+)$/i.exec(String(ref).trim())
    if (!m) return ''
    const c = colToIndex(m[1].toUpperCase())
    const r = parseInt(m[2], 10) - 1
    return cellAt(r, c).v ?? ''
  }

  // ---- cols ----
  let colsXml = ''
  if (maxC >= 0) {
    const parts: string[] = []
    for (let c = 0; c <= maxC; c++) {
      const w = colw[c] ? pxToColWidth(colw[c]) : pxToColWidth(DEFAULT_COL_PX)
      parts.push(`<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`)
    }
    colsXml = `<cols>${parts.join('')}</cols>`
  }

  // ---- sheetData ----
  const rowXml: string[] = []
  for (let r = 0; r <= maxR; r++) {
    const cells: string[] = []
    for (let c = 0; c <= maxC; c++) {
      const key = r + ',' + c
      const isCovered = covered.has(key)
      if (!isCovered && !present(r, c)) continue
      const srcKey = isCovered ? covered.get(key)! : key
      const [sr, sc] = srcKey.split(',').map(Number)
      const cell = cellAt(sr, sc)
      // 被合并覆盖的格子不写值，但沿用锚点样式，保证边框连续
      let style = cell.s
      // 没写内容的空格子：保留边框 / 字体等结构样式，但剥离底色，
      // 避免"空白格被整片上色"，同时不让边框在导出后丢失
      if (!hasContent(sr, sc) && style) {
        const { bg: _bg, ...rest } = style
        style = Object.keys(rest).length ? rest : undefined
      }
      const sIdx = sb.xfOf(style)
      const ref = indexToCol(c) + (r + 1)
      let inner = ''
      if (!isCovered) {
        const raw = cell.v == null ? '' : String(cell.v)
        if (raw.startsWith('=')) {
          const formula = raw.slice(1).trim()
          const cached = evalFormula(raw, getter)
          inner = `<f>${esc(formula)}</f>`
          const num = asNumberLiteral(cached)
          if (num != null) inner += `<v>${num}</v>`
        } else if (raw === '') {
          inner = ''
        } else {
          const num = asNumberLiteral(raw)
          if (num != null) inner = `<v>${num}</v>`
          else inner = `<is><t xml:space="preserve">${esc(raw)}</t></is>`
        }
      }
      const tAttr = inner.startsWith('<is>') ? ' t="inlineStr"' : ''
      cells.push(inner === '' ? `<c r="${ref}" s="${sIdx}"${tAttr}/>` : `<c r="${ref}" s="${sIdx}"${tAttr}>${inner}</c>`)
    }
    if (cells.length === 0 && !rowh[r]) continue
    const ht = rowh[r] ? ` ht="${pxToPt(rowh[r])}" customHeight="1"` : ''
    rowXml.push(`<row r="${r + 1}"${ht}>${cells.join('')}</row>`)
  }

  // ---- mergeCells ----
  let mergeXml = ''
  if (merges.length) {
    mergeXml =
      `<mergeCells count="${merges.length}">` +
      merges
        .map(
          (m) =>
            `<mergeCell ref="${indexToCol(m.c)}${m.r + 1}:${indexToCol(m.c + m.cs - 1)}${m.r + m.rs}"/>`
        )
        .join('') +
      '</mergeCells>'
  }

  const dim = `A1:${indexToCol(maxC)}${maxR + 1}`

  return (
    XML_DECL +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<dimension ref="${dim}"/>` +
    '<sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
    `<sheetFormatPr defaultRowHeight="${pxToPt(DEFAULT_ROW_PX)}" defaultColWidth="${pxToColWidth(DEFAULT_COL_PX)}"/>` +
    colsXml +
    `<sheetData>${rowXml.join('')}</sheetData>` +
    mergeXml +
    '</worksheet>'
  )
}

// ------------------------------------------------------------------ 入口

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** 生成 .xlsx 字节流 */
export function writeXlsx(sheets: WriteSheet[]): Uint8Array {
  const list = sheets && sheets.length ? sheets : [{ name: 'Sheet1', rows: [[{ v: '' }]] }]
  const sb = createStyleBook()

  const names: string[] = []
  const used = new Set<string>()
  list.forEach((s, i) => {
    let n = safeSheetName(s.name, i)
    if (used.has(n)) {
      let k = 2
      while (used.has(`${n.slice(0, 28)}(${k})`)) k++
      n = `${n.slice(0, 28)}(${k})`
    }
    used.add(n)
    names.push(n)
  })

  const files: Record<string, Uint8Array> = {}

  const overrides = list
    .map(
      (_s, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
    .join('')
  files['[Content_Types].xml'] = strToU8(
    XML_DECL +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      overrides +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>'
  )

  files['_rels/.rels'] = strToU8(
    XML_DECL +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>` +
      '</Relationships>'
  )

  files['xl/workbook.xml'] = strToU8(
    XML_DECL +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
      ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets>' +
      list
        .map(
          (_s, i) =>
            `<sheet name="${esc(names[i])}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
        )
        .join('') +
      '</sheets>' +
      '</workbook>'
  )

  const rels =
    list.map((_s, i) => `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${list.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/>`
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    XML_DECL +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      rels +
      '</Relationships>'
  )

  list.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(buildSheetXml(s, sb))
  })
  files['xl/styles.xml'] = strToU8(sb.stylesXml())

  return zipSync(files, { level: 6 })
}
