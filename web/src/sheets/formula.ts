import { colToIndex, indexToCol } from './refs'

/**
 * 轻量公式引擎（MVP）：支持
 *   - 单元格引用：A1, B2 ...
 *   - 四则运算：+ - * /
 *   - 区域求和：SUM(A1:B10) / SUM(A1, B2, C3)
 * 原始公式字符串仍写入 Yjs（协同同步），计算结果仅在视图层展示。
 * 若单元格不以 "=" 开头，原样返回。
 */
export function evalFormula(
  input: string,
  getCell: (ref: string) => string
): string {
  if (!input.startsWith('=')) return input
  let expr = input.slice(1).trim()
  try {
    // SUM(区域 | 单格, ...)
    expr = expr.replace(/SUM\(\s*([^)]+)\s*\)/gi, (_m, inside) => {
      const parts = String(inside).split(',').map((s) => s.trim())
      let sum = 0
      for (const part of parts) {
        const range = part.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i)
        if (range) {
          const c1 = colToIndex(range[1])
          const r1 = parseInt(range[2], 10) - 1
          const c2 = colToIndex(range[3])
          const r2 = parseInt(range[4], 10) - 1
          const cMin = Math.min(c1, c2)
          const cMax = Math.max(c1, c2)
          const rMin = Math.min(r1, r2)
          const rMax = Math.max(r1, r2)
          for (let r = rMin; r <= rMax; r++)
            for (let c = cMin; c <= cMax; c++) {
              const v = parseFloat(getCell(indexToCol(c) + (r + 1)))
              if (!isNaN(v)) sum += v
            }
        } else {
          const v = parseFloat(getCell(part.toUpperCase()))
          if (!isNaN(v)) sum += v
        }
      }
      return String(sum)
    })

    // 单元格引用 -> 数值
    expr = expr.replace(/([A-Z]+\d+)/g, (ref) => {
      const v = getCell(ref.toUpperCase())
      const n = parseFloat(v)
      return isNaN(n) ? '0' : String(n)
    })

    // 安全校验：仅允许数字与运算符
    if (!/^[-+*/().\s\d,]+$/.test(expr)) return '#ERR'

    const val = Function('"use strict"; return (' + expr + ')')() as number
    if (typeof val !== 'number' || !isFinite(val)) return '#ERR'
    return String(Math.round(val * 1e10) / 1e10)
  } catch {
    return '#ERR'
  }
}
