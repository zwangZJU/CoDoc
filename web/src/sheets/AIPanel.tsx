/**
 * 右侧智能问答面板（对齐飞书 / Hermes 的 Agent 对话体验）
 *
 * “富事件流式”渲染：后端把 Hermes 结构化事件翻译成 NDJSON 逐行回传，前端据此
 * 实时渲染不同类型的消息气泡，且可折叠：
 *   - 思考过程（reasoning）  可展开/折叠；流式进行中默认展开，一轮结束自动收起
 *   - 工具调用（tool）      工具名 + 进行中 / 完成 / 失败，可展开看预览
 *   - 正文（assistant）     Markdown 逐字流式输出，带光标与停止
 *   - 授权（approval）       「仅一次 / 本次会话 / 始终 / 拒绝」按钮
 *   - todo / clarify / info  预留富事件类型（Hermes 若下发即渲染对应气泡）
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SheetApi } from './useSheet'
import { Ico } from './sheetIcons'
import { MenuItem, TbPop } from './SheetToolbar'
import { indexToCol } from './refs'
import { api } from '../store/api'
import {
  extractOpsBlocks,
  stripOpsBlocks,
  runOps,
  opsBox,
  unionBox,
  takeSnapshot,
  revertSnapshot,
  formatToolResult,
  type Range4,
  type OpResult,
  type Snapshot,
} from './aiOps'

interface Props {
  sheet: SheetApi
  range: { r1: number; c1: number; r2: number; c2: number }
  selRef: string
  docId?: string
  /** 文档只读（分享权限为只读）：此时只允许智能体读，不允许改表 */
  readOnly?: boolean
  onClose: () => void
  onNotify: (msg: string) => void
}

type ToolStatus = 'running' | 'done' | 'error'
type Block =
  | { kind: 'user'; text: string; quote?: string }
  | { kind: 'assistant'; text: string; streaming: boolean }
  | { kind: 'reasoning'; text: string; open: boolean }
  | { kind: 'tool'; name: string; preview: string; status: ToolStatus; open: boolean }
  /** 智能体下发的表格指令执行结果（可整体撤销） */
  | {
      kind: 'sheetops'
      results: OpResult[]
      summary?: string
      snapshot: Snapshot | null
      undone: boolean
      open: boolean
    }
  | { kind: 'todo'; items: { text: string; state?: string }[]; open: boolean }
  | { kind: 'clarify'; question: string; options?: string[] }
  | { kind: 'info'; text: string }
  | { kind: 'approval'; runId: string; command: string; choices: string[]; resolved?: string }

interface Item {
  id: number
  block: Block
}

const SUGGESTIONS = [
  { icon: 'sum' as const, text: '统计当前选区的求和、平均与计数' },
  { icon: 'check' as const, text: '检查选区里的表头缺失与重复值' },
  { icon: 'sparkle' as const, text: '按这份表格的字段，起草一段品牌文案' },
]

/** 智能体连读带写的自动续跑上限（防止它反复 read 停不下来） */
const MAX_FOLLOW = 3

let UID = 1
const nextId = () => UID++

export default function AIPanel({ sheet, range, selRef, docId, readOnly, onClose, onNotify }: Props) {
  const [items, setItems] = useState<Item[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [useCtx, setUseCtx] = useState(true)
  const [model, setModel] = useState<'高' | '中' | '低'>('高')
  const [attachments, setAttachments] = useState<{ name: string; mime: string; data: string }[]>([])
  // 「会话」：同一文档可开启新会话，本地记一个后缀，写进 Hermes 的 session key，让上下文真正复位
  const sessionKeyLS = `codoc.ai.session.${docId || 'x'}`
  const [session, setSession] = useState(() => {
    try {
      return localStorage.getItem(sessionKeyLS) || ''
    } catch {
      return ''
    }
  })

  const fileRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const aliveRef = useRef(true)
  const itemsRef = useRef(items)
  itemsRef.current = items
  const runIdRef = useRef('')
  const abortRef = useRef<AbortController | null>(null)
  /** 用户点了「停止」：这一轮的指令块就不再执行 */
  const cancelledRef = useRef(false)
  /** 本轮已自动续跑的次数（工具结果回灌一轮算一次） */
  const followRef = useRef(0)

  useEffect(() => () => void (aliveRef.current = false), [])
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' })
  }, [items, busy])

  /* ---------------- 消息流操作 ---------------- */
  /**
   * 追加一个气泡，返回它在列表里的 id。
   * 注意：id 必须在 setItems 之外生成。setItems 的 updater 是延迟执行的（且并发渲染下可能执行多次），
   * 在里面 nextId() 会让真正入列的 id 和外面记下的 id 对不上，后续 patch 就全打空了 —— 气泡永远空白。
   */
  const push = (block: Block): number => {
    const id = nextId()
    if (aliveRef.current) setItems((l) => [...l, { id, block }])
    return id
  }
  const patch = (id: number, updater: (b: Block) => Block) => {
    if (!aliveRef.current) return
    setItems((l) => l.map((it) => (it.id === id ? { id, block: updater(it.block) } : it)))
  }
  const toggle = (id: number) =>
    setItems((l) =>
      l.map((it) =>
        it.id === id && 'open' in it.block && typeof it.block.open === 'boolean'
          ? { id, block: { ...it.block, open: !it.block.open } as Block }
          : it
      )
    )

  /* ---------------- 附件（多模态图片） ---------------- */
  const pickFiles = (list: FileList | null) => {
    if (!list) return
    const imgs = Array.from(list).filter((f) => f.type.startsWith('image/'))
    const others = Array.from(list).filter((f) => !f.type.startsWith('image/'))
    if (others.length) onNotify(`暂只支持图片附件（${others[0].name} 已忽略）`)
    for (const f of imgs.slice(0, 4)) {
      const reader = new FileReader()
      reader.onload = () =>
        setAttachments((prev) =>
          prev.length >= 4 ? prev : [...prev, { name: f.name, mime: f.type, data: String(reader.result) }]
        )
      reader.readAsDataURL(f)
    }
  }

  /* ---------------- 表格 → 文本上下文 ---------------- */
  const rows = range.r2 - range.r1 + 1
  const cols = range.c2 - range.c1 + 1

  /** 已用区域：有内容或设过样式的格子都算，用来告诉智能体这张表大概多大 */
  const usedRange = () => {
    let r2 = -1
    let c2 = -1
    let r1 = -1
    let c1 = -1
    for (let r = 0; r < sheet.rowCount; r++) {
      for (let c = 0; c < sheet.colCount; c++) {
        const cell = sheet.rows[r]?.[c]
        if (!cell) continue
        if (!cell.v && !cell.s) continue
        if (r1 < 0) r1 = r
        if (c1 < 0) c1 = c
        if (r > r2) r2 = r
        if (c > c2) c2 = c
      }
    }
    return r1 < 0 ? null : { r1, c1, r2, c2 }
  }

  /** 表格概况：工作表名、尺寸、已用区域、表头首行——让智能体对整张表有概念，而不只盯着选区 */
  const buildOutline = (): string => {
    const others = sheet.sheetNames.filter((n) => n !== sheet.activeSheet)
    const used = usedRange()
    const size = `当前工作表「${sheet.activeSheet}」，共 ${sheet.rowCount} 行 × ${sheet.colCount} 列`
    const usedTxt = used
      ? `已用区域 ${indexToCol(used.c1)}${used.r1 + 1}:${indexToCol(used.c2)}${used.r2 + 1}（${used.r2 - used.r1 + 1} 行 × ${used.c2 - used.c1 + 1} 列）`
      : '已用区域为空（这是一张空表）'
    const lines = [`【表格概况】${size}；${usedTxt}`]
    if (others.length) lines.push(`其他工作表：${others.join('、')}`)
    if (used) {
      const head: string[] = []
      for (let c = used.c1; c <= Math.min(used.c2, used.c1 + 11); c++) {
        head.push((sheet.rows[used.r1]?.[c]?.v ?? '').trim())
      }
      if (head.some(Boolean)) lines.push(`第 ${used.r1 + 1} 行（可能是表头）：${head.join('\t')}`)
    }
    return lines.join('\n')
  }

  const buildContext = (): string => {
    const head = `【当前选区 ${selRef}（${rows} 行 × ${cols} 列）】制表符分隔，第一行可能是表头：\n`
    const cap = 40
    const out: string[] = []
    for (let r = range.r1; r <= Math.min(range.r2, range.r1 + cap - 1); r++) {
      const cells: string[] = []
      for (let c = range.c1; c <= range.c2; c++) cells.push((sheet.rows[r]?.[c]?.v ?? '').trim())
      out.push(cells.join('\t'))
    }
    if (rows > cap) out.push(`…（共 ${rows} 行，其余省略）`)
    return `${buildOutline()}\n${head}${out.join('\n')}`
  }

  /* ---------------- 发送（流式） ---------------- */
  /** 面板里已有的问答 → 对话历史（工具结果也作为 user 消息进去，模型才看得到） */
  const buildHistory = (): { role: 'user' | 'assistant'; content: string }[] => {
    const out: { role: 'user' | 'assistant'; content: string }[] = []
    for (const it of itemsRef.current) {
      if (out.length >= 40) break
      if (it.block.kind === 'user') out.push({ role: 'user', content: it.block.text })
      else if (it.block.kind === 'assistant') out.push({ role: 'assistant', content: it.block.text })
    }
    return out
  }

  /**
   * 跑一轮对话。auto=true 表示这是「工具结果回灌」的续跑：不再带附件，
   * 智能体拿到上一轮 read 的真实数据后继续，直到给出最终答案或达到续跑上限。
   */
  const runStream = async (
    content: string,
    opts?: {
      auto?: boolean
      ctx?: string
      history?: { role: 'user' | 'assistant'; content: string }[]
      attach?: { name: string; mime: string; data: string }[]
    }
  ) => {
    const attach = opts?.attach || []
    const history = opts?.history || buildHistory()

    setBusy(true)
    cancelledRef.current = false
    const S = {
      assistantId: null as number | null,
      reasoningId: null as number | null,
      tools: {} as Record<string, number>,
      text: '',
    }

    const ensureAssistant = (): number => {
      if (S.assistantId == null) {
        S.assistantId = push({ kind: 'assistant', text: '', streaming: true })
      }
      return S.assistantId
    }
    const addError = (msg: string) => {
      if (!aliveRef.current) return
      const newId = nextId()
      setItems((l) => {
        const last = l[l.length - 1]
        if (last && last.block.kind === 'assistant' && last.block.streaming) {
          const base = last.block.text
          return l.map((it) =>
            it.id === last.id
              ? { id: it.id, block: { kind: 'assistant', text: base + '\n\n> ' + msg, streaming: false } }
              : it
          )
        }
        return l.concat([{ id: newId, block: { kind: 'assistant', text: '> ' + msg, streaming: false } }])
      })
    }

    abortRef.current = api.aiChatStream(
      {
        docId,
        context: opts?.ctx,
        session,
        messages: [...history, { role: 'user', content }],
        attachments: attach,
      },
      {
        onEvent: (e) => {
          switch (e.type) {
            case 'turn.start':
              runIdRef.current = e.runId || ''
              break
            case 'reasoning': {
              const rt = (e.text || '').trim()
              if (!rt) break
              if (S.reasoningId != null) {
                patch(S.reasoningId, (b) =>
                  b.kind === 'reasoning' ? { ...b, text: b.text + '\n' + rt, open: true } : b
                )
                break
              }
              // 独立于正文的思考过程：单独一个可折叠气泡（正文由 assistant.delta 流式展示）
              S.reasoningId = push({ kind: 'reasoning', text: rt, open: true })
              break
            }
            case 'tool.start': {
              S.tools[e.id] = push({
                kind: 'tool',
                name: e.name,
                preview: e.preview || '',
                status: 'running',
                open: !!e.preview,
              })
              break
            }
            case 'tool.done': {
              const ref = S.tools[e.id]
              if (ref != null) patch(ref, (b) => (b.kind === 'tool' ? { ...b, status: e.ok ? 'done' : 'error' } : b))
              break
            }
            case 'assistant.delta':
              S.text += e.text || ''
              patch(ensureAssistant(), (b) => (b.kind === 'assistant' ? { ...b, text: b.text + e.text } : b))
              break
            case 'assistant.done':
              ensureAssistant()
              if (e.text) S.text += e.text
              patch(S.assistantId!, (b) =>
                b.kind === 'assistant' ? { ...b, text: e.text ? b.text + e.text : b.text, streaming: false } : b
              )
              break
            case 'todo':
              push({ kind: 'todo', items: e.items, open: true })
              break
            case 'clarify':
              push({ kind: 'clarify', question: e.question, options: e.options })
              break
            case 'info':
              push({ kind: 'info', text: e.text })
              break
            case 'approval':
              push({
                kind: 'approval',
                runId: e.id,
                command: e.command,
                choices: e.choices || ['once', 'session', 'always', 'deny'],
              })
              break
            case 'approval.resolved':
              setItems((l) =>
                l.map((it) =>
                  it.block.kind === 'approval' && !it.block.resolved
                    ? { id: it.id, block: { ...it.block, resolved: e.choice || 'once' } }
                    : it
                )
              )
              break
            case 'error':
              addError(e.message)
              break
            case 'done':
              break
          }
        },
        onClose: () => {
          if (S.reasoningId != null) patch(S.reasoningId, (b) => (b.kind === 'reasoning' ? { ...b, open: false } : b))
          // 一轮说完：把正文里的表格指令落到表上（含 read 结果回灌后续跑）
          const followed = finishTurn(S.text)
          if (followed) return // 续跑接管 busy 状态，这里不收尾
          setBusy(false)
          if (aliveRef.current) onNotify('已回复（流式）')
        },
        onError: (msg) => {
          addError(msg)
          setBusy(false)
        },
      }
    )
  }

  /** 真实用户输入 */
  const handleSend = async (preset?: string) => {
    const content = (preset ?? text).trim()
    if (!content || busy) return
    setText('')
    push({ kind: 'user', text: content, quote: useCtx ? selRef : undefined })
    const attach = attachments
    setAttachments([])
    followRef.current = 0
    await runStream(content, { ctx: useCtx ? buildContext() : undefined, attach })
  }

  /**
   * 一轮结束后的收尾：执行指令块 → 回显结果（可撤销）→ 有 read 就把数据回灌给智能体续跑。
   * 返回 true 表示已经发起续跑（调用方不要再收尾 busy）。
   */
  const finishTurn = (fullText: string): boolean => {
    if (cancelledRef.current) return false
    const blocks = extractOpsBlocks(fullText)
    if (!blocks.length) return false

    // 只读文档：读可以，改不行 —— 权限是硬边界，不能因为智能体想改就改
    if (readOnly) {
      const reads = blocks.flatMap((b) => b.ops).filter((o) => String(o.op || '').toLowerCase() === 'read')
      const triedWrite = blocks.flatMap((b) => b.ops).length > reads.length
      if (triedWrite) {
        push({ kind: 'info', text: '当前文档是只读的，智能体的表格改动没有执行' })
        onNotify('文档只读，表格改动未执行')
      }
      if (!reads.length) return false
      const res = runOps(sheet, reads, sheet.activeSheet, '智能助手', null)
      push({ kind: 'sheetops', results: res.ops, summary: undefined, snapshot: null, undone: false, open: true })
      return false
    }

    // 先把所有指令块的影响范围并起来留一份档，再逐个执行 —— 撤销时才能回到最初状态
    let box: Range4 | null = null
    for (const b of blocks) box = unionBox(box, opsBox(sheet, b.ops))
    const snapshot: Snapshot | null = box ? takeSnapshot(sheet, box) : null

    const results: OpResult[] = []
    let changed = 0
    let hasRead = false
    let summary = ''
    for (const b of blocks) {
      const res = runOps(sheet, b.ops, sheet.activeSheet, '智能助手', snapshot)
      results.push(...res.ops)
      changed += res.changedCells
      if (res.ops.some((o) => o.ok && o.op === 'read')) hasRead = true
      if (b.summary) summary = b.summary
    }
    push({ kind: 'sheetops', results, summary: summary || undefined, snapshot, undone: false, open: true })
    const okCount = results.filter((r) => r.ok).length
    onNotify(changed ? `已改动表格（${okCount} 项操作，${changed} 个单元格）` : `已执行 ${okCount} 项表格操作`)

    // 读取回灌：让智能体拿到真实数据后再接着干（最多续跑 MAX_FOLLOW 轮）
    if (hasRead && followRef.current < MAX_FOLLOW && !cancelledRef.current) {
      followRef.current += 1
      const payload = formatToolResult({
        ops: results,
        applied: okCount,
        changedCells: changed,
        summary,
        snapshot,
        errors: [],
      })
      // 历史自己拼（此刻 items 还没把这条结果渲染进去，等 ref 更新再来不及）
      const hist = buildHistory()
      hist.push({ role: 'user', content: payload })
      push({ kind: 'user', text: payload, quote: '工具结果' })
      setTimeout(() => {
        if (!aliveRef.current || cancelledRef.current) return
        void runStream(payload, { auto: true, history: hist })
      }, 60)
      return true
    }
    return false
  }

  /** 撤销一次智能体改动 */
  const revertOps = (id: number) => {
    const target = itemsRef.current.find((it) => it.id === id)
    if (!target || target.block.kind !== 'sheetops' || target.block.undone) return
    const snap = target.block.snapshot
    if (!snap) return
    revertSnapshot(sheet, snap)
    patch(id, (b) => (b.kind === 'sheetops' ? { ...b, undone: true } : b))
    onNotify('已撤销智能体的表格改动')
  }

  const stop = () => {
    cancelledRef.current = true // 中断后本轮的表格指令不再执行
    abortRef.current?.abort()
    abortRef.current = null
    if (runIdRef.current) void api.aiStop(runIdRef.current).catch(() => undefined)
    setBusy(false)
  }

  const approve = (id: number, runId: string, choice: string) => {
    void api
      .aiApprove(runId, choice)
      .then(() => patch(id, (b) => (b.kind === 'approval' ? { ...b, resolved: choice } : b)))
      .catch((err) => onNotify(err?.message || '授权失败'))
  }

  /** 开新会话：清空本地面板 + 换一个新 session 后缀，让 Hermes 上下文彻底复位 */
  const newSession = () => {
    cancelledRef.current = true
    abortRef.current?.abort()
    abortRef.current = null
    runIdRef.current = ''
    followRef.current = 0
    setBusy(false)
    setItems([])
    const s = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    setSession(s)
    try {
      localStorage.setItem(sessionKeyLS, s)
    } catch {
      /* ignore */
    }
    onNotify('已开启新会话')
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
          {busy && (
            <button className="ai-head-btn" title="停止生成" onClick={stop}>
              <Ico n="stop2" size={15} />
            </button>
          )}
          <button className="ai-head-btn" title="开启新会话（重置上下文）" onClick={newSession}>
            <Ico n="refresh" size={15} />
          </button>
          <button
            className="ai-head-btn"
            title="清空对话"
            disabled={!items.length}
            onClick={() => {
              cancelledRef.current = true
              abortRef.current?.abort()
              followRef.current = 0
              setItems([])
            }}
          >
            <Ico n="trash" size={15} />
          </button>
          <button className="ai-head-btn" title="关闭" onClick={onClose}>
            <Ico n="close" size={15} />
          </button>
        </div>
      </div>

      <div className="ai-body" ref={bodyRef}>
        {items.length === 0 && (
          <div className="ai-welcome">
            <div className="ai-welcome-ico">
              <Ico n="sparkle" size={22} />
            </div>
            <h4>表格智能助手</h4>
            <p>
              我能读整张表、改内容和边框，也能发图做多模态分析。
              <br />
              <span className="ai-dim">
                已接入 Hermes Agent：思考 / 工具 / 授权 / 流式输出；改动可直接撤销。
              </span>
            </p>
            <div className="ai-sug">
              {SUGGESTIONS.map((s) => (
                <button key={s.text} className="ai-sug-item" onClick={() => void handleSend(s.text)} disabled={busy}>
                  <Ico n={s.icon} size={14} />
                  <span>{s.text}</span>
                  <Ico n="chevron-right" size={13} className="ai-dim" />
                </button>
              ))}
            </div>
          </div>
        )}

        {items.map((it) => (
          <BlockView
            key={it.id}
            block={it.block}
            onToggle={() => toggle(it.id)}
            onRevert={() => revertOps(it.id)}
            onApprove={(c) => approve(it.id, (it.block as { runId?: string }).runId || '', c)}
          />
        ))}
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
          <button className="ai-tool" title="添加图片（多模态）" onClick={() => fileRef.current?.click()}>
            <Ico n="image" size={15} />
          </button>
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
          <span className="tb-grow" />
          <button className="ai-send" title="发送" disabled={!text.trim() || busy} onClick={() => void handleSend()}>
            <Ico n="send" size={15} />
          </button>
        </div>
      </div>
    </aside>
  )
}

/* ---------------- 单个气泡 ---------------- */
function BlockView({
  block,
  onToggle,
  onRevert,
  onApprove,
}: {
  block: Block
  onToggle: () => void
  onRevert?: () => void
  onApprove: (c: string) => void
}) {
  if (block.kind === 'user') {
    return (
      <div className="ai-msg-user">
        <div className="ai-bubble">
          {block.quote && <span className="ai-bubble-quote">{block.quote}</span>}
          {block.text}
        </div>
      </div>
    )
  }
  if (block.kind === 'reasoning') {
    return (
      <div className="ai-block">
        <button className="ai-fold" onClick={onToggle}>
          <Ico n="chevron-right" size={12} className={block.open ? 'rot' : ''} />
          <Ico n="brain" size={13} className="ai-ico think" />
          <span className="ai-fold-label">思考过程</span>
          <span className="tb-grow" />
          <span className="ai-fold-hint">{block.text.trim().length} 字</span>
        </button>
        {block.open && (
          <div className="ai-reason">
            <Md text={block.text} mono />
          </div>
        )}
      </div>
    )
  }
  if (block.kind === 'tool') {
    return (
      <div className="ai-block">
        <button className="ai-fold" onClick={onToggle}>
          <Ico n="chevron-right" size={12} className={block.open ? 'rot' : ''} />
          <span className={'ai-dot ' + block.status} />
          <Ico n="wrench" size={13} className="ai-ico" />
          <span className="ai-fold-label">{block.name}</span>
          <span className="tb-grow" />
          {block.status === 'running' ? (
            <span className="ai-dots">
              <i />
              <i />
              <i />
            </span>
          ) : (
            <span className={block.status === 'done' ? 'ai-st ok' : 'ai-st err'}>
              {block.status === 'done' ? '完成' : '失败'}
            </span>
          )}
        </button>
        {block.open && block.preview && <div className="ai-term">{block.preview}</div>}
      </div>
    )
  }
  if (block.kind === 'sheetops') {
    const okCount = block.results.filter((r) => r.ok).length
    const reads = block.results.filter((r) => r.read != null)
    return (
      <div className="ai-block ai-ops">
        <button className="ai-fold" onClick={onToggle}>
          <Ico n="chevron-right" size={12} className={block.open ? 'rot' : ''} />
          <Ico n="grid" size={13} className={'ai-ico' + (block.undone ? '' : ' ok')} />
          <span className="ai-fold-label">
            {block.undone ? '表格改动已撤销' : `已改动表格 · ${okCount} 项`}
          </span>
          <span className="tb-grow" />
          {!block.undone && block.snapshot && (
            <button
              className="ai-ops-undo"
              title="撤销智能体这一轮的全部改动"
              onClick={(e) => {
                e.stopPropagation()
                onRevert?.()
              }}
            >
              撤销
            </button>
          )}
        </button>
        {block.open && (
          <div className="ai-ops-body">
            {block.summary && <div className="ai-ops-sum">{block.summary}</div>}
            <ul className="ai-ops-list">
              {block.results.map((r, i) => (
                <li key={i} className={r.ok ? '' : 'err'}>
                  <span className="ai-ops-op">{OP_LABEL[r.op] || r.op}</span>
                  <span className="ai-ops-range">{r.range}</span>
                  <span className="ai-ops-detail">{r.detail}</span>
                </li>
              ))}
            </ul>
            {reads.map((r, i) => (
              <pre className="ai-term ai-ops-read" key={i}>
                {r.read}
              </pre>
            ))}
          </div>
        )}
      </div>
    )
  }
  if (block.kind === 'todo') {
    return (
      <div className="ai-block">
        <button className="ai-fold" onClick={onToggle}>
          <Ico n="chevron-right" size={12} className={block.open ? 'rot' : ''} />
          <Ico n="list" size={13} className="ai-ico" />
          <span className="ai-fold-label">任务清单</span>
          <span className="tb-grow" />
        </button>
        {block.open && (
          <ul className="ai-todo">
            {block.items.map((t) => (
              <li key={t.text} className={t.state === 'done' ? 'done' : ''}>
                <span className={'ai-dot ' + (t.state === 'done' ? 'done' : 'queue')} />
                <span>{t.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }
  if (block.kind === 'clarify') {
    return (
      <div className="ai-block ai-clarify">
        <div className="ai-clarify-q">{block.question}</div>
        {block.options && (
          <div className="ai-clarify-opts">
            {block.options.map((o) => (
              <span key={o}>{o}</span>
            ))}
          </div>
        )}
      </div>
    )
  }
  if (block.kind === 'info') {
    return (
      <div className="ai-block ai-info">
        <Ico n="check" size={13} className="ai-ico ok" />
        <span>{block.text}</span>
      </div>
    )
  }
  if (block.kind === 'approval') {
    return (
      <div className="ai-block ai-approval">
        <div className="ai-approval-head">
          <Ico n="shield" size={13} className="ai-ico" />
          <span>需要授权</span>
        </div>
        <pre className="ai-term ai-approval-cmd">{block.command}</pre>
        {block.resolved ? (
          <div className="ai-approval-resolved">
            <Ico n="check" size={12} />
            已{block.resolved === 'deny' ? '拒绝' : '批准'}
          </div>
        ) : (
          <div className="ai-approval-btns">
            {block.choices.map((c) => (
              <button key={c} className={'ai-approve-btn' + (c === 'deny' ? ' danger' : '')} onClick={() => onApprove(c)}>
                {choiceLabel(c)}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }
  // assistant
  return (
    <div className={'ai-assistant' + (block.streaming ? ' streaming' : '')}>
      {block.text ? <Md text={visibleText(block.text)} /> : null}
      {block.streaming && <span className="ai-caret" />}
    </div>
  )
}

/** 指令名 → 中文，结果列表里给用户看 */
const OP_LABEL: Record<string, string> = {
  read: '读取',
  write: '写入',
  style: '样式',
  border: '边框',
  merge: '合并',
  unmerge: '取消合并',
  clear: '清除',
  sort: '排序',
  numfmt: '数字格式',
  link: '链接',
  comment: '批注',
  freeze: '冻结',
  colw: '列宽',
  rowh: '行高',
}

/**
 * 正文展示：抹掉指令块（执行结果另有气泡）。
 * 流式途中围栏可能还没闭合，这时从最后一个 ``` 处截断，免得露出半截 JSON。
 */
function visibleText(t: string): string {
  const s = stripOpsBlocks(t)
  const last = s.lastIndexOf('```')
  if (last >= 0 && s.indexOf('```', last + 3) === -1) {
    const tail = s.slice(last)
    if (/^```[A-Za-z0-9_-]*\s*\n?\s*\{/.test(tail) || tail.includes('"ops"')) {
      return s.slice(0, last).replace(/\s+$/, '')
    }
  }
  return s
}

function choiceLabel(c: string): string {
  switch (c) {
    case 'once':
      return '仅一次'
    case 'session':
      return '本次会话'
    case 'always':
      return '始终'
    case 'deny':
      return '拒绝'
    default:
      return c
  }
}

/* ---------------- 轻量 Markdown 渲染（对流式中途内容宽容） ---------------- */
function Md({ text, mono }: { text: string; mono?: boolean }) {
  const nodes = renderMarkdown(text)
  return <div className={'ai-md' + (mono ? ' mono' : '')}>{nodes}</div>
}

function renderMarkdown(src: string): ReactNode[] {
  const lines = src.split('\n')
  const out: ReactNode[] = []
  let key = 0
  let i = 0
  while (i < lines.length) {
    const raw = lines[i]
    const line = raw.trimEnd()

    // 代码块（容忍未闭合）
    if (line.startsWith('```')) {
      const buf: string[] = []
      i++
      const isClosing = (l: string) => l.trim().startsWith('```')
      while (i < lines.length && !isClosing(lines[i])) {
        buf.push(lines[i])
        i++
      }
      if (i < lines.length) i++ // 跳过结束 ```
      out.push(
        <pre className="ai-code" key={key++}>
          {buf.join('\n')}
        </pre>
      )
      continue
    }

    const t = line.trim()
    if (!t) {
      i++
      continue
    }
    if (/^(#{1,6})\s+/.test(t)) {
      const lv = Math.min(6, t.match(/^(#+)/)![1].length)
      const body = t.replace(/^#{1,6}\s+/, '')
      out.push(
        <h3 key={key++} className={'h' + lv}>
          <Inline text={body} />
        </h3>
      )
      i++
      continue
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(t)) {
      out.push(<hr key={key++} />)
      i++
      continue
    }
    if (/^[-*+]\s+/.test(t) || /^\d+[.)]/.test(t)) {
      const items: string[] = []
      while (
        i < lines.length &&
        (/^\s*[-*+]\s+/ .test(lines[i].trimStart()) || /^\s*\d+[.)]/.test(lines[i].trimStart()))
      ) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, ''))
        i++
      }
      out.push(
        <ul key={key++}>
          {items.map((it, idx) => (
            <li key={idx}>
              <Inline text={it} />
            </li>
          ))}
        </ul>
      )
      continue
    }
    if (/^>\s?/.test(t)) {
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      out.push(
        <blockquote key={key++}>
          <Inline text={buf.join('\n')} />
        </blockquote>
      )
      continue
    }
    out.push(
      <p key={key++}>
        <Inline text={line} />
      </p>
    )
    i++
  }
  return out
}

function Inline({ text }: { text: string }) {
  const parts: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]\n]+\]\([^)]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(<span key={k++}>{text.slice(last, m.index)}</span>)
    const tok = m[0]
    if (tok.startsWith('**')) parts.push(<strong key={k++}>{tok.slice(2, -2)}</strong>)
    else if (tok.startsWith('`')) parts.push(<code key={k++}>{tok.slice(1, -1)}</code>)
    else if (tok.startsWith('*') && tok.endsWith('*')) parts.push(<em key={k++}>{tok.slice(1, -1)}</em>)
    else if (tok.startsWith('[')) {
      const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (mm)
        parts.push(
          <a key={k++} href={mm[2]} target="_blank" rel="noreferrer">
            {mm[1]}
          </a>
        )
    } else parts.push(<span key={k++}>{tok}</span>)
    last = m.index + tok.length
  }
  if (last < text.length) parts.push(<span key={k++}>{text.slice(last)}</span>)
  return <>{parts}</>
}