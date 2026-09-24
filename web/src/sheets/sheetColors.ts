/**
 * 表格调色板（对齐飞书表格的取色面板）
 * 结构：6 行 × 10 列
 *   · 第 0 列：无颜色 + 灰阶 6 档
 *   · 第 1~9 列：9 个色相（蓝 / 青 / 绿 / 黄绿 / 黄 / 橙 / 红 / 玫红 / 紫）
 *   · 第 0 行：各色相标准色（最常用，面板首行）
 *   · 第 1~5 行：由浅到深的色阶
 * '' 表示「无颜色」（文字色 → 恢复默认深色；填充色 → 透明）
 */

/** 9 个色相 × 6 档（浅 → 深），第 0 档为标准色 */
const HUE_STEPS: string[][] = [
  ['#3370FF', '#E8F3FF', '#BEDAFF', '#94BFFF', '#6AA1FF', '#165DFF'], // 蓝
  ['#14C9C9', '#E8FFFB', '#B5F5EC', '#7AE0D5', '#40C3BB', '#0AA5A5'], // 青
  ['#00B42A', '#E8FFEA', '#AFF0B5', '#7BE188', '#4CD263', '#009A29'], // 绿
  ['#9FDB1D', '#F0FFE0', '#D6F5A8', '#BEE86A', '#A0D948', '#5FA511'], // 黄绿
  ['#FADC19', '#FEFFE8', '#FFF7A6', '#FFEE6B', '#FFE85C', '#E5C400'], // 黄
  ['#FF7D00', '#FFF7E8', '#FFE4BA', '#FFC896', '#FFB65D', '#FF9A2E'], // 橙
  ['#F53F3F', '#FFECE8', '#FDCDC5', '#FBACA3', '#F76965', '#CB2634'], // 红
  ['#F5319D', '#FFE8F1', '#FDC9E5', '#FBA4D0', '#F765A3', '#CB2E78'], // 玫红
  ['#722ED1', '#F5E8FF', '#E8D6FF', '#CFA9FF', '#B37FEB', '#8D4EDA'], // 紫
]

/** 灰阶列（第 0 行是「无颜色」） */
const GREY_STEPS = ['', '#F2F3F5', '#E5E6EB', '#C9CDD4', '#86909C', '#1D2129']

/** 6 行 × 10 列调色板 */
export const PALETTE: string[][] = Array.from({ length: 6 }, (_, row) => [
  GREY_STEPS[row],
  ...HUE_STEPS.map((steps) => steps[row]),
])

/** 面板首行的常用色（去掉「无颜色」，用于紧凑取色场景） */
export const STANDARD_COLORS: string[] = PALETTE[0].slice(1)

/** 默认字体色 / 默认填充（与单元格样式缺省值一致） */
export const DEFAULT_TEXT_COLOR = '#111827'

/** 颜色名（用于 title 提示，命中不到时回退 hex 本身） */
const NAMES: Record<string, string> = {
  '': '无颜色',
  '#F2F3F5': '浅灰',
  '#E5E6EB': '灰',
  '#C9CDD4': '中灰',
  '#86909C': '深灰',
  '#1D2129': '近黑',
}
export const colorName = (hex: string) => NAMES[hex] || hex.toUpperCase()
