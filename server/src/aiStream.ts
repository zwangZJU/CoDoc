/**
 * 智能助手流式中继（server 侧）
 *
 * 职责：把客户端（AIPanel）来的单次对话请求，转为对 Hermes API Server 的“富事件”调用，
 * 再把 Hermes 回传的结构化事件翻译成前端可消费的 NDJSON 流（每行一个 JSON）。前端据此
 * 渲染 流式正文、可折叠的「思考过程 / 工具调用 / 授权确认 / todo / clarify / 自学习」等气泡。
 *
 * 两条通道：
 * 1) 无图片附件 → Hermes /v1/runs + /v1/runs/{id}/events（SSE）：
 *    拿到 reasoning.available / tool.started / message.delta / approval.request 等结构化事件，
 *    这是本面板“富气泡 + 流式”的主要通道。
 * 2) 有图片附件 → Hermes /v1/chat/completions（stream）：
 *    runs 接口不接收多模态图片，退化为 OpenAI 兼容的流式正文（仅 assistant.delta，无富事件）。
 *
 * NDJSON 事件（每行 { type, ... }）：见上方文档字符串，前端 spp 依 type 渲染不同气泡。
 */

import { SHEET_AGENT_SKILL } from './aiSkill'

export type NdWrite = (row: Record<string, unknown>) => void

export interface AiRequestBody {
  docId?: string
  context?: string
  /** 「新建会话」时前端会带一个新后缀，用于重置该文档的 Hermes 会话缓存 */
  session?: string
  messages?: { role: 'user' | 'assistant'; content: string }[]
  attachments?: { name: string; mime?: string; data?: string }[]
}

export interface AiStreamCfg {
  base: string
  key: string
  sessionKeyPrefix: string
}

const hasImage = (attachments: { data?: string }[] = []) =>
  attachments.some((a) => (a.data || '').startsWith('data:image/'))

/** 不带图片时用的鉴权/会话头 */
function jsonHeaders(cfg: AiStreamCfg, docId?: string, session?: string): Record<string, string> {
  const h: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${cfg.key}`,
  }
  if (docId && cfg.sessionKeyPrefix) {
    h['x-hermes-session-key'] = session ? `${cfg.sessionKeyPrefix}:${docId}:${session}` : `${cfg.sessionKeyPrefix}:${docId}`
  }
  return h
}

function authHeaders(cfg: AiStreamCfg): Record<string, string> {
  return { authorization: `Bearer ${cfg.key}` }
}

/** 把 body 拼成 OpenAI 兼容 messages；顺手判断是否有可见内容与是否含图 */
function buildOpenAI(body: AiRequestBody) {
  const messages = body.messages || []
  // 表格操作技能每轮都带：远端智能体只有靠它才知道自己能读写单元格（system 位不进历史统计）
  const openaiMsgs: any[] = [{ role: 'system', content: SHEET_AGENT_SKILL }]
  let visible = false
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    const isLast = i === messages.length - 1
    if (m.role === 'user' && isLast) {
      const parts: any[] = []
      const textParts: string[] = []
      if (body.context) textParts.push(body.context)
      if (m.content) textParts.push(m.content)
      const textBlob = textParts.join('\n\n').trim()
      if (textBlob) parts.push({ type: 'text', text: textBlob })
      for (const a of body.attachments || []) {
        if ((a.data || '').startsWith('data:image/')) {
          parts.push({ type: 'image_url', image_url: { url: a.data } })
        }
      }
      if (parts.length) {
        openaiMsgs.push({ role: 'user', content: parts })
        visible = true
      }
    } else {
      if (m.content) {
        openaiMsgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })
        visible = true
      }
    }
  }
  return { messages: openaiMsgs, visible }
}

/** 主入口：按是否含图选择通道，把 Hermes 事件翻译成 NDJSON 行喂给 send(row) */
export async function runAiStream(
  cfg: AiStreamCfg,
  body: AiRequestBody,
  send: NdWrite
): Promise<void> {
  if (!cfg.key) {
    send({ type: 'error', message: '尚未配置 Hermes 接入。请先在 server/.env 里设置 HERMES_API_KEY。' })
    return
  }
  const { messages, visible } = buildOpenAI(body)
  if (!visible) {
    send({ type: 'error', message: '消息内容为空' })
    return
  }
  if (hasImage(body.attachments)) {
    await streamChatCompletions(cfg, messages, body, send)
  } else {
    await streamRuns(cfg, body, send)
  }
}

/* ---------------- 通道 1：/v1/runs 富事件 SSE ---------------- */
async function streamRuns(cfg: AiStreamCfg, body: AiRequestBody, send: NdWrite): Promise<void> {
  const messages = body.messages || []
    // 前 N-1 条作为对话历史；最后一条 user 作为 user_message（加上选区上下文）
    const history: { role: string; content: string }[] = []
    for (const m of messages.slice(0, -1)) {
      if (m.content) history.push({ role: m.role, content: m.content })
    }
  const last = messages[messages.length - 1]
  // runs 通道只有 user_message 一个入口，把技能说明前置进去（每轮都带，智能体才会一直记得自己能改表）
  const userMessage = [SHEET_AGENT_SKILL, body.context, last?.content].filter(Boolean).join('\n\n').trim()
  if (!userMessage) {
    send({ type: 'error', message: '消息内容为空' })
    return
  }

  let runId = ''
  try {
    const r = await fetch(`${cfg.base}/runs`, {
      method: 'POST',
      headers: jsonHeaders(cfg, body.docId, body.session),
      body: JSON.stringify({
        model: 'hermes-agent',
        input: userMessage,
        conversation_history: history,
      }),
    })
    if (!r.ok) {
      const txt = await r.text().catch(() => '')
      send({ type: 'error', message: `Hermes 服务出错（${r.status}）：${txt.slice(0, 200)}` })
      return
    }
    const j: any = await r.json()
    runId = j.run_id || ''
    if (!runId) {
      send({ type: 'error', message: 'Hermes 未返回 runId' })
      return
    }
    send({ type: 'turn.start', runId: runId })
  } catch (e: any) {
    send({ type: 'error', message: `无法连接 Hermes（${cfg.base}）：${e?.message || e}` })
    return
  }

  // 订阅 /v1/runs/{id}/events（SSE：data: {event:..,type:...} , 结束用空行，None 哨兵关闭）
  let resp: Response
  try {
    resp = await fetch(`${cfg.base}/runs/${runId}/events`, { headers: authHeaders(cfg) })
  } catch (e: any) {
    send({ type: 'error', message: `订阅 Hermes 事件失败：${e?.message || e}` })
    return
  }
  if (!resp.ok || !resp.body) {
    send({ type: 'error', message: `Hermes 事件流不可用（${resp.status}）` })
    return
  }

  // 每个工具名 -> 自增 id（工具 start -> done 配对）
  const toolIdx = new Map<string, number>()
  const toolMeta = new Map<string, string>() // id -> name

  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  let buf = ''

  /**
   * 正文流去重（关键修复）：
   * Hermes 对无独立思考的模型（如当前 DeepSeek-v4-flash）会把「完整最终正文」
   * 既通过 message.delta 逐字流式下发，又原样塞进 reasoning.available 的 text。
   * 若后端明知地把 reasoning.available 转发成「思考过程」气泡，就会把正文整个
   * 折叠进那一个气泡里（用户看到的三大现象正是这个根因）。
   * 因此这里攒一段「待定思考」，只在能够证明它与已流式正文确实不同（真实独立
   * 思考）时才下发；一旦确认只是正文重复，直接丢弃。
   */
  let streamBody = ''
  let pendingReasoning = ''

  const normWs = (s: string) => s.replace(/\s+/g, ' ').trim()
  /**
   * 判定并下发积压的思考。complete=true 时（run 结束）强制判定；
   * 过程中只在「正文长度已积累到不小于思考长度、足以确认与思考不同」时才下发，
   * 避免正文还没流完就把部分正文误当成思考发出去。
   */
  const flushReasoning = (complete = false) => {
    const t = pendingReasoning.trim()
    if (!t) return
    const tn = normWs(t)
    if (tn) {
      const b = normWs(streamBody)
      // 正文还未积累到可比长度的话，静默挂起（等 complete 兜底），避免误发正文
      const cmp = b.length >= tn.length && b !== ''
      if (cmp || complete) {
        const isDup = !!b && (b === tn || b.includes(tn) || tn.includes(b))
        if (!isDup) send({ type: 'reasoning', text: pendingReasoning })
        pendingReasoning = ''
      }
    } else {
      pendingReasoning = ''
    }
  }

  const emitHermes = (ev: any) => {
    if (!ev || typeof ev !== 'object') return
    const name = String(ev.event || '')
    const d = ev as Record<string, any>
    switch (name) {
      case 'reasoning.available': {
        const t = String(d.text || '').trim()
        if (!t) break
        // 同一段思考：Hermes 可能分多次推送整段，这里按换行累加，取最终整体做判定
        pendingReasoning = pendingReasoning ? pendingReasoning + '\n' + t : t
        flushReasoning(false)
        break
      }
      case 'message.delta':
        if (d.delta) {
          streamBody += d.delta
          send({ type: 'assistant.delta', text: d.delta })
          flushReasoning(false)
        }
        break
      case 'tool.started': {
        const nm = String(d.tool || 'tool')
        const n = (toolIdx.get(nm) || 0) + 1
        toolIdx.set(nm, n)
        const id = `${nm}#${n}`
        toolMeta.set(id, nm)
        send({ type: 'tool.start', id, name: nm, preview: d.preview || '' })
        break
      }
      case 'tool.completed': {
        const nm = String(d.tool || 'tool')
        const n = toolIdx.get(nm) || 1
        toolIdx.set(nm, n)
        send({ type: 'tool.done', id: `${nm}#${n}`, name: nm, ok: !d.error, duration: d.duration })
        break
      }
      case 'approval.responded':
        send({ type: 'approval.resolved', id: d.run_id || runId, choice: d.choice || '' })
        break
      case 'run.completed': {
        const out = String(d.output || '').trim()
        // 关键：工具型回答（如调用 skill）可能不产生 message.delta，正文只落在 run.completed.output。
        // 若此前没有流式送达过这段文本，就在这里补发成正文，否则前端只会看到工具气泡而没有正文。
        const outN = normWs(out)
        const bodyN = normWs(streamBody)
        // 仅当此前确实已流式过正文（bodyN 非空）时才做包含/重复判定；
        // 若 bodyN 为空（工具型回答，正文只在 output），则一定需要补发。
        const alreadySent =
          bodyN !== '' && (bodyN === outN || bodyN.includes(outN) || outN.includes(bodyN))
        if (out && !alreadySent) {
          streamBody += streamBody ? '\n\n' + out : out
          send({ type: 'assistant.delta', text: out })
        }
        // 兜底：正文已结束，此刻强制判定积压思考（重复则丢弃，独立则补发）
        flushReasoning(true)
        // 结束信号（正文已通过 delta 送达）
        send({ type: 'assistant.done', text: '' })
        break
      }
      case 'run.failed':
        flushReasoning(true)
        send({ type: 'error', message: d.error || '智能体执行失败' })
        break
      case 'run.cancelled':
        flushReasoning(true)
        send({ type: 'error', message: '执行已被中断' })
        break
      case 'approval.request':
              send({
                type: 'approval',
                id: d.run_id || runId,
                command: d.command || '',
                choices: d.choices?.length ? d.choices : ['once', 'session', 'always', 'deny'],
              })
              break
            default:
              // reasoning 有专门 name；其余（含 todo/clarify/info）此刻不触发，预留下发
        break
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        for (const line of block.split('\n')) {
          const t = line.trim()
          if (!t.startsWith('data:') || t === 'data:[') continue
          const payload = t.slice(5).trim()
          if (!payload || payload === ':') continue
          try {
            emitHermes(JSON.parse(payload))
          } catch {
            /* ignore partial */
          }
        }
      }
    }
  } catch (e: any) {
    send({ type: 'error', message: `读取 Hermes 事件流中断：${e?.message || e}` })
  }
  // 兜底：流意外关闭而事件未正常终止时，别让积压的思考悬空
  pendingReasoning && flushReasoning(true)
}

/* ---------------- 通道 2：/v1/chat/completions 流（图片附件退化路径）---------------- */
async function streamChatCompletions(cfg: AiStreamCfg, openaiMsgs: any[], body: AiRequestBody, send: NdWrite): Promise<void> {
  send({ type: 'turn.start', runId: '' })
  let resp: Response
  try {
    resp = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: jsonHeaders(cfg, body.docId, body.session),
      body: JSON.stringify({ model: 'hermes-agent', messages: openaiMsgs, stream: true }),
    })
  } catch (e: any) {
    send({ type: 'error', message: `无法连接 Hermes（${cfg.base}）：${e?.message || e}` })
    return
  }
  if (!resp.ok || !resp.body) {
    const txt = await resp.text().catch(() => '')
    send({ type: 'error', message: `Hermes 服务出错（${resp.status}）：${txt.slice(0, 200)}` })
    return
  }
  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
                  const j = JSON.parse(payload)
                  const c = j?.choices?.[0]?.delta?.content
                  if (typeof c === 'string' && c) send({ type: 'assistant.delta', text: c })
                } catch {
                  /* ignore */
                }
              }
            }
            send({ type: 'assistant.done', text: '' }) // 结束信号（正文已逐字发出）
          } catch (e: any) {
            send({ type: 'error', message: `读取流中断：${e?.message || e}` })
          }
}

/** 处理一次授权决策：POST /v1/runs/{id}/approval */
export async function resolveApproval(
  cfg: AiStreamCfg,
  runId: string,
  choice: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`${cfg.base}/runs/${runId}/approval`, {
      method: 'POST',
      headers: jsonHeaders(cfg),
      body: JSON.stringify({ choice }),
    })
    if (!r.ok) {
      const j: any = await r.json().catch(() => null)
      return { ok: false, error: j?.error?.message || `授权失败（${r.status}）` }
    }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: `无法连接 Hermes：${e?.message || e}` }
  }
}

/** 中断一次智能体：POST /v1/runs/{id}/stop */
export async function stopRun(cfg: AiStreamCfg, runId: string): Promise<{ ok: boolean; error?: string }> {
  if (!runId) return { ok: false, error: '缺少 runId' }
  try {
    const r = await fetch(`${cfg.base}/runs/${runId}/stop`, {
      method: 'POST',
      headers: authHeaders(cfg),
    })
    return r.ok ? { ok: true } : { ok: false, error: `停止失败（${r.status}）` }
  } catch (e: any) {
    return { ok: false, error: `无法连接 Hermes：${e?.message || e}` }
  }
}