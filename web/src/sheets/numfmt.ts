/**
 * 极简 Excel 数字格式（numFmt）子集实现。
 * 覆盖日常办公表里最常见的：General / 千分位 / 小数位 / 百分比 / 货币 / 日期 / 时间。
 * 解析不了的格式会安全回退：数字原样输出。
 */

/** Excel 内置格式码（常用部分） */
export const BUILTIN_NUMFMT: Record<number, string> = {
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  5: '$#,##0_);($#,##0)',
  6: '$#,##0_);[Red]($#,##0)',
  7: '$#,##0.00_);($#,##0.00)',
  8: '$#,##0.00_);[Red]($#,##0.00)',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  14: 'm/d/yy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yy h:mm',
  37: '#,##0_);(#,##0)',
  38: '#,##0_);[Red](#,##0)',
  39: '#,##0.00_);(#,##0.00)',
  40: '#,##0.00_);[Red](#,##0.00)',
  41: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)',
  42: '_("$"* #,##0_);_("$"* (#,##0);_("$"* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)',
  44: '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mmss.0',
  48: '##0.0E+0',
  49: '@',
}

/** 去掉被引号包裹的字面量、转义字符与 [条件]/[颜色]/[区域] 片段后的格式骨架 */
function skeleton(fmt: string): string {
  let out = ''
  let i = 0
  while (i < fmt.length) {
    const ch = fmt[i]
    if (ch === '"') {
      const j = fmt.indexOf('"', i + 1)
      i = j < 0 ? fmt.length : j + 1
      continue
    }
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '[') {
      const j = fmt.indexOf(']', i)
      i = j < 0 ? fmt.length : j + 1
      continue
    }
    if (ch === '_' || ch === '*') {
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out
}

/** 该格式是否为日期/时间格式 */
export function isDateTimeFormat(fmt: string | undefined): boolean {
  if (!fmt) return false
  const code = BUILTIN_NUMFMT[Number(fmt)] ?? fmt
  if (code === 'General' || code === '@') return false
  return /[ydhms]/i.test(skeleton(code))
}

/** 取格式化使用的格式码 */
function resolveCode(fmt: string | undefined): string {
  if (!fmt) return 'General'
  const asNum = Number(fmt)
  if (Number.isFinite(asNum) && fmt.trim() !== '') {
    return BUILTIN_NUMFMT[asNum] ?? 'General'
  }
  return fmt
}

/** 按 ';' 分段（忽略引号/方括号内） */
function splitSections(fmt: string): string[] {
  const out: string[] = []
  let cur = ''
  let i = 0
  while (i < fmt.length) {
    const ch = fmt[i]
    if (ch === '"') {
      const j = fmt.indexOf('"', i + 1)
      const seg = j < 0 ? fmt.slice(i) : fmt.slice(i, j + 1)
      cur += seg
      i += seg.length
      continue
    }
    if (ch === '[') {
      const j = fmt.indexOf(']', i)
      const seg = j < 0 ? fmt.slice(i) : fmt.slice(i, j + 1)
      cur += seg
      i += seg.length
      continue
    }
    if (ch === ';') {
      out.push(cur)
      cur = ''
      i++
      continue
    }
    cur += ch
    i++
  }
  out.push(cur)
  return out
}

/** 字面量去壳："abc" -> abc，\x -> x，[..] 丢弃，_x / *x 丢弃 */
function stripDecorations(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === '"') {
      const j = s.indexOf('"', i + 1)
      if (j < 0) break
      out += s.slice(i + 1, j)
      i = j + 1
      continue
    }
    if (ch === '\\') {
      out += s[i + 1] ?? ''
      i += 2
      continue
    }
    if (ch === '[') {
      const j = s.indexOf(']', i)
      i = j < 0 ? s.length : j + 1
      continue
    }
    if (ch === '_' || ch === '*') {
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out
}

const MONTH_FULL = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月']
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEK_FULL = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
const WEEK_SHORT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** Excel 序列号 -> Date（1900 日期系统，修正闰年 bug） */
export function serialToDate(serial: number): Date {
  // Excel 60 = 1900-02-29（并不存在），序列号 >= 60 需减去这一天
  const adjusted = serial >= 60 ? serial - 1 : serial
  return new Date(Date.UTC(1899, 11, 31) + Math.round(adjusted * 86400000))
}

/** 用日期/时间码渲染 */
function formatDateCode(code: string, d: Date): string {
  // 使用本地时区：上面构造时用了 UTC 基准，读取也用 UTC 才能保持一致
  const Y = d.getUTCFullYear()
  const M = d.getUTCMonth() + 1
  const D = d.getUTCDate()
  const h = d.getUTCHours()
  const mi = d.getUTCMinutes()
  const se = d.getUTCSeconds()
  const week = d.getUTCDay()

  let res = ''
  let i = 0
  let inTime = false
  const pad = (n: number) => String(n).padStart(2, '0')

  while (i < code.length) {
    const ch = code[i]
    if (ch === '"') {
      const j = code.indexOf('"', i + 1)
      if (j < 0) {
        i++
        continue
      }
      res += code.slice(i + 1, j)
      i = j + 1
      continue
    }
    if (ch === '\\') {
      res += code[i + 1] ?? ''
      i += 2
      continue
    }
    if (ch === '[') {
      const j = code.indexOf(']', i)
      i = j < 0 ? code.length : j + 1
      continue
    }
    const low = ch.toLowerCase()
    const run = (predicate: (c: string) => boolean) => {
      let n = 0
      while (i + n < code.length && predicate(code[i + n].toLowerCase())) n++
      return n
    }

    if (low === 'y') {
      const n = run((c) => c === 'y')
      res += n >= 3 ? String(Y) : pad(Y % 100)
      i += n
      inTime = false
      continue
    }
    if (low === 'd') {
      const n = run((c) => c === 'd')
      if (n >= 4) res += WEEK_FULL[week]
      else if (n === 3) res += WEEK_SHORT[week]
      else res += n === 2 ? pad(D) : String(D)
      i += n
      inTime = false
      continue
    }
    if (low === 'h') {
      const n = run((c) => c === 'h')
      res += n >= 2 ? pad(h) : String(h)
      i += n
      inTime = true
      continue
    }
    if (low === 's') {
      const n = run((c) => c === 's')
      res += n >= 2 ? pad(se) : String(se)
      i += n
      inTime = true
      continue
    }
    if (low === 'm') {
      const n = run((c) => c === 'm')
      if (inTime) {
        res += n >= 2 ? pad(mi) : String(mi)
      } else if (n >= 5) {
        res += MONTH_SHORT[M - 1].slice(0, 1)
      } else if (n === 4) {
        res += MONTH_FULL[M - 1]
      } else if (n === 3) {
        res += MONTH_SHORT[M - 1]
      } else {
        res += n === 2 ? pad(M) : String(M)
      }
      i += n
      continue
    }
    if (/^am\/pm/i.test(code.slice(i, i + 5))) {
      res += h < 12 ? 'AM' : 'PM'
      i += 5
      inTime = true
      continue
    }
    if (/^a\/p/i.test(code.slice(i, i + 3))) {
      res += h < 12 ? 'A' : 'P'
      i += 3
      inTime = true
      continue
    }
    if (/^(上午\/下午)/.test(code.slice(i, i + 5))) {
      res += h < 12 ? '上午' : '下午'
      i += 5
      inTime = true
      continue
    }
    res += ch
    i++
  }
  return res
}

/** 渲染单个数值段（不含 ';'） */
function formatNumberSection(value: number, section: string): string {
  const cleaned = section.replace(/\[[^\]]*\]/g, '')
  const coreMatch = /[#?0][#?0,]*(\.[#?0]*)?/.exec(cleaned)
  if (!coreMatch) return stripDecorations(cleaned)

  const beforeRaw = cleaned.slice(0, coreMatch.index)
  const afterRaw = cleaned.slice(coreMatch.index + coreMatch[0].length)
  const core = coreMatch[0]

  const dot = core.indexOf('.')
  let intPat = dot >= 0 ? core.slice(0, dot) : core
  const decPat = dot >= 0 ? core.slice(dot + 1) : null
  const thousand = intPat.includes(',')
  intPat = intPat.replace(/,/g, '')
  const forcedInt = (intPat.match(/0/g) || []).length

  const pctCount = (cleaned.match(/%/g) || []).length
  let v = value * Math.pow(100, pctCount)
  const negative = v < 0
  v = Math.abs(v)

  const decimals = decPat ? decPat.length : 0
  let fixed = v.toFixed(Math.min(decimals, 20))
  let [ip, dp] = fixed.split('.')
  if (thousand) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  if (ip.length < forcedInt) ip = '0'.repeat(forcedInt - ip.length) + ip

  let numStr = dp && decimals > 0 ? ip + '.' + dp : ip
  if (dp) {
    const forcedDec = (decPat!.match(/0/g) || []).length
    let s = numStr
    while (s.includes('.') && s.endsWith('0') && s.split('.')[1].length > forcedDec) s = s.slice(0, -1)
    if (s.endsWith('.')) s = s.slice(0, -1)
    numStr = s
  }

  const before = stripDecorations(beforeRaw)
  let after = stripDecorations(afterRaw)
  // 科学计数：E+00 / E-00
  const sci = after.match(/E([+-])(0+)/i)
  if (sci) {
    const digits = sci[2].length
    let exp = v === 0 ? '0' : v.toExponential(digits)
    let [mant, e] = exp.split('e')
    if (thousand) mant = mant // 科学计数不做千分位
    const sign = Number(e) >= 0 ? (sci[1] === '-' ? '' : '+') : '-'
    after = after.replace(sci[0], '')
    return before + (negative ? '-' : '') + mant + 'E' + sign + Math.abs(Number(e)).toString().padStart(digits, '0')
  }
  after = after.replace(/%/g, '')
  return before + (negative ? '-' : '') + numStr + after
}

function isNumericLike(s: string): boolean {
  return s.trim() !== '' && Number.isFinite(Number(s))
}

/**
 * 按 Excel 格式码格式化单元格取值。
 * - 非数字：原样返回
 * - 日期/时间码：走日期通道
 * - 其余：走数值通道（支持 ';' 分段）
 */
export function formatByNumFmt(value: string, fmt: string | undefined): string {
  if (value === '') return ''
  if (!isNumericLike(value)) return value
  if (!fmt) return value
  const code = resolveCode(fmt)
  if (code === 'General' || code === '@') return value

  const num = Number(value)

  if (isDateTimeFormat(code)) {
    try {
      const d = serialToDate(num)
      if (Number.isNaN(d.getTime())) return value
      return formatDateCode(code, d)
    } catch {
      return value
    }
  }

  const sections = splitSections(code)
  // Excel 语义：第 2 段（负数）作用于绝对值，由该段自己决定是否带负号或括号
  const useAbs = num < 0 && !!sections[1]
  const source = useAbs ? Math.abs(num) : num
  const section = useAbs ? sections[1] : num === 0 && sections[2] ? sections[2] : sections[0]
  try {
    return formatNumberSection(source, section || 'General')
  } catch {
    return value
  }
}

/** 数值型单元格的默认显示（General）：去掉浮点尾巴 */
export function generalNumber(s: string): string {
  if (!isNumericLike(s)) return s
  const n = Number(s)
  if (Number.isInteger(n)) return String(n)
  const fixed = String(Math.round(n * 1e10) / 1e10)
  return fixed
}
