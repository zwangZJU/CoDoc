/**
 * 右侧智能问答窗口（对齐飞书表格的 AI 助手面板）
 *
 * 布局：头部（标题 / 收起） → 消息流（用户气泡 + 助手分步卡片 + 终端行） → 输入区（引用 chip / 工具行 / 发送）
 *
 * 说明：本轮只做前端 UI 与本地能力（选区统计、表头与重复值核对等真实计算），
 * 尚未接大模型。接入真实 Agent 时，只需把 handleSend 里的 plan() 换成
 * 调用后端接口（见 api.aiChat 的预留位），消息结构无需改动。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SheetApi } from './useSheet'
import { Ico } from './sheetIcons'
import { MenuItem, TbPop } from './SheetToolbar'
import { api } from '../store/api'

interface Props {
  sheet: SheetApi
  range: { r1: number; c1: number; r2: number; c2: number }
  /** 当前选区引用文案，如 A1 或 A1:C5 */
  selRef: string
  /** 当前文档 id（用于按文档隔离 Hermes 会话与上下文） */
  docId?: string
  onClose: () => void
  onNotify: (msg: string) => void
}

interface Step {
  title: string
  body?: string
  terminal?: string
}

type Msg =
  | { id: number; role: 'user'; text: string; quote?: string }
  | { id: number; role: 'assistant'; step: Step }

const SUGGESTIONS = [
  { icon: 'sum' as const, text: '统计当前选区的求和、平均与计数' },
  { icon: 'check' as const, text: '检查选区里的表头缺失与重复值' },
  { icon: 'sparkle' as const, text: '按这份表格的字段，起草一段品牌文案' },
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export default function AIPanel({ sheet, range, selRef, docId, onClose, onNotify }: Props) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [useCtx, setUseCtx] = useState(true)
  const [model, setModel] = useState<'高' | '中' | '低'>('高')
  const [withCloud, setWithCloud] = useState(false)
  const [attachments, setAttachments] = useState<{ name: string; mime: string; data: string }[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const idRef = useRef(0)
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const aliveRef = useRef(true)
  useEffect(() => () => void (aliveRef.current = false), [])

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' })
  }, [msgs, busy])

  /* ---------------- 附件（多模态图片）：读取为 data:image 地址 ---------------- */
  const pickFiles = (list: FileList | null) => {
    if (!list) return
    const imgs = Array.from(list).filter((f) => f.type.startsWith('image/'))
    const others = Array.from(list).filter((f) => !f.type.startsWith('image/'))
    if (others.length) onNotify(`暂只支持图片附件（${others[0].name} 已忽略）`)
    if (!imgs.length) return
    for (const f of imgs.slice(0, 4)) {
      const reader = new FileReader()
      reader.onload = () => {
        setAttachments((prev) =>
          prev.length >= 4 ? prev : [...prev, { name: f.name, mime: f.type, data: String(reader.result) }]
        )
      }
      reader.readAsDataURL(f)
    }
  }

  /* ---------------- 本地能力：真实统计 / 核对 ---------------- */

  const rangeSize = useMemo(() => {
    const rows = range.r2 - range.r1 + 1
    const cols = range.c2 - range.c1 + 1
    return { rows, cols }
  }, [range])

  const collectNumbers = () => {
    const nums: number[] = []
    for (let r = range.r1; r <= range.r2; r++) {
      for (let c = range.c1; c <= range.c2; c++) {
        const raw = (sheet.rows[r]?.[c]?.v ?? '').trim()
        if (!raw) continue
        const n = Number(raw.replace(/[,¥$%\s]/g, ''))
        if (!isNaN(n)) nums.push(n)
      }
    }
    return nums
  }

  const statsStep = (): Step => {
    const nums = collectNumbers()
    if (!nums.length) {
      return {
        title: '统计选区',
        body: `当前选区 ${selRef} 里没有可参与计算的数字，先确认一下是不是选错了区域。`,
      }
    }
    const sum = nums.reduce((a, b) => a + b, 0)
    const avg = sum / nums.length
    const max = Math.max(...nums)
    const min = Math.min(...nums)
    return {
      title: '统计选区',
      body: `${selRef} 共 ${rangeSize.rows} 行 × ${rangeSize.cols} 列，其中数字 ${
        nums.length
      } 个：求和 ${round(sum)}、平均 ${round(avg)}、最大 ${round(max)}、最小 ${round(min)}。`,
      terminal: `已核算 ${selRef}：SUM=${round(sum)} AVERAGE=${round(avg)} COUNT=${nums.length}`,
    }
  }

  const lintSteps = (): Step[] => {
    const out: Step[] = []
    // 1) 表头空值
    const emptyHeaders: string[] = []
    for (let c = range.c1; c <= range.c2; c++) {
      if (!(sheet.rows[range.r1]?.[c]?.v ?? '').trim()) emptyHeaders.push(colName(c))
    }
    out.push({
      title: '检查表头',
      body: emptyHeaders.length
        ? `第 ${range.r1 + 1} 行有 ${emptyHeaders.length} 个空表头：${emptyHeaders.join('、')}。建议补上字段名，否则后续筛选与统计容易错位。`
        : `第 ${range.r1 + 1} 行表头完整，没有空字段。`,
    })
    // 2) 重复值（按第一列判断）
    const seen = new Map<string, number[]>()
    for (let r = range.r1 + 1; r <= range.r2; r++) {
      const v = (sheet.rows[r]?.[range.c1]?.v ?? '').trim()
      if (!v) continue
      const arr = seen.get(v) || []
      arr.push(r + 1)
      seen.set(v, arr)
    }
    const dups = Array.from(seen.entries()).filter(([, rows]) => rows.length > 1)
    out.push({
      title: '核查重复值',
      body: dups.length
        ? `「${colName(range.c1)}」列有 ${dups.length} 组重复：${dups
            .slice(0, 5)
            .map(([v, rows]) => `${v}（第 ${rows.join('、')} 行）`)
            .join('；')}${dups.length > 5 ? ' 等' : ''}。`
        : `「${colName(range.c1)}」列没有重复值。`,
    })
    // 3) 空单元格
    let blanks = 0
    for (let r = range.r1; r <= range.r2; r++) {
      for (let c = range.c1; c <= range.c2; c++) {
        if (!(sheet.rows[r]?.[c]?.v ?? '').trim()) blanks++
      }
    }
    out.push({
      title: '校验完整度',
      body: `选区共 ${rangeSize.rows * rangeSize.cols} 个格子，空 ${blanks} 个，填充率 ${Math.round(
        ((rangeSize.rows * rangeSize.cols - blanks) / (rangeSize.rows * rangeSize.cols)) * 100
      )}%。`,
      terminal: '已完成选区完整性扫描（本地规则校验，未调用大模型）',
    })
    return out
  }

  const draftStep = (ask: string): Step => {
    // 用表格已有内容当素材，生成一段可直接用的文案（本地模板，非大模型）
    const col = range.c1
    const samples: string[] = []
    for (let r = range.r1; r <= Math.min(range.r2, range.r1 + 30); r++) {
      const v = (sheet.rows[r]?.[col]?.v ?? '').trim()
      if (v && r !== range.r1) samples.push(v)
    }
    const first = samples.slice(0, 3)
    return {
      title: '起草内容',
      body:
        `参考当前选区 ${selRef} 的 ${samples.length} 条素材，先给你一版草稿：\n` +
        (first.length ? first.map((s, i) => `${i + 1}. ${s}`).join('\n') : '（该区域暂无可用素材）') +
        `\n\n说明：当前是前端演示模式，文案为本地模板生成。接入大模型后，这里会按你的指令「${ask}」返回真实生成结果。`,
    }
  }

  const planFor = (ask: string): Step[] => {
    if (/统计|求和|汇总|平均|计数|多少/.test(ask)) return [statsStep()]
    if (/检查|校验|核对|核对|重复|表头|空值/.test(ask)) return lintSteps()
    if (/文案|生成|写|润色|起草|改写/.test(ask)) return [draftStep(ask)]
    return [
      {
        title: '接收指令',
        body: `已收到：「${ask}」。当前为前端演示模式——面板 UI 与消息流已就绪，接入大模型或 Agent 后即可返回真实结果。`,
      },
      {
        title: '可用的本地能力',
        body: '现在就能用的有：统计选区（求和 / 平均 / 计数 / 极值）、表头与重复值核对、按表格素材起草文案。你也可以让我把这些能力接到指定区域。',
        terminal: `上下文：${selRef} · 模型档位 ${model}${withCloud ? ' · 云电脑' : ''}`,
      },
    ]
  }

  /* ---------------- 选区内容 → 文本（喂给 Hermes 的真实上下文） ---------------- */
  const buildContext = (): string => {
    const head = `这是文档中一个选区的内容（${selRef}，${rangeSize.rows} 行 × ${rangeSize.cols} 列），制表符分隔，第一行可能是表头：`
    const cap = 40
    const rowsOut: string[] = []
    for (let r = range.r1; r <= Math.min(range.r2, range.r1 + cap - 1); r++) {
      const cells: string[] = []
      for (let c = range.c1; c <= range.c2; c++) cells.push((sheet.rows[r]?.[c]?.v ?? '').trim())
      rowsOut.push(cells.join('\t'))
    }
    if (range.r2 - range.r1 + 1 > cap) rowsOut.push(`…（共 ${rangeSize.rows} 行，此处省略）`)
    return head + '\n' + rowsOut.join('\n')
  }

  /* ---------------- 发送 ---------------- */

  const handleSend = async (preset?: string) => {
    const content = (preset ?? text).trim()
    if (!content || busy) return
    setText('')
    const quote = useCtx ? selRef : undefined
    setMsgs((m) => [...m, { id: ++idRef.current, role: 'user', text: content, quote }])
    setBusy(true)
    const attach = attachments
    setAttachments([])

    // 历史会话（发给 Hermes 保持多轮）
    const history = msgs
      .map((m) =>
        m.role === 'user'
          ? { role: 'user' as const, content: m.text }
          : { role: 'assistant' as const, content: [m.step.title, m.step.body, m.step.terminal].filter(Boolean).join('\n') }
      )
      .slice(-40)

    const ctx = useCtx ? buildContext() : undefined

    let steps: Step[] | null = null
    let err = ''
    try {
      const r = await api.aiChat({
        docId,
        context: ctx,
        messages: [...history, { role: 'user', content }],
        attachments: attach,
      })
      if (r.steps?.length) steps = r.steps
    } catch (e: any) {
      err = e?.message || '请求失败'
    }

    if (steps) {
      for (const step of steps) {
        await sleep(80)
        if (!aliveRef.current) return
        setMsgs((m) => [...m, { id: ++idRef.current, role: 'assistant', step }])
      }
      onNotify('已回复（来自 Hermes）')
    } else {
      // 兜底：未连上 Agent 时用本地规则能力，并把错误一并展示
      const fallback = planFor(content)
      if (err) fallback.unshift({ title: 'Agent 未响应', body: err })
      for (const step of fallback) {
        await sleep(420)
        if (!aliveRef.current) return
        setMsgs((m) => [...m, { id: ++idRef.current, role: 'assistant', step }])
      }
      onNotify('已回复（本地规则；Agent 未连接）')
    }
    setBusy(false)
  }

  /* ---------------- 渲染 ---------------- */

  return (
    <aside className="ai-panel">
      <div className="ai-head">
        <span className="ai-head-title">
          <Ico n="sparkle" size={16} />
          智能助手
        </span>
        <div className="ai-head-actions">
          <button className="ai-head-btn" title="清空对话" onClick={() => setMsgs([])} disabled={!msgs.length}>
            <Ico n="trash" size={15} />
          </button>
          <button className="ai-head-btn" title="关闭" onClick={onClose}>
            <Ico n="close" size={15} />
          </button>
        </div>
      </div>

      <div className="ai-body" ref={bodyRef}>
        {msgs.length === 0 && (
          <div className="ai-welcome">
            <div className="ai-welcome-ico">
              <Ico n="sparkle" size={22} />
            </div>
            <h4>表格智能助手</h4>
            <p>
              可以让我读这份表格的选区做统计与校验，也可以上传图片，让 Agent 结合图片给你解答。
              <br />
              <span className="ai-dim">已接入 Hermes Agent：支持多模态图片与多轮对话。</span>
            </p>
            <div className="ai-sug">
              {SUGGESTIONS.map((s) => (
                <button key={s.text} className="ai-sug-item" onClick={() => void handleSend(s.text)}>
                  <Ico n={s.icon} size={14} />
                  <span>{s.text}</span>
                  <Ico n="chevron-right" size={13} className="ai-dim" />
                </button>
              ))}
            </div>
          </div>
        )}

        {msgs.map((m) =>
          m.role === 'user' ? (
            <div className="ai-msg-user" key={m.id}>
              <div className="ai-bubble">
                {m.quote && <span className="ai-bubble-quote">{m.quote}</span>}
                {m.text}
              </div>
            </div>
          ) : (
            <div className="ai-step" key={m.id}>
              <div className="ai-step-title">
                <Ico n="prompt" size={13} />
                <span>{m.step.title}</span>
              </div>
              {m.step.body && <div className="ai-step-body">{m.step.body}</div>}
              {m.step.terminal && (
                <div className="ai-term">
                  <Ico n="chevron-right" size={12} />
                  <span>{m.step.terminal}</span>
                </div>
              )}
            </div>
          )
        )}

        {busy && (
          <div className="ai-step running">
            <div className="ai-step-title">
              <Ico n="prompt" size={13} />
              <span>执行中</span>
              <span className="ai-dots">
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="ai-input-wrap">
        {useCtx ? (
          <span className="ai-quote-chip" title="本条消息会带上该区域的上下文">
            <Ico n="grid" size={12} />
            {selRef}
            <button onClick={() => setUseCtx(false)} title="不使用选区上下文">
              <Ico n="close" size={11} />
            </button>
          </span>
        ) : (
          <button className="ai-quote-add" onClick={() => setUseCtx(true)}>
            <Ico n="plus" size={12} /> 引用单元格
          </button>
        )}

        {attachments.length > 0 && (
          <div className="ai-attach-row">
            {attachments.map((a, i) => (
              <span className="ai-attach-chip" key={a.name + i} title={a.name}>
                <Ico n="image" size={12} />
                <em>{a.name}</em>
                <button onClick={() => setAttachments((p) => p.filter((_, j) => j !== i))} title="移除">
                  <Ico n="close" size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            pickFiles(e.target.files)
            e.target.value = ''
          }}
        />

        <textarea
          ref={inputRef}
          className="ai-input"
          rows={1}
          placeholder="发消息或输入指令…（Enter 发送，Shift+Enter 换行）"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void handleSend()
            }
          }}
        />

        <div className="ai-tools">
          <button className="ai-tool" title="添加图片（多模态，Hermes 可识别）" onClick={() => fileRef.current?.click()}>
            <Ico n="image" size={15} />
          </button>
          <button
            className={'ai-tool wide' + (withCloud ? ' on' : '')}
            title="云电脑执行（演示开关）"
            onClick={() => {
              setWithCloud((v) => !v)
              onNotify(withCloud ? '已关闭云电脑执行' : '已开启云电脑执行（演示）')
            }}
          >
            <Ico n="expand" size={14} />
            <span>云电脑</span>
          </button>
          <button className="ai-tool" title="更多" onClick={() => onNotify('更多设置：接口已预留')}>
            <Ico n="more" size={15} strokeWidth={2.6} />
          </button>

          <span className="tb-grow" />

          <TbPop text={model} title="思考强度" width={132} up align="right" arrow>
            {(close) => (
              <>
                {(['高', '中', '低'] as const).map((lv) => (
                  <MenuItem
                    key={lv}
                    label={lv}
                    hint={lv === '高' ? '更慢更准' : lv === '中' ? '均衡' : '最快'}
                    active={model === lv}
                    onClick={() => {
                      setModel(lv)
                      close()
                    }}
                  />
                ))}
              </>
            )}
          </TbPop>

          <button
            className="ai-send"
            title="发送"
            disabled={!text.trim() || busy}
            onClick={() => void handleSend()}
          >
            <Ico n="send" size={15} />
          </button>
        </div>
      </div>
    </aside>
  )
}

function round(n: number) {
  return Math.round(n * 100) / 100
}

function colName(c: number): string {
  let n = c
  let s = ''
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}
