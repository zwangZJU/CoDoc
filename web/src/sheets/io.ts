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

/**
 * 读取表格文件，返回各 sheet 的完整模型（值 / 样式 / 合并 / 列宽行高）。
 * 优先走自建的高保真 OOXML 解析；非 xlsx 容器时回退到 SheetJS。
 */
export async function importWorkbook(file: File): Promise<ImportedSheet[]> {
  const data = new Uint8Array(await file.arrayBuffer())
  try {
    const full = readXlsxFull(data)
    if (full.length) return full
  } catch (e) {
    const msg = errMsg(e)
    if (!msg.startsWith('NOT_ZIP') && !msg.startsWith('NOT_XLSX')) {
      throw new Error('无法解析该文件：' + msg)
    }
    // 非 zip 容器或结构异常：走兜底
  }
  return fallbackImport(data)
}
