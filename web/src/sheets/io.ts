import * as XLSX from 'xlsx'
import type { CellData, MergeInfo } from './useSheet'
import { readXlsxFull } from './xlsxRead'
import { writeXlsx } from './xlsxWrite'
import { download } from '../store/exporters'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export interface ImportedSheet {
  name: string
  rows: CellData[][]
  merges: MergeInfo[]
  /** 列宽（px），key = 列索引 */
  colw: Record<number, number>
  /** 行高（px），key = 行索引 */
  rowh: Record<number, number>
}

export interface ExportSheet {
  name: string
  rows: CellData[][]
  merges?: MergeInfo[]
  colw?: Record<number, number>
  rowh?: Record<number, number>
}

/**
 * 导出工作簿（多 sheet），浏览器直接下载 .xlsx。
 *
 * 走自建的 OOXML 写出器（xlsxWrite），字体 / 颜色 / 边框 / 对齐 / 数字格式 /
 * 合并 / 列宽行高 / 公式全部保留 —— 与网页上看到的完全一致。
 */
export function exportWorkbook(sheets: ExportSheet[], filename: string) {
  download(filename, XLSX_MIME, writeXlsx(sheets))
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** SheetJS 兜底：.xls / .csv / 结构异常的 xlsx，只读数值、不带样式 */
function fallbackImport(data: Uint8Array): ImportedSheet[] {
  let wb: XLSX.WorkBook
  try {
    wb = XLSX.read(data, { type: 'array', cellDates: true })
  } catch (e) {
    throw new Error('无法解析该文件，请确认是有效的 .xlsx / .xls：' + errMsg(e))
  }
  if (!wb.SheetNames || wb.SheetNames.length === 0) {
    throw new Error('文件中没有任何工作表')
  }
  return wb.SheetNames.map((name: string) => {
    const ws = wb.Sheets[name]
    let rows: CellData[][] = []
    if (ws) {
      try {
        const aoa = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][]
        const ref = XLSX.utils.decode_range(ws['!ref'] || 'A1')
        const colCount = ref.e.c - ref.s.c + 1
        rows = []
        for (let r = 0; r < aoa.length; r++) {
          const src = Array.isArray(aoa[r]) ? aoa[r] : [aoa[r]]
          const line: CellData[] = new Array(colCount)
          for (let c = 0; c < colCount; c++) {
            const v = src[c]
            line[c] = { v: v == null || typeof v === 'undefined' ? '' : String(v) }
          }
          rows.push(line)
        }
      } catch {
        rows = []
      }
    }
    return { name, rows, merges: [], colw: {}, rowh: {} }
  })
}

/** 单元格算不算「有内容」 */
function hasText(v: unknown): boolean {
  return v != null && String(v).trim() !== ''
}

/**
 * 导入归一化：把解析出来的原始表格整理成结构干净的模型。
 *
 * 1. 合并区裁到表格边界内；1×1 的假合并丢掉；互相重叠的只保留先出现的
 *    ——重叠的合并区会让 colSpan / rowSpan 打架，整张表的结构直接错位；
 * 2. 被合并覆盖的格子里如果还有字，回收到锚点
 *    ——覆盖区在渲染时是不显示的，不回收就变成「导入后文字消失了」；
 * 3. 裁掉多余的空行空列，导入后不会凭空多出一片空单元格。
 */
export function normalizeImportedSheet(sheet: ImportedSheet): ImportedSheet {
  const rows: CellData[][] = (sheet.rows || []).map((r) =>
    Array.isArray(r)
      ? r.map((c) => (c && typeof c === 'object' && 'v' in c ? { ...(c as CellData) } : { v: '' }))
      : []
  )
  const rowCount = rows.length
  const colCount = rows.reduce((n, r) => Math.max(n, r.length), 0)
  // 先摊平成矩形：合并计算与表格渲染都要求每行等长，否则列会错位
  for (const r of rows) while (r.length < colCount) r.push({ v: '' })

  // 1) 合并区整理
  const merges: MergeInfo[] = []
  const taken = new Set<string>()
  for (const m of sheet.merges || []) {
    if (!m || !Number.isFinite(m.r) || !Number.isFinite(m.c)) continue
    if (m.r < 0 || m.c < 0 || m.r >= rowCount || m.c >= colCount) continue
    const rs = Math.max(1, Math.min(Math.floor(m.rs || 1), rowCount - m.r))
    const cs = Math.max(1, Math.min(Math.floor(m.cs || 1), colCount - m.c))
    if (rs === 1 && cs === 1) continue
    let overlap = false
    for (let r = m.r; r < m.r + rs && !overlap; r++)
      for (let c = m.c; c < m.c + cs && !overlap; c++) if (taken.has(r + ',' + c)) overlap = true
    if (overlap) continue
    for (let r = m.r; r < m.r + rs; r++)
      for (let c = m.c; c < m.c + cs; c++) taken.add(r + ',' + c)
    merges.push({ r: m.r, c: m.c, rs, cs })
  }

  // 2) 覆盖区里的文字回收到锚点
  for (const m of merges) {
    const anchor = rows[m.r][m.c]
    if (hasText(anchor?.v)) continue
    let moved = false
    for (let r = m.r; r < m.r + m.rs && !moved; r++) {
      for (let c = m.c; c < m.c + m.cs && !moved; c++) {
        if (r === m.r && c === m.c) continue
        const cell = rows[r][c]
        if (!hasText(cell?.v)) continue
        rows[m.r][m.c] = { v: String(cell.v), s: anchor?.s ?? cell.s }
        cell.v = ''
        moved = true
      }
    }
  }

  // 3) 裁到实际尺寸（有内容的格子 + 合并区下沿）
  let maxR = -1
  let maxC = -1
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      if (!hasText(rows[r][c]?.v)) continue
      if (r > maxR) maxR = r
      if (c > maxC) maxC = c
    }
  }
  for (const m of merges) {
    if (m.r + m.rs - 1 > maxR) maxR = m.r + m.rs - 1
    if (m.c + m.cs - 1 > maxC) maxC = m.c + m.cs - 1
  }
  const R = Math.max(maxR + 1, 1)
  const C = Math.max(maxC + 1, 1)
  const outRows = rows.slice(0, R).map((r) => r.slice(0, C))
  for (const r of outRows) while (r.length < C) r.push({ v: '' })

  const colw: Record<number, number> = {}
  Object.keys(sheet.colw || {}).forEach((k) => {
    const i = Number(k)
    if (Number.isFinite(i) && i >= 0 && i < C) colw[i] = Math.round(sheet.colw[i])
  })
  const rowh: Record<number, number> = {}
  Object.keys(sheet.rowh || {}).forEach((k) => {
    const i = Number(k)
    if (Number.isFinite(i) && i >= 0 && i < R) rowh[i] = Math.round(sheet.rowh[i])
  })

  return { name: sheet.name, rows: outRows, merges, colw, rowh }
}

/**
 * 读取表格文件，返回各 sheet 的完整模型（值 / 样式 / 合并 / 列宽行高）。
 * 优先走自建的高保真 OOXML 解析；非 xlsx 容器时回退到 SheetJS。
 */
export async function importWorkbook(file: File): Promise<ImportedSheet[]> {
  const data = new Uint8Array(await file.arrayBuffer())
  try {
    const full = readXlsxFull(data)
    if (full.length) return full.map(normalizeImportedSheet)
  } catch (e) {
    const msg = errMsg(e)
    if (!msg.startsWith('NOT_ZIP') && !msg.startsWith('NOT_XLSX')) {
      throw new Error('无法解析该文件：' + msg)
    }
    // 非 zip 容器或结构异常：走兜底
  }
  return fallbackImport(data).map(normalizeImportedSheet)
}
