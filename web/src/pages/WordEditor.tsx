import { useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { UndoManager } from 'yjs'
import { useCollab } from '../store/useCollab'
import { colorOf } from '../store/user'
import ShareDrawer from '../components/ShareDrawer'
import HistoryDrawer from '../components/HistoryDrawer'
import { IdentityDialog } from '../components/GuestGate'
import ExportModal, { type DocFormat } from '../components/ExportModal'
import { download, blocksToMarkdown, blocksToText, printToPdf } from '../store/exporters'
import {
  blocksToDocx,
  docxToBlocks,
  type BlockType,
  type Run,
} from '../word/docx'
import type { ImportPayload } from '../store/importPayload'
import type { LocalUser } from '../store/user'
import EditableTitle from '../components/EditableTitle'
import { api } from '../store/api'
import { accessRevoked, forcedReadOnly, useMyAccess } from '../store/useMyAccess'

interface Props {
  docId: string
  name: string
  /** 通过分享链接进入时由 App 解析出的访客身份；工作台打开则为空 */
  identity?: LocalUser | null
  importPayload?: ImportPayload | null
  onImported?: () => void
  onBack: () => void
  onDocRenamed?: (next: string) => void
}

const LOCAL = Symbol('word-local')
const STRUCT = Symbol('word-struct')

/** 段落 id：时间戳 + 自增序号 + 随机，同一客户端内保证不重复 */
let BLOCK_SEQ = 0
const newBlockId = () =>
  `${Date.now().toString(36)}${(BLOCK_SEQ++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

type Align = 'left' | 'center' | 'right'
interface DeltaItem {
  insert: string
  attributes?: Record<string, any>
}
interface Blk {
  id: string
  type: BlockType
  align?: Align
  indent?: number
  done?: boolean
  delta: DeltaItem[]
}
interface Peer {
  id: string
  name: string
  colorIndex: number
  block: string | null
  guest?: boolean
}

const TYPE_LABEL: Record<BlockType, string> = {
  p: '正文',
  h1: '一级标题',
  h2: '二级标题',
  h3: '三级标题',
  h4: '四级标题',
  h5: '五级标题',
  h6: '六级标题',
  h7: '七级标题',
  h8: '八级标题',
  h9: '九级标题',
  ol: '有序列表',
  li: '无序列表',
  task: '任务',
  code: '代码块',
  quote: '引用',
  callout: '高亮块',
  sync: '同步块',
}
/** 工具栏下拉的一级项（H4-H9 收进「其他标题」子菜单） */
const MAIN_TYPES: BlockType[] = ['p', 'h1', 'h2', 'h3', 'ol', 'li', 'task', 'code', 'quote', 'callout', 'sync']
/** 段落菜单 / 插入菜单里的快捷 chips */
const CHIP_TYPES: BlockType[] = ['h1', 'h2', 'h3', 'ol', 'li', 'task', 'code', 'quote', 'callout', 'sync']
/** 插入菜单 chips 的短文案 */
const SHORT_LABEL: Record<BlockType, string> = {
  p: '正文',
  h1: 'H1', h2: 'H2', h3: 'H3', h4: 'H4', h5: 'H5', h6: 'H6', h7: 'H7', h8: 'H8', h9: 'H9',
  ol: '有序', li: '无序', task: '任务', code: '代码', quote: '引用', callout: '高亮', sync: '同步',
}

// 浮动菜单可选字体 / 颜色
const FONTS = ['宋体', '黑体', '楷体', '仿宋', '微软雅黑', 'Arial', 'Times New Roman', 'Courier New']
const TEXT_COLORS = ['#1F2329', '#BA0C00', '#185FA5', '#0F6E56', '#8F5B08', '#534AB7', '#993556']
const HL_COLORS = ['#FFF3A3', '#DEF7E6', '#D3E5FE', '#FDDDEC', '#E8DCFD']

// ---------- 纯函数工具 ----------
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
/** 行内属性 → HTML（未聚焦块回写 DOM 与初始化渲染共用） */
function deltaToHtml(delta: DeltaItem[]): string {
  return delta
    .map((d) => {
      const t = typeof d.insert === 'string' ? d.insert : ''
      const a = d.attributes || {}
      const styles: string[] = []
      if (a.bold) styles.push('font-weight:700')
      if (a.italic) styles.push('font-style:italic')
      if (a.underline) styles.push('text-decoration:underline')
      if (a.strike) styles.push('text-decoration:line-through')
      if (a.color) styles.push(`color:${esc(String(a.color))}`)
      if (a.hl) styles.push(`background-color:${esc(String(a.hl))}`)
      if (a.font) styles.push(`font-family:${esc(String(a.font))}`)
      let html = esc(t).replace(/\n/g, '<br>')
      if (a.code) html = `<code>${html}</code>`
      if (styles.length) html = `<span style="${styles.join(';')}">${html}</span>`
      if (a.link) {
        const href = esc(String(a.link))
        html = `<a href="${href}" target="_blank" rel="noreferrer">${html}</a>`
      }
      return html
    })
    .join('')
}
function markAttrs(r: Run): Record<string, any> {
  const a: Record<string, any> = {}
  if (r.b) a.bold = true
  if (r.i) a.italic = true
  if (r.u) a.underline = true
  if (r.s) a.strike = true
  if (r.code) a.code = true
  if (r.color) a.color = r.color
  if (r.hl) a.hl = r.hl
  if (r.font) a.font = r.font
  if (r.link) a.link = r.link
  return a
}
/** #RRGGBB 归一化：接受 rgb() / hex / 常见色名 */
function normColor(v: string): string {
  const v2 = v.trim().toLowerCase()
  const m = v2.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (m) {
    const hex = (n: string) => Number(n).toString(16).padStart(2, '0')
    return '#' + hex(m[1]) + hex(m[2]) + hex(m[3])
  }
  if (v2 === 'transparent' || v2 === 'rgba(0, 0, 0, 0)') return ''
  return v2.startsWith('#') ? v2 : v2
}
function splitDelta(delta: DeltaItem[], off: number): [DeltaItem[], DeltaItem[]] {
  const left: DeltaItem[] = []
  const right: DeltaItem[] = []
  let pos = 0
  for (const d of delta) {
    const t = typeof d.insert === 'string' ? d.insert : ''
    const len = t.length
    if (pos + len <= off) left.push(d)
    else if (pos >= off) right.push(d)
    else {
      const cut = off - pos
      left.push({ insert: t.slice(0, cut), attributes: d.attributes })
      right.push({ insert: t.slice(cut), attributes: d.attributes })
    }
    pos += len
  }
  return [left, right]
}
function runsFromNode(
  node: Node,
  marks: {
    b?: boolean
    i?: boolean
    u?: boolean
    s?: boolean
    code?: boolean
    color?: string
    hl?: string
    font?: string
    link?: string
  },
  out: Run[]
) {
  node.childNodes.forEach((n) => {
    if (n.nodeType === 3) {
      const txt = n.textContent || ''
      if (txt) out.push({ text: txt, ...marks })
    } else if (n.nodeType === 1) {
      const e = n as HTMLElement
      const tag = e.tagName.toLowerCase()
      if (tag === 'br') {
        out.push({ text: '\n', ...marks })
        return
      }
      const st = (e.getAttribute('style') || '').toLowerCase()
      const m = { ...marks }
      if (tag === 'b' || tag === 'strong' || st.includes('font-weight')) m.b = true
      if (tag === 'i' || tag === 'em' || st.includes('font-style')) m.i = true
      if (tag === 'u' || st.includes('underline')) m.u = true
      if (tag === 's' || tag === 'strike' || tag === 'del' || st.includes('line-through')) m.s = true
      if (tag === 'code' || st.includes('monospace')) m.code = true
      const cm = st.match(/(?:^|;)\s*color:\s*([^;]+)/)
      if (cm && !/background/.test(cm[1])) m.color = normColor(cm[1]) || m.color
      const bm = st.match(/background-color:\s*([^;]+)/)
      if (bm) m.hl = normColor(bm[1]) || m.hl
      const fm = st.match(/font-family:\s*([^;]+)/)
      if (fm) m.font = fm[1].split(',')[0].replace(/['"]/g, '').trim() || m.font
      if (tag === 'a') {
        const href = e.getAttribute('href') || ''
        if (href) m.link = href
      }
      runsFromNode(e, m, out)
    }
  })
}
function serializeEl(el: HTMLElement): Run[] {
  const out: Run[] = []
  runsFromNode(el, {}, out)
  // 合并相邻同样式的 run
  const merged: Run[] = []
  const key = (r: Run) => JSON.stringify([r.b, r.i, r.u, r.s, r.code, r.color, r.hl, r.font, r.link])
  for (const r of out) {
    const last = merged[merged.length - 1]
    if (last && key(last) === key(r)) last.text += r.text
    else merged.push({ ...r })
  }
  return merged
}
function caretOffset(el: HTMLElement): number {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return 0
  const range = sel.getRangeAt(0)
  const pre = document.createRange()
  pre.selectNodeContents(el)
  if (!el.contains(range.startContainer)) return 0
  pre.setEnd(range.startContainer, range.startOffset)
  return pre.toString().length
}
function setCaret(el: HTMLElement, offset: number) {
  const sel = window.getSelection()
  if (!sel) return
  let remaining = offset
  let node: Node | null = null
  let nodeOffset = 0
  const walk = (n: Node): boolean => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 3) {
        const len = (c.textContent || '').length
        if (remaining <= len) {
          node = c
          nodeOffset = remaining
          return true
        }
        remaining -= len
      } else if ((c as HTMLElement).tagName === 'BR') {
        if (remaining === 0) {
          node = c.parentNode
          nodeOffset = Array.from((c.parentNode as Node).childNodes).indexOf(c)
          return true
        }
        remaining -= 0
      } else if (walk(c)) return true
    }
    return false
  }
  if (!walk(el)) {
    node = el
    nodeOffset = el.childNodes.length
  }
  const r = document.createRange()
  try {
    r.setStart(node!, nodeOffset)
    r.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r)
  } catch {
    /* ignore */
  }
}

export default function WordEditor({
  docId,
  name,
  identity,
  importPayload,
  onImported,
  onBack,
  onDocRenamed,
}: Props) {
  const { ydoc, provider, user, rename } = useCollab(docId)
  const [docName, setDocName] = useState(name)
  const [renaming, setRenaming] = useState(false)
  const blocksArr = useMemo(() => ydoc.getArray<Y.Map<any>>('blocks'), [ydoc])
  const meta = useMemo(() => ydoc.getMap<any>('wmeta'), [ydoc])

  const [blocks, setBlocks] = useState<Blk[]>([])
  const [peers, setPeers] = useState<Peer[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [ready, setReady] = useState(false)
  /**
   * 服务端权限是唯一权威：被所有者设为「只读」的人在这里就是只读，
   * 本地按钮无法绕过——服务端会直接丢弃他的 Yjs 更新。
   * manualReadOnly 只是所有者自愿切到查看模式，可随时切回。
   */
  const access = useMyAccess(docId)
  const [manualReadOnly, setManualReadOnly] = useState(false)
  const lockedByPerm = forcedReadOnly(access)
  const readOnly = lockedByPerm || manualReadOnly
  const [drawer, setDrawer] = useState<'none' | 'share' | 'history' | 'people'>('none')
  const [exportOpen, setExportOpen] = useState(false)
  const [showRename, setShowRename] = useState(false)

  const refs = useRef<Map<string, HTMLDivElement>>(new Map())
  const focusRef = useRef<string | null>(null)
  const pending = useRef<{ id: string; offset: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const noticeTimer = useRef<number | null>(null)

  const flash = (m: string) => {
    setNotice(m)
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3000)
  }
  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

  /** 改名：调用后端持久化，成功后同步本地与 App 状态 */
  const renameDoc = async (next: string) => {
    if (renaming || next.trim() === docName) return
    setRenaming(true)
    try {
      const r = await api.renameDoc(docId, next.trim())
      setDocName(r.name)
      flash('已重命名')
      onDocRenamed?.(r.name)
    } catch (e) {
      flash('重命名失败：' + errMsg(e))
      throw e
    } finally {
      setRenaming(false)
    }
  }

  const snapshot = (): Blk[] => {
    const out: Blk[] = []
    blocksArr.forEach((m) => {
      const t = m.get('text') as Y.Text | undefined
      out.push({
        id: (m.get('id') as string) || '',
        type: (m.get('type') as BlockType) || 'p',
        align: (m.get('align') as Align) || undefined,
        indent: (m.get('indent') as number) || 0,
        done: !!m.get('done'),
        delta: t ? (t.toDelta() as DeltaItem[]) : [{ insert: '' }],
      })
    })
    return out
  }
  const findMap = (id: string): Y.Map<any> | undefined => {
    let found: Y.Map<any> | undefined
    blocksArr.forEach((m) => {
      if (m.get('id') === id) found = m
    })
    return found
  }
  const getText = (id: string): Y.Text | undefined =>
    findMap(id)?.get('text') as Y.Text | undefined

  /**
   * 安全写入 Y.Text：先整体清空再写入新内容。
   *
   * ⚠️ 不能无条件发 `{ delete: yt.length }`：yjs 13.6 的 deleteText 没有
   * length===0 的短路保护，遇到「空文本 + delete 0」会走到
   * `(currPos.left || currPos.right).parent` 而两者都是 null，直接抛
   * TypeError —— 异常从 input 事件冒泡出去，输入就永远写不进 Yjs（表现为「打字丢字」）。
   * 所以只有文本非空时才下发 delete。
   */
  const replaceText = (yt: Y.Text, delta: DeltaItem[]) => {
    const ops: any[] = []
    if (yt.length > 0) ops.push({ delete: yt.length })
    for (const d of delta) {
      if (d.insert === '' || d.insert == null) continue
      ops.push({ insert: d.insert, attributes: d.attributes })
    }
    if (ops.length) yt.applyDelta(ops)
  }

  const makeBlock = (type: BlockType = 'p', text?: Y.Text): Y.Map<any> => {
    const m = new Y.Map<any>()
    m.set('id', newBlockId())
    m.set('type', type)
    m.set('text', text || new Y.Text())
    return m
  }

  // 等待首次与服务端同步完成，避免在空 doc 上误建初始段落
  useEffect(() => {
    if (provider.synced) {
      setReady(true)
      return
    }
    const h = (s: boolean) => {
      if (s) setReady(true)
    }
    provider.on('sync', h)
    return () => provider.off('sync', h)
  }, [provider])

  // 初始化：至少一个段落（同步完成后才判定）
  useEffect(() => {
    if (!ready) return
    /**
     * 历史脏数据自愈：段落 id 重复会让 React key 冲突、且写入时找错段落
     * （findMap 命中的可能是另一个同 id 的段落，输入就丢了）。这里给重复的补新 id。
     */
    const seen = new Set<string>()
    const dupIdx: number[] = []
    blocksArr.toArray().forEach((m, i) => {
      const id = String(m.get('id') || '')
      if (!id || seen.has(id)) dupIdx.push(i)
      else seen.add(id)
    })
    if (dupIdx.length) {
      ydoc.transact(() => {
        for (const i of dupIdx) blocksArr.get(i).set('id', newBlockId())
      }, STRUCT)
    }
    if (blocksArr.length === 0 && !meta.get('init')) {
      ydoc.transact(() => {
        meta.set('init', true)
        if (blocksArr.length === 0) blocksArr.push([makeBlock('p')])
      }, STRUCT)
    }
    setBlocks(snapshot())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, blocksArr])

  // 观察文档变化
  useEffect(() => {
    const upd = (_events: any, tr: Y.Transaction) => {
      if (tr.origin === LOCAL) return
      setBlocks(snapshot())
    }
    blocksArr.observeDeep(upd)
    return () => blocksArr.unobserveDeep(upd)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocksArr])

  // 未聚焦的块：把 Yjs 内容写回 DOM
  useEffect(() => {
    for (const b of blocks) {
      if (focusRef.current === b.id) continue
      const el = refs.current.get(b.id)
      if (!el) continue
      const html = deltaToHtml(b.delta)
      if (el.innerHTML !== html) el.innerHTML = html
    }
  }, [blocks])

  // 撤销/重做
  const undoMgr = useRef<UndoManager | null>(null)
  useEffect(() => {
    const um = new UndoManager(blocksArr, { trackedOrigins: new Set([LOCAL]) })
    undoMgr.current = um
    const upd = () => {
      setCanUndo(um.undoStack.length > 0)
      setCanRedo(um.redoStack.length > 0)
    }
    um.on('stack-item-added', upd)
    um.on('stack-item-popped', upd)
    um.on('stack-cleared', upd)
    upd()
    return () => um.destroy()
  }, [blocksArr])

  // 光标落位（结构操作后）
  useEffect(() => {
    if (!pending.current) return
    const { id, offset } = pending.current
    pending.current = null
    const el = refs.current.get(id)
    if (el) {
      el.focus()
      setCaret(el, offset)
    }
  }, [blocks])

  // 在线协作者：聚焦块位置
  useEffect(() => {
    const aw = provider.awareness
    const upd = () => {
      const arr: Peer[] = []
      aw.getStates().forEach((st: any, clientId: number) => {
        if (clientId === aw.clientID) return
        if (!st?.user) return
        arr.push({
          id: st.user.id,
          name: st.user.name,
          colorIndex: st.user.colorIndex,
          block: (st.wblock as string) ?? null,
          guest: !!st.user.guest,
        })
      })
      setPeers(arr)
    }
    aw.on('change', upd)
    upd()
    return () => aw.off('change', upd)
  }, [provider])

  const commitFocus = (id: string | null) => {
    focusRef.current = id
    setActive(id)
    provider.awareness.setLocalStateField('wblock', id)
  }

  // 本地输入同步到 Yjs
  const pushBlock = (id: string) => {
    const el = refs.current.get(id)
    const yt = getText(id)
    if (!el || !yt) return
    const runs = serializeEl(el)
    const delta: DeltaItem[] = runs.map((r) => ({ insert: r.text, attributes: markAttrs(r) }))
    ydoc.transact(() => replaceText(yt, delta), LOCAL)
  }

  const onKeyDown = (id: string, e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = refs.current.get(id)
    if (!el) return
    const yt = getText(id)
    if (!yt) return
    if (e.key === 'Enter') {
      e.preventDefault()
      const off = caretOffset(el)
      const delta = yt.toDelta() as DeltaItem[]
      const [left, right] = splitDelta(delta, off)
      const m = findMap(id)
      const curType = (m?.get('type') as BlockType) || 'p'
      // 代码块内：Enter = 换行，Ctrl/Cmd+Enter = 退出代码块另起一段
      if (curType === 'code' && !e.ctrlKey && !e.metaKey) {
        document.execCommand('insertLineBreak')
        pushBlock(id)
        return
      }
      // 列表 / 任务 / 引用：回车延续类型；其余回车回到正文
      const contType: BlockType =
        curType === 'li' || curType === 'ol' || curType === 'task' || curType === 'quote'
          ? curType
          : 'p'
      /**
       * 注意：未整合（prelim）的 Y.Map 上 get('text') 读不到值（返回 undefined），
       * 必须自己持有 Y.Text 引用，整合前不能从 Map 里取。
       */
      const nbText = new Y.Text()
      const nb = makeBlock(contType, nbText)
      if (contType !== 'p') {
        const ind = (m?.get('indent') as number) || 0
        if (ind > 0) nb.set('indent', ind)
      }
      const idx = blocksArr.toArray().indexOf(m!)
      ydoc.transact(() => {
        replaceText(yt, left)
        replaceText(nbText, right)
        blocksArr.insert(idx + 1, [nb])
      }, STRUCT)
      pending.current = { id: nb.get('id') as string, offset: 0 }
      focusRef.current = null
      setBlocks(snapshot())
      return
    }
    if (e.key === 'Backspace') {
      const off = caretOffset(el)
      if (off === 0) {
        const m = findMap(id)
        const ind = (m?.get('indent') as number) || 0
        // 空的非正文段落：先退回正文（飞书行为）
        if (m && m.get('type') !== 'p' && yt.length === 0) {
          e.preventDefault()
          ydoc.transact(() => {
            m.set('type', 'p')
            if (m.get('done')) m.set('done', false)
          }, STRUCT)
          setBlocks(snapshot())
          return
        }
        // 有缩进：先减缩进
        if (ind > 0) {
          e.preventDefault()
          ydoc.transact(() => m!.set('indent', ind - 1), STRUCT)
          setBlocks(snapshot())
          return
        }
        const idx = blocksArr.toArray().indexOf(m!)
        if (idx > 0) {
          e.preventDefault()
          const prev = blocksArr.get(idx - 1)
          const prevText = prev.get('text') as Y.Text
          const prevLen = prevText.length
          const delta = yt.toDelta() as DeltaItem[]
          ydoc.transact(() => {
            // applyDelta 的纯 insert 落在位置 0（开头），追加到上段末尾要先 retain 到末尾
            const ops: any[] = []
            if (prevText.length > 0) ops.push({ retain: prevText.length })
            ops.push(...delta.filter((d) => d.insert !== '' && d.insert != null).map((d) => ({ insert: d.insert, attributes: d.attributes })))
            if (ops.length > (prevText.length > 0 ? 1 : 0)) prevText.applyDelta(ops)
            blocksArr.delete(idx, 1)
          }, STRUCT)
          pending.current = { id: prev.get('id') as string, offset: prevLen }
          focusRef.current = null
          setBlocks(snapshot())
        }
      }
    }
  }

  // 工具栏动作（可指定目标段落，供段落菜单/插入菜单复用）
  const setType = (t: BlockType, forId?: string) => {
    const id = forId || focusRef.current || active || blocks[0]?.id
    if (!id) return
    const m = findMap(id)
    if (!m) return
    ydoc.transact(() => {
      m.set('type', t)
      if (t !== 'task' && m.get('done')) m.set('done', false)
    }, STRUCT)
    setBlocks(snapshot())
  }
  const setAlign = (a: Align) => {
    const id = focusRef.current || active
    if (!id) return
    const m = findMap(id)
    if (!m) return
    ydoc.transact(() => m.set('align', m.get('align') === a ? undefined : a), STRUCT)
    setBlocks(snapshot())
  }

  // ---- 段落级操作（手柄菜单 / 加号 / 拖拽共用） ----
  const setIndent = (id: string, d: number) => {
    const m = findMap(id)
    if (!m) return
    const cur = (m.get('indent') as number) || 0
    ydoc.transact(() => m.set('indent', Math.min(8, Math.max(0, cur + d))), STRUCT)
    setBlocks(snapshot())
  }
  const toggleDone = (id: string) => {
    const m = findMap(id)
    if (!m) return
    ydoc.transact(() => m.set('done', !m.get('done')), STRUCT)
    setBlocks(snapshot())
  }
  /** 在某段之后插入新段落并聚焦，返回新段落 id */
  const insertBlockAfter = (afterId: string, type: BlockType = 'p'): string | null => {
    const m = findMap(afterId)
    if (!m) return null
    const idx = blocksArr.toArray().indexOf(m)
    const nb = makeBlock(type)
    ydoc.transact(() => blocksArr.insert(idx + 1, [nb]), STRUCT)
    pending.current = { id: nb.get('id') as string, offset: 0 }
    focusRef.current = null
    setBlocks(snapshot())
    return nb.get('id') as string
  }
  const deleteBlock = (id: string) => {
    if (blocksArr.length <= 1) {
      flash('至少保留一个段落')
      return
    }
    const idx = blocksArr.toArray().findIndex((m) => m.get('id') === id)
    if (idx < 0) return
    ydoc.transact(() => blocksArr.delete(idx, 1), STRUCT)
    focusRef.current = null
    setBlocks(snapshot())
  }
  const duplicateBlock = (id: string) => {
    const m = findMap(id)
    if (!m) return
    const idx = blocksArr.toArray().indexOf(m)
    // prelim Map 的 get('text') 读不到值，必须持有 Y.Text 引用（见 Enter 分支注释）
    const nt = new Y.Text()
    const nb = makeBlock(m.get('type') as BlockType, nt)
    if (m.get('indent')) nb.set('indent', m.get('indent'))
    if (m.get('done')) nb.set('done', true)
    const dd = (m.get('text') as Y.Text).toDelta() as DeltaItem[]
    if (dd.length) nt.applyDelta(dd.map((d) => ({ insert: d.insert, attributes: d.attributes })))
    ydoc.transact(() => blocksArr.insert(idx + 1, [nb]), STRUCT)
    setBlocks(snapshot())
  }
  const applyBlockColor = (id: string, kind: 'fore' | 'hl', val: string) => {
    const el = refs.current.get(id)
    if (!el) return
    el.focus()
    commitFocus(id)
    document.execCommand('selectAll', false)
    execInline(kind === 'fore' ? 'foreColor' : 'hiliteColor', val)
  }
  // ---- 行内格式命令（浮动菜单 + 顶栏共用） ----
  const syncAfterCmd = () => {
    const id = focusRef.current
    if (id) pushBlock(id)
  }
  /** document.execCommand 包装：样式类命令用 CSS 产出，方便 DOM 反序列化 */
  const execInline = (cmd: string, val?: string) => {
    const styled = cmd === 'foreColor' || cmd === 'hiliteColor' || cmd === 'fontName'
    if (styled) document.execCommand('styleWithCSS', false, 'true')
    document.execCommand(cmd, false, val)
    if (styled) document.execCommand('styleWithCSS', false, 'false')
    syncAfterCmd()
  }
  /** 选中文字是否已在 code 内（决定代码格式是加还是除） */
  const selectionInCode = (): boolean => {
    const sel = window.getSelection()
    const anchor = sel?.anchorNode
    if (!anchor) return false
    const el = anchor.nodeType === 3 ? anchor.parentElement : (anchor as HTMLElement)
    return !!el?.closest('code')
  }
  /** 行内代码：无原生命令，手动包裹 / 解开 <code> */
  const toggleCode = () => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return
    const range = sel.getRangeAt(0)
    // 选区可能完全落在一个文本节点内，遍历根要取其父元素
    const root =
      range.commonAncestorContainer.nodeType === 3
        ? range.commonAncestorContainer.parentNode!
        : range.commonAncestorContainer
    const inCode = selectionInCode()
    if (inCode) {
      // 解开选区内所有 code 包裹
      const codes: HTMLElement[] = []
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
      while (walker.nextNode()) {
        const n = walker.currentNode as HTMLElement
        if (n.tagName === 'CODE' && range.intersectsNode(n)) codes.push(n)
      }
      if ((root as HTMLElement).tagName === 'CODE') codes.push(root as HTMLElement)
      codes.forEach((c) => {
        const parent = c.parentNode
        if (!parent) return
        while (c.firstChild) parent.insertBefore(c.firstChild, c)
        parent.removeChild(c)
        parent.normalize()
      })
    } else {
      // 先在文本节点边界处断开，再逐个包裹
      if (range.startContainer.nodeType === 3 && range.startOffset > 0) {
        const t = (range.startContainer as Text).splitText(range.startOffset)
        range.setStart(t, 0)
      }
      if (range.endContainer.nodeType === 3 && range.endOffset < (range.endContainer as Text).length) {
        ;(range.endContainer as Text).splitText(range.endOffset)
      }
      const texts: Text[] = []
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const n = walker.currentNode as Text
        if (n.nodeValue && range.intersectsNode(n)) texts.push(n)
      }
      texts.forEach((t) => {
        const code = document.createElement('code')
        t.parentNode?.insertBefore(code, t)
        code.appendChild(t)
      })
    }
    syncAfterCmd()
  }

  const curType: BlockType =
    (active && (findMap(active)?.get('type') as BlockType)) || 'p'
  const curAlign: Align | undefined = active
    ? (findMap(active)?.get('align') as Align | undefined)
    : undefined

  // ---- 选中浮动菜单 ----
  interface SelMenuPos {
    x: number
    above: number
    below: number
  }
  interface SelStates {
    b: boolean
    i: boolean
    u: boolean
    s: boolean
    code: boolean
    link: string | null
  }
  const [menu, setMenu] = useState<SelMenuPos | null>(null)
  const [selSt, setSelSt] = useState<SelStates>({ b: false, i: false, u: false, s: false, code: false, link: null })
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [linkEdit, setLinkEdit] = useState<{ url: string } | null>(null)
  const savedRange = useRef<Range | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // ---- 段落手柄：拖拽 + 段落菜单 / 加号插入菜单 / 顶栏段落类型下拉 ----
  const [blockMenu, setBlockMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [insMenu, setInsMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [bmenuSub, setBmenuSub] = useState<'indent' | 'color' | null>(null)
  const [wtypeOpen, setWtypeOpen] = useState(false)
  const [hnOpen, setHnOpen] = useState(false)
  const [drag, setDrag] = useState<{ id: string; startX: number; startY: number } | null>(null)
  const [dropIdx, setDropIdx] = useState<number | null>(null)
  const dropIdxRef = useRef<number | null>(null)

  // 拖拽段落：mousemove 计算落点，mouseup 落位（点击不动 = 打开段落菜单）
  useEffect(() => {
    if (!drag) return
    let movedFar = false
    const onMove = (e: MouseEvent) => {
      if (!movedFar && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 4) {
        movedFar = true
        document.body.classList.add('block-dragging')
        setBlockMenu(null)
      }
      if (!movedFar) return
      let idx = blocks.length
      for (let i = 0; i < blocks.length; i++) {
        const el = refs.current.get(blocks[i].id)
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (e.clientY < r.top + r.height / 2) {
          idx = i
          break
        }
      }
      dropIdxRef.current = idx
      setDropIdx(idx)
    }
    const onUp = () => {
      document.body.classList.remove('block-dragging')
      const did = drag.id
      const idx = dropIdxRef.current
      setDrag(null)
      setDropIdx(null)
      dropIdxRef.current = null
      if (!movedFar) return // 只是点击未拖动：菜单由 T 按钮负责，六点不做任何事
      if (idx === null) return
      const arr = blocksArr.toArray()
      const from = arr.findIndex((m) => m.get('id') === did)
      if (from < 0) return
      let to = idx
      if (to > from) to -= 1
      if (to === from) return
      /**
       * Yjs 不能把已 delete 的同一个 Y.Map 实例重新 insert（重整合会得到
       * 一个空壳 Map，id/type/text 全部丢失）。这里显式重建一个副本再落位。
       */
      const src = arr[from]
      const copy = new Y.Map<any>()
      copy.set('id', newBlockId())
      copy.set('type', src.get('type') || 'p')
      for (const k of ['align', 'indent', 'done'] as const) {
        if (src.get(k) != null) copy.set(k, src.get(k))
      }
      const nt = new Y.Text()
      const dd = ((src.get('text') as Y.Text | undefined)?.toDelta() || []) as DeltaItem[]
      if (dd.length) nt.applyDelta(dd.map((d) => ({ insert: d.insert, attributes: d.attributes })))
      copy.set('text', nt)
      ydoc.transact(() => {
        blocksArr.delete(from, 1)
        blocksArr.insert(to, [copy])
      }, STRUCT)
      setBlocks(snapshot())
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('block-dragging')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag])

  // 菜单外点击 / Escape：关闭所有弹出菜单
  useEffect(() => {
    if (!blockMenu && !insMenu && !wtypeOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('.bmenu') || t.closest('.ins-menu') || t.closest('.wtype-dd')) return
      setBlockMenu(null)
      setInsMenu(null)
      setWtypeOpen(false)
      setHnOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setBlockMenu(null)
        setInsMenu(null)
        setWtypeOpen(false)
        setHnOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [blockMenu, insMenu, wtypeOpen])

  useEffect(() => {
    const onSelChange = () => {
      if (linkEdit) return // 编辑链接地址时保持菜单
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setMenu(null)
        setOpenKey(null)
        return
      }
      const r = sel.getRangeAt(0)
      const anchorEl =
        r.startContainer.nodeType === 3
          ? r.startContainer.parentElement
          : (r.startContainer as HTMLElement)
      if (!anchorEl || !anchorEl.closest('.wblock') || readOnly) {
        setMenu(null)
        setOpenKey(null)
        return
      }
      const rect = r.getBoundingClientRect()
      if (!rect.width && !rect.height) return
      setMenu({ x: rect.left + rect.width / 2, above: rect.top, below: rect.bottom })
      try {
        setSelSt({
          b: document.queryCommandState('bold'),
          i: document.queryCommandState('italic'),
          u: document.queryCommandState('underline'),
          s: document.queryCommandState('strikeThrough'),
          code: !!anchorEl.closest('code'),
          link: anchorEl.closest('a')?.getAttribute('href') || null,
        })
      } catch {
        /* ignore */
      }
    }
    const onScroll = (e: Event) => {
      if (!menuRef.current || menuRef.current.contains(e.target as Node)) return
      setMenu(null)
      setOpenKey(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenKey(null)
        setLinkEdit(null)
      }
    }
    document.addEventListener('selectionchange', onSelChange)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('selectionchange', onSelChange)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      document.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, linkEdit])

  /** 浮动菜单按钮统一入口：不抢焦点，保住选区 */
  const menuAction = (fn: () => void) => {
    setOpenKey(null)
    setLinkEdit(null)
    fn()
  }
  const beginLinkEdit = () => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    savedRange.current = sel.getRangeAt(0).cloneRange()
    setLinkEdit({ url: selSt.link || '' })
  }
  const confirmLink = () => {
    const url = linkEdit?.url.trim() || ''
    const range = savedRange.current
    setLinkEdit(null)
    setOpenKey(null)
    if (!range) return
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    if (!url || url === '') {
      document.execCommand('unlink')
    } else {
      const full = /^https?:\/\//i.test(url) ? url : 'https://' + url
      document.execCommand('createLink', false, full)
    }
    syncAfterCmd()
  }

  // 把一组段落整体写入 Yjs（导入 .docx / 模板 / .md 共用）
  const writeBlocks = (
    parsed: { id?: string; type: BlockType; align?: Align; runs: Run[] }[],
    label: string
  ) => {
    ydoc.transact(() => {
      blocksArr.delete(0, blocksArr.length)
      meta.set('init', true)
      const items = parsed.map((b) => {
        const m = new Y.Map<any>()
        m.set('id', b.id || Math.random().toString(36).slice(2, 10))
        m.set('type', b.type)
        if (b.align) m.set('align', b.align)
        const t = new Y.Text()
        m.set('text', t)
        const delta = b.runs
          .filter((r) => r.text)
          .map((r) => ({ insert: r.text, attributes: markAttrs(r) }))
        if (delta.length) t.applyDelta(delta)
        return m
      })
      blocksArr.push(items)
    }, STRUCT)
    setBlocks(snapshot())
    flash(label)
  }

  // 待导入内容（工作台解析好传过来的）：同步完成后写入一次
  const importedRef = useRef(false)
  const [syncTick, setSyncTick] = useState(0)
  useEffect(() => {
    if (provider.synced) return
    const h = (s: boolean) => s && setSyncTick((t) => t + 1)
    provider.on('sync', h)
    return () => provider.off('sync', h)
  }, [provider, provider.synced])

  useEffect(() => {
    if (!importPayload || importedRef.current) return
    if (importPayload.target !== 'doc') return
    if (!ready || !provider.synced) return
    importedRef.current = true
    writeBlocks(
      importPayload.blocks as { id?: string; type: BlockType; align?: Align; runs: Run[] }[],
      `已导入：${importPayload.blocks.length} 个段落（${importPayload.file}）`
    )
    onImported?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importPayload, ready, provider.synced, syncTick])

  // 导入 docx
  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const buf = new Uint8Array(await file.arrayBuffer())
      const parsed = docxToBlocks(buf)
      if (!parsed.length) throw new Error('文档中没有可用段落')
      writeBlocks(parsed, `已导入：${parsed.length} 个段落（${file.name}）`)
    } catch (err) {
      flash('导入失败：' + errMsg(err))
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  // 当前段落文本（导出用）
  const plainBlocks = () =>
    blocks.map((b) => ({
      id: b.id,
      type: b.type,
      align: b.align,
      runs: b.delta
        .filter((d) => typeof d.insert === 'string')
        .map((d) => ({
          text: d.insert,
          b: !!d.attributes?.bold,
          i: !!d.attributes?.italic,
          u: !!d.attributes?.underline,
          s: !!d.attributes?.strike,
          code: !!d.attributes?.code,
          color: d.attributes?.color,
          hl: d.attributes?.hl,
          font: d.attributes?.font,
          link: d.attributes?.link,
        })),
    }))

  // 导出（S7 多格式）
  const onExportFormat = (fmt: DocFormat) => {
    try {
      if (blocks.length === 0 || blocks.every((b) => !b.delta.length)) {
        flash('文档还没有内容')
        return
      }
      const base = docName || 'document'
      if (fmt === 'docx') {
        const data = blocksToDocx(plainBlocks())
        download(
          base + '.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          data
        )
      } else if (fmt === 'md') {
        download(
          base + '.md',
          'text/markdown;charset=utf-8',
          blocksToMarkdown(
            blocks.map((b) => ({
              id: b.id,
              type: b.type,
              text: b.delta.map((d) => String(d.insert ?? '')).join(''),
            }))
          )
        )
      } else if (fmt === 'txt') {
        download(
          base + '.txt',
          'text/plain;charset=utf-8',
          blocksToText(
            blocks.map((b) => ({
              id: b.id,
              type: b.type,
              text: b.delta.map((d) => String(d.insert ?? '')).join(''),
            }))
          )
        )
      } else {
        printToPdf()
      }
    } catch (err) {
      flash('导出失败：' + errMsg(err))
    }
  }

  // 大纲：只取标题层级
  const outline = useMemo(
    () =>
      blocks
        .map((b, i) => ({ b, i }))
        .filter(({ b }) => b.type === 'h1' || b.type === 'h2' || b.type === 'h3')
        .map(({ b, i }) => ({
          id: b.id,
          level: b.type,
          text: b.delta.map((d) => String(d.insert ?? '')).join('') || '（空标题）',
          index: i + 1,
        })),
    [blocks]
  )

  const scrollToBlock = (id: string) => {
    const el = refs.current.get(id)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('flash-target')
      window.setTimeout(() => el.classList.remove('flash-target'), 1200)
    }
  }

  const peersByBlock = useMemo(() => {
    const map = new Map<string, Peer>()
    for (const p of peers) if (p.block) map.set(p.block, p)
    return map
  }, [peers])

  // 段落类型下拉项（图标 + 文案 + 当前类型打勾）
  const wtypeItem = (t: BlockType) => (
    <button
      key={t}
      className={'wtype-item' + (curType === t ? ' on' : '')}
      onClick={() => {
        setType(t)
        setWtypeOpen(false)
        setHnOpen(false)
      }}
    >
      <span className="wt-glyph">{typeGlyph(t)}</span>
      <span>{TYPE_LABEL[t]}</span>
      {curType === t && <span className="wt-check">✓</span>}
    </button>
  )

  // 加号：在下方插入新段落并打开插入菜单
  const onPlus = (id: string, e: React.MouseEvent) => {
    if (readOnly) return
    e.stopPropagation()
    setBlockMenu(null)
    const nid = insertBlockAfter(id, 'p')
    if (nid) setInsMenu({ id: nid, x: e.clientX, y: e.clientY })
  }
  // 插入菜单：给刚插入的段落设置类型并聚焦
  const insPick = (t: BlockType) => {
    if (!insMenu) return
    const nid = insMenu.id
    setType(t, nid)
    setInsMenu(null)
    const el = refs.current.get(nid)
    if (el) {
      el.focus()
      setCaret(el, 0)
    }
  }

  // 权限被所有者收回：不再渲染内容，给一个明确的去向
  if (accessRevoked(access)) {
    return (
      <div className="guest-mask">
        <div className="guest-card">
          <div className="guest-badge">权限已收回</div>
          <h2 className="guest-title">你已无法访问这份文档</h2>
          <p className="guest-sub">
            所有者取消了你的访问权限，或已收回分享链接。如需继续编辑，请向所有者重新申请。
          </p>
          <div className="modal-actions">
            <button className="btn-primary" onClick={onBack}>
              返回工作台
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="editor">
      <header className="topbar">
        <div className="topbar-left">
          <button className="btn-ghost icon" onClick={onBack} title="返回工作台">
            ‹
          </button>
          <EditableTitle
            name={docName}
            disabled={renaming}
            onRename={renameDoc}
          />
          <span className="doc-kind">文档</span>
          <button
            className="wpresence presence-btn-clean"
            onClick={() => setDrawer('people')}
            title="查看协作者"
          >
            {peers.slice(0, 5).map((p) => {
              const c = colorOf(p.colorIndex)
              return (
                <span key={p.id} className="avatar" style={{ background: c.ink }} title={p.name}>
                  {p.name.slice(0, 1)}
                </span>
              )
            })}
            {peers.length > 5 && <span className="avatar more">+{peers.length - 5}</span>}
          </button>
        </div>
        <div className="topbar-right">
          <div className="topbar-more">
            {!lockedByPerm && (
              <button className="btn-ghost" onClick={() => setManualReadOnly((v) => !v)}>
                {readOnly ? '恢复编辑' : '只读查看'}
              </button>
            )}
            <button className="btn-ghost" onClick={() => setDrawer('history')}>
              历史
            </button>
            <button className="btn-ghost" onClick={() => fileRef.current?.click()} disabled={readOnly}>
              导入
            </button>
            <button className="btn-ghost" onClick={() => setExportOpen(true)}>
              导出
            </button>
          </div>
          <button className="btn-primary" onClick={() => setDrawer('share')}>
            分享
          </button>
        </div>
      </header>
      <input ref={fileRef} type="file" accept=".docx" hidden onChange={onImport} />

      <div className="word-toolbar">
        <button
          className="tbtn"
          disabled={!canUndo}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => undoMgr.current?.undo()}
          title="撤销（仅本人，Ctrl+Z）"
        >
          ↶
        </button>
        <button
          className="tbtn"
          disabled={!canRedo}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => undoMgr.current?.redo()}
          title="重做（Ctrl+Y）"
        >
          ↷
        </button>
        <span className="toolbar-sep" />
        {/* 段落属性下拉（复刻飞书正文菜单）。
            整个容器阻止 mousedown 默认行为：否则点菜单项时 contentEditable
            会先失焦把 active 清空，setType 找不到目标段落，表现为「点了没反应」 */}
        <div className="wtype-dd" onMouseDown={(e) => e.preventDefault()}>
          <button
            className={'tbtn wtype-btn' + (wtypeOpen ? ' open' : '')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setWtypeOpen((v) => !v)
              setHnOpen(false)
            }}
            title="设置段落属性"
          >
            {TYPE_LABEL[curType]} <Caret />
          </button>
          {wtypeOpen && (
            <div className="wtype-menu">
              {wtypeItem('p')}
              {wtypeItem('h1')}
              {wtypeItem('h2')}
              {wtypeItem('h3')}
              <div
                className="wtype-sub-wrap"
                onMouseEnter={() => setHnOpen(true)}
                onMouseLeave={() => setHnOpen(false)}
              >
                <button
                  className={'wtype-item' + (/^h[4-9]$/.test(curType) ? ' on' : '')}
                  onClick={() => setHnOpen((v) => !v)}
                >
                  <span className="wt-glyph wt-hn">Hₙ</span>
                  <span>其他标题</span>
                  <span className="wt-arrow">›</span>
                </button>
                {hnOpen && (
                  <div className="wtype-sub">
                    {(['h4', 'h5', 'h6', 'h7', 'h8', 'h9'] as BlockType[]).map((t) => wtypeItem(t))}
                  </div>
                )}
              </div>
              {wtypeItem('ol')}
              {wtypeItem('li')}
              {wtypeItem('task')}
              {wtypeItem('code')}
              <div className="wtype-sep" />
              {wtypeItem('quote')}
              {wtypeItem('callout')}
              {wtypeItem('sync')}
            </div>
          )}
        </div>
        <span className="toolbar-sep" />
        <button
          className={'tbtn' + (curAlign === 'left' ? ' active' : '')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setAlign('left')}
          title="左对齐"
        >
          <AlignGlyph mode="left" />
        </button>
        <button
          className={'tbtn' + (curAlign === 'center' ? ' active' : '')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setAlign('center')}
          title="居中"
        >
          <AlignGlyph mode="center" />
        </button>
        <button
          className={'tbtn' + (curAlign === 'right' ? ' active' : '')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setAlign('right')}
          title="右对齐"
        >
          <AlignGlyph mode="right" />
        </button>
        <span className="toolbar-sep" />
        <button
          className="tbtn"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => execInline('bold')}
          title="加粗"
        >
          <b>B</b>
        </button>
        <button
          className="tbtn"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => execInline('strikeThrough')}
          title="删除线"
        >
          <s>S</s>
        </button>
        <button
          className="tbtn"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => execInline('italic')}
          title="斜体"
        >
          <i>I</i>
        </button>
        <button
          className="tbtn"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => execInline('underline')}
          title="下划线"
        >
          <u>U</u>
        </button>
        <button
          className="tbtn"
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleCode}
          title="行内代码"
        >
          {'</>'}
        </button>
        <span className="toolbar-hint">选中文字即可在浮动菜单设置格式</span>
      </div>

      {menu && !readOnly && (
        <div
          ref={menuRef}
          className="sel-menu"
          style={{
            left: Math.min(Math.max(menu.x, 320), window.innerWidth - 320),
            top: menu.above > 60 ? menu.above - 46 : menu.below + 8,
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {linkEdit ? (
            <div className="sel-link-edit">
              <input
                autoFocus
                value={linkEdit.url}
                placeholder="输入链接地址，留空则清除"
                onChange={(e) => setLinkEdit({ url: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmLink()
                }}
                onMouseDown={(e) => e.stopPropagation()}
              />
              <button onClick={confirmLink}>确定</button>
              {selSt.link && (
                <button
                  onClick={() =>
                    menuAction(() => {
                      if (savedRange.current) {
                        const sel = window.getSelection()
                        sel?.removeAllRanges()
                        sel?.addRange(savedRange.current)
                      }
                      document.execCommand('unlink')
                      syncAfterCmd()
                    })
                  }
                >
                  清除
                </button>
              )}
            </div>
          ) : (
            <>
              {/* 字体 */}
              <div className="sel-dd">
                <button
                  className={'sel-btn font-btn' + (openKey === 'font' ? ' open' : '')}
                  onClick={() => setOpenKey(openKey === 'font' ? null : 'font')}
                  title="字体"
                >
                  <span className="font-glyph">T</span>
                  <Caret />
                </button>
                {openKey === 'font' && (
                  <div className="sel-pop">
                    {FONTS.map((f) => (
                      <button
                        key={f}
                        className="sel-pop-item"
                        style={{ fontFamily: f }}
                        onClick={() => menuAction(() => execInline('fontName', f))}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <span className="sel-sep" />
              {/* 对齐 */}
              <div className="sel-dd">
                <button
                  className={'sel-btn' + (openKey === 'align' ? ' open' : '')}
                  onClick={() => setOpenKey(openKey === 'align' ? null : 'align')}
                  title="对齐"
                >
                  <AlignGlyph mode={curAlign || 'left'} />
                  <Caret />
                </button>
                {openKey === 'align' && (
                  <div className="sel-pop">
                    {(['left', 'center', 'right'] as Align[]).map((a) => (
                      <button
                        key={a}
                        className={'sel-pop-item' + (curAlign === a ? ' on' : '')}
                        onClick={() => menuAction(() => setAlign(a))}
                      >
                        <AlignGlyph mode={a} />
                        {a === 'left' ? '左对齐' : a === 'center' ? '居中' : '右对齐'}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <span className="sel-sep" />
              <button
                className={'sel-btn' + (selSt.b ? ' active' : '')}
                onClick={() => menuAction(() => execInline('bold'))}
                title="加粗"
              >
                <b>B</b>
              </button>
              <button
                className={'sel-btn' + (selSt.s ? ' active' : '')}
                onClick={() => menuAction(() => execInline('strikeThrough'))}
                title="删除线"
              >
                <s>S</s>
              </button>
              <button
                className={'sel-btn' + (selSt.i ? ' active' : '')}
                onClick={() => menuAction(() => execInline('italic'))}
                title="斜体"
              >
                <i>I</i>
              </button>
              <button
                className={'sel-btn' + (selSt.u ? ' active' : '')}
                onClick={() => menuAction(() => execInline('underline'))}
                title="下划线"
              >
                <u>U</u>
              </button>
              <button
                className={'sel-btn' + (selSt.link ? ' active' : '')}
                onClick={() => menuAction(beginLinkEdit)}
                title="链接"
              >
                <LinkGlyph />
              </button>
              <button
                className={'sel-btn' + (selSt.code ? ' active' : '')}
                onClick={() => menuAction(toggleCode)}
                title="行内代码"
              >
                <CodeGlyph />
              </button>
              {/* 高亮色 */}
              <div className="sel-dd">
                <button
                  className={'sel-btn' + (openKey === 'hl' ? ' open' : '')}
                  onClick={() => setOpenKey(openKey === 'hl' ? null : 'hl')}
                  title="高亮色"
                >
                  <MarkGlyph color="#FDE047" />
                  <Caret />
                </button>
                {openKey === 'hl' && (
                  <div className="sel-pop">
                    <div className="sel-pop-label">高亮</div>
                    <div className="sel-swatches">
                      {HL_COLORS.map((c) => (
                        <button
                          key={c}
                          className="sel-swatch"
                          style={{ background: c }}
                          onClick={() => menuAction(() => execInline('hiliteColor', c))}
                        />
                      ))}
                    </div>
                    <button
                      className="sel-pop-item"
                      onClick={() => menuAction(() => execInline('hiliteColor', 'transparent'))}
                    >
                      无高亮
                    </button>
                  </div>
                )}
              </div>
              {/* 文字颜色 */}
              <div className="sel-dd">
                <button
                  className={'sel-btn' + (openKey === 'color' ? ' open' : '')}
                  onClick={() => setOpenKey(openKey === 'color' ? null : 'color')}
                  title="文字颜色"
                >
                  <span className="color-glyph">
                    A<span className="color-bar" />
                  </span>
                  <Caret />
                </button>
                {openKey === 'color' && (
                  <div className="sel-pop">
                    <div className="sel-pop-label">文字颜色</div>
                    <div className="sel-swatches">
                      {TEXT_COLORS.map((c) => (
                        <button
                          key={c}
                          className="sel-swatch"
                          style={{ background: c }}
                          onClick={() => menuAction(() => execInline('foreColor', c))}
                        />
                      ))}
                    </div>
                    <button
                      className="sel-pop-item"
                      onClick={() => menuAction(() => execInline('foreColor', '#1F2329'))}
                    >
                      默认黑色
                    </button>
                  </div>
                )}
              </div>
              <span className="sel-sep" />
              <button
                className={'sel-btn' + (curType === 'li' ? ' active' : '')}
                onClick={() => menuAction(() => setType(curType === 'li' ? 'p' : 'li'))}
                title="列表"
              >
                <ListGlyph />
              </button>
            </>
          )}
        </div>
      )}

      {/* 段落手柄菜单：段落属性 + 缩进对齐 / 颜色 / 复制 / 删除 / 在下方添加 */}
      {blockMenu && !readOnly &&
        (() => {
          const mb = blocks.find((b) => b.id === blockMenu.id)
          const cur = mb?.type || 'p'
          return (
            <div
              className="bmenu"
              style={{
                left: Math.min(Math.max(blockMenu.x - 12, 8), window.innerWidth - 270),
                top: Math.min(blockMenu.y + 4, window.innerHeight - 340),
              }}
              onMouseDown={(e) => e.preventDefault()}
            >
              <div className="bmenu-chips">
                <button
                  className={'bchip bchip-t' + (cur === 'p' ? ' on' : '')}
                  title="正文"
                  onClick={() => setType('p', blockMenu.id)}
                >
                  T
                </button>
                {CHIP_TYPES.map((t) => (
                  <button
                    key={t}
                    className={'bchip' + (cur === t ? ' on' : '')}
                    title={TYPE_LABEL[t]}
                    onClick={() => setType(t, blockMenu.id)}
                  >
                    {typeGlyph(t, true)}
                  </button>
                ))}
              </div>
              <div className="bmenu-sep" />
              <div
                className="bmenu-item-wrap"
                onMouseEnter={() => setBmenuSub('indent')}
                onMouseLeave={() => setBmenuSub(null)}
              >
                <button className="bmenu-item">
                  <IndentGlyph />
                  缩进和对齐
                  <span className="wt-arrow">›</span>
                </button>
                {bmenuSub === 'indent' && (
                  <div className="bmenu-sub">
                    <button onClick={() => setAlign('left')}>左对齐</button>
                    <button onClick={() => setAlign('center')}>居中</button>
                    <button onClick={() => setAlign('right')}>右对齐</button>
                    <div className="bmenu-sep" />
                    <button onClick={() => setIndent(blockMenu.id, -1)}>减少缩进</button>
                    <button onClick={() => setIndent(blockMenu.id, 1)}>增加缩进</button>
                  </div>
                )}
              </div>
              <div
                className="bmenu-item-wrap"
                onMouseEnter={() => setBmenuSub('color')}
                onMouseLeave={() => setBmenuSub(null)}
              >
                <button className="bmenu-item">
                  <PaletteGlyph />
                  颜色
                  <span className="wt-arrow">›</span>
                </button>
                {bmenuSub === 'color' && (
                  <div className="bmenu-sub bmenu-sub-wide">
                    <div className="sel-pop-label">文字颜色</div>
                    <div className="sel-swatches">
                      {TEXT_COLORS.map((c) => (
                        <button
                          key={c}
                          className="sel-swatch"
                          style={{ background: c }}
                          onClick={() => applyBlockColor(blockMenu.id, 'fore', c)}
                        />
                      ))}
                    </div>
                    <div className="sel-pop-label">高亮</div>
                    <div className="sel-swatches">
                      {HL_COLORS.map((c) => (
                        <button
                          key={c}
                          className="sel-swatch"
                          style={{ background: c }}
                          onClick={() => applyBlockColor(blockMenu.id, 'hl', c)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="bmenu-sep" />
              <button
                className="bmenu-item"
                onClick={() => {
                  duplicateBlock(blockMenu.id)
                  setBlockMenu(null)
                }}
              >
                <CopyGlyph />
                复制段落
              </button>
              <button
                className="bmenu-item"
                onClick={() => {
                  const nid = insertBlockAfter(blockMenu.id, 'p')
                  const { x, y } = blockMenu
                  setBlockMenu(null)
                  if (nid) setInsMenu({ id: nid, x, y })
                }}
              >
                <PlusGlyph />
                在下方添加
              </button>
              <button
                className="bmenu-item bmenu-danger"
                onClick={() => {
                  deleteBlock(blockMenu.id)
                  setBlockMenu(null)
                }}
              >
                <TrashGlyph />
                删除
              </button>
            </div>
          )
        })()}

      {/* 加号插入菜单：给新段落选块类型 */}
      {insMenu && !readOnly && (
        <div
          className="ins-menu"
          style={{
            left: Math.min(Math.max(insMenu.x - 8, 8), window.innerWidth - 300),
            top: Math.min(insMenu.y + 4, window.innerHeight - 200),
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="ins-label">基础</div>
          <div className="ins-chips">
            {CHIP_TYPES.map((t) => (
              <button key={t} className="ins-chip" title={TYPE_LABEL[t]} onClick={() => insPick(t)}>
                <span className="ins-ic">{typeGlyph(t, true)}</span>
                <span>{SHORT_LABEL[t]}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {readOnly && (
        <div className="readonly-banner">
          {lockedByPerm
            ? '你在这份文档上是「只读」权限，段落已锁定；服务端会丢弃你的编辑请求。需要编辑请向所有者申请。'
            : '你正在以只读方式查看此文档，段落已锁定，工具条不可操作。'}
          {!lockedByPerm && <button onClick={() => setManualReadOnly(false)}>恢复编辑</button>}
        </div>
      )}

      <div className="word-body">
        <aside className="word-outline">
          <h4>大纲</h4>
          {outline.length === 0 ? (
            <div className="outline-item empty-item">还没有标题</div>
          ) : (
            outline.map((o) => (
              <button
                key={o.id}
                className={'outline-item ' + o.level}
                onClick={() => scrollToBlock(o.id)}
                title={o.text}
              >
                {o.text}
              </button>
            ))
          )}
          <h4 style={{ marginTop: 16 }}>段落 · {blocks.length}</h4>
        </aside>

        <div className={'word-scroll' + (readOnly ? ' readonly' : '')}>
          <div className="word-page">
          {(() => {
            let olN = 0
            return blocks.map((b, bi) => {
              if (b.type === 'ol') olN++
              else olN = 0
              const peer = peersByBlock.get(b.id)
              const pc = peer ? colorOf(peer.colorIndex) : null
              const dragging = drag?.id === b.id
              // 是否为空行（仅换行符也视为空）：空行显示加号，非空显示 T + 六点
              const hasText = b.delta.some(
                (d) => typeof d.insert === 'string' && d.insert.replace(/\n/g, '').length > 0
              )
              return (
                <div
                  key={b.id}
                  className={'wblock-wrap' + (dragging ? ' dragging' : '')}
                  style={b.indent ? { marginLeft: b.indent * 24 } : undefined}
                >
                  {dropIdx === bi && dropIdx !== null && <div className="drop-line" />}
                  {dropIdx === bi + 1 && dropIdx !== null && <div className="drop-line at-bottom" />}
                  {!readOnly && hasText && (
                    <>
                      {/* T：点击打开段落样式菜单 */}
                      <button
                        className={'wblock-t' + (blockMenu?.id === b.id ? ' show' : '')}
                        title="点击设置段落样式"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                          e.stopPropagation()
                          setInsMenu(null)
                          setBmenuSub(null)
                          setBlockMenu({ id: b.id, x: e.clientX, y: e.clientY })
                        }}
                      >
                        <span className="wt-t">T</span>
                      </button>
                      {/* 六点：按住拖动段落 */}
                      <span
                        className={
                          'wblock-handle' +
                          (drag?.id === b.id || blockMenu?.id === b.id ? ' show' : '')
                        }
                        title="按住拖动段落"
                        onMouseDown={(e) => {
                          if (readOnly || e.button !== 0) return
                          e.preventDefault()
                          setBlockMenu(null)
                          setInsMenu(null)
                          setDrag({ id: b.id, startX: e.clientX, startY: e.clientY })
                        }}
                      >
                        <GripGlyph />
                      </span>
                    </>
                  )}
                  {!readOnly && !hasText && (
                    <button
                      className="wblock-plus"
                      title="在下方新增段落"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => onPlus(b.id, e)}
                    >
                      <PlusGlyph />
                    </button>
                  )}
                  {b.type === 'task' && (
                    <span
                      className={'task-box' + (b.done ? ' done' : '')}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => toggleDone(b.id)}
                    />
                  )}
                  {peer && (
                    <span className="wblock-tag" style={{ background: pc!.ink }}>
                      {peer.name}
                    </span>
                  )}
                  <div
                    className={
                      'wblock wblock-' +
                      b.type +
                      (b.done ? ' task-done' : '') +
                      (peer ? ' has-peer' : '') +
                      (active === b.id ? ' focused' : '')
                    }
                    data-ol={b.type === 'ol' ? String(olN) : undefined}
                    style={{
                      textAlign: b.align,
                      ...(peer ? { borderLeftColor: pc!.ink } : {}),
                    }}
                    contentEditable={!readOnly}
                    suppressContentEditableWarning
                    ref={(el) => {
                      if (el) refs.current.set(b.id, el)
                      else refs.current.delete(b.id)
                    }}
                    onFocus={() => commitFocus(b.id)}
                    onBlur={() => {
                      if (focusRef.current === b.id) {
                        commitFocus(null)
                        const el = refs.current.get(b.id)
                        const yt = getText(b.id)
                        if (el && yt) el.innerHTML = deltaToHtml(yt.toDelta() as DeltaItem[])
                      }
                    }}
                    onInput={() => pushBlock(b.id)}
                    onKeyDown={(e) => onKeyDown(b.id, e)}
                    onKeyUp={() => {
                      if (focusRef.current !== b.id) commitFocus(b.id)
                    }}
                  />
                </div>
              )
            })
          })()}
          </div>
        </div>
      </div>

      {drawer === 'share' && (
        <ShareDrawer
          docId={docId}
          selfName={user.name}
          onClose={() => setDrawer('none')}
          onToast={flash}
        />
      )}
      {drawer === 'history' && (
        <HistoryDrawer
          docId={docId}
          selfName={user.name}
          onlinePeers={peers.length + 1}
          onClose={() => setDrawer('none')}
          onToast={flash}
        />
      )}
      {drawer === 'people' && (
        <div className="drawer-mask" onClick={() => setDrawer('none')}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <h3>协作者 · {peers.length + 1}</h3>
              <button className="btn-ghost" onClick={() => setDrawer('none')}>
                ×
              </button>
            </div>
            <div className="drawer-body">
              <div className="people-row">
                <span
                  className="avatar clickable"
                  style={{ background: colorOf(user.colorIndex).c }}
                  onClick={() => setShowRename(true)}
                >
                  {user.name.slice(0, 1)}
                </span>
                <span className="member-meta">
                  <span className="member-name">
                    {user.name}
                    <span className="member-self-tag">你</span>
                    {user.guest && <span className="guest-tag">访客</span>}
                  </span>
                  <span className="member-sub">
                    正在编辑第 {(blocks.findIndex((b) => b.id === active) + 1) || '—'} 段
                  </span>
                  <button className="member-rename" onClick={() => setShowRename(true)}>
                    修改名字
                  </button>
                </span>
              </div>
              {peers.length === 0 ? (
                <p className="hint">当前只有你在编辑这份文档。把分享链接发给同事即可一起协作。</p>
              ) : (
                peers.map((p) => {
                  const idx = p.block ? blocks.findIndex((b) => b.id === p.block) + 1 : 0
                  const c = colorOf(p.colorIndex)
                  return (
                    <div
                      className="people-row"
                      key={p.id}
                      onClick={() => p.block && scrollToBlock(p.block)}
                      style={{ cursor: p.block ? 'pointer' : 'default' }}
                    >
                      <span className="avatar" style={{ background: c.ink }}>
                        {p.name.slice(0, 1)}
                      </span>
                      <span className="member-meta">
                        <span className="member-name">
                          {p.name}
                          {p.guest && <span className="guest-tag">访客</span>}
                        </span>
                        <span className="member-sub">
                          {idx ? '正在编辑第 ' + idx + ' 段' : '在线查看'}
                        </span>
                      </span>
                    </div>
                  )
                })
              )}
              <p className="hint">点击某人可跳转到他正在编辑的段落。</p>
            </div>
          </aside>
        </div>
      )}

      <ExportModal
        open={exportOpen}
        kind="doc"
        docName={docName}
        peers={peers.length}
        onlineTotal={peers.length + 1}
        onClose={() => setExportOpen(false)}
        onToast={flash}
        onExportDoc={onExportFormat}
      />

      {notice && (
        <div className="notice" key={notice}>
          {notice}
        </div>
      )}

      {showRename && (
        <IdentityDialog
          user={user}
          provider={provider}
          onSave={(n, c) => {
            rename(n, c)
            setShowRename(false)
          }}
          onClose={() => setShowRename(false)}
        />
      )}
    </div>
  )
}

function AlignGlyph({ mode }: { mode: 'left' | 'center' | 'right' }) {
  const bars: [number, number][] =
    mode === 'left'
      ? [[3, 18], [3, 12], [3, 16]]
      : mode === 'center'
      ? [[4, 16], [7, 10], [3, 18]]
      : [[3, 18], [9, 12], [5, 16]]
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      {bars.map(([x, w], i) => (
        <rect key={i} x={x} y={5 + i * 6} width={w} height="2" rx="0.5" />
      ))}
    </svg>
  )
}

function Caret() {
  return (
    <svg className="sel-caret" width="8" height="8" viewBox="0 0 10 10" fill="currentColor" aria-hidden>
      <path d="M1 3 L5 7 L9 3 Z" />
    </svg>
  )
}

function LinkGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <path d="M10 14a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L11 5.93" />
      <path d="M14 10a5 5 0 0 0-7.07 0L4.8 12.12a5 5 0 0 0 7.07 7.07L13 18.07" />
    </svg>
  )
}

function CodeGlyph() {
  return (
    <svg width="16" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 6 L3 12 L8 18" />
      <path d="M16 6 L21 12 L16 18" />
    </svg>
  )
}

function MarkGlyph({ color }: { color: string }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden>
      <path d="M4 15 L11 4 L16 8 L10 17 Z" fill="currentColor" />
      <rect x="4" y="18" width="16" height="3" rx="1" fill={color} />
    </svg>
  )
}

function ListGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="4" cy="6" r="1.6" />
      <rect x="9" y="5" width="12" height="2" rx="0.8" />
      <circle cx="4" cy="12" r="1.6" />
      <rect x="9" y="11" width="12" height="2" rx="0.8" />
      <circle cx="4" cy="18" r="1.6" />
      <rect x="9" y="17" width="12" height="2" rx="0.8" />
    </svg>
  )
}

// ---------- 段落类型图标 ----------
function OlGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <text x="1" y="7.5" fontSize="6.5" fontWeight="700">1</text>
      <text x="1" y="15" fontSize="6.5" fontWeight="700">2</text>
      <text x="1" y="22.5" fontSize="6.5" fontWeight="700">3</text>
      <rect x="9" y="5" width="12" height="2" rx="0.8" />
      <rect x="9" y="11" width="12" height="2" rx="0.8" />
      <rect x="9" y="17" width="12" height="2" rx="0.8" />
    </svg>
  )
}
function TaskGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
      <path d="M8 12.2 L11 15 L16.5 9" />
    </svg>
  )
}
function QuoteGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M4 12c0-4.4 2.4-7.2 6-8l.8 1.9c-2 .8-3.2 2.2-3.4 4.1H10V16H4v-4zm10 0c0-4.4 2.4-7.2 6-8l.8 1.9c-2 .8-3.2 2.2-3.4 4.1H20V16h-6v-4z" />
    </svg>
  )
}
function CalloutGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="3" opacity="0.18" />
      <rect x="6" y="8" width="12" height="2" rx="0.8" />
      <rect x="6" y="13" width="8" height="2" rx="0.8" />
    </svg>
  )
}
function SyncGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
      <rect x="3.5" y="3.5" width="13" height="13" rx="2" />
      <path d="M8 20.5h10a2.5 2.5 0 0 0 2.5-2.5V8" />
    </svg>
  )
}
function GripGlyph() {
  return (
    <svg width="12" height="16" viewBox="0 0 12 18" fill="currentColor" aria-hidden>
      {[3, 9, 15].map((y) =>
        [4, 8].map((x) => <circle key={x + '-' + y} cx={x} cy={y} r="1.5" />)
      )}
    </svg>
  )
}
function PlusGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
      <path d="M6 1.5 V10.5 M1.5 6 H10.5" />
    </svg>
  )
}
function IndentGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="3" y="5" width="18" height="2" rx="0.8" />
      <path d="M9 9h12v2H9zM9 13h8v2H9z" />
      <path d="M4 10.5 L7 13 L4 15.5 Z" />
      <rect x="3" y="19" width="18" height="2" rx="0.8" />
    </svg>
  )
}
function PaletteGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 3a9 9 0 1 0 0 18c1.4 0 2.2-.9 2.2-2 0-.6-.3-1-.6-1.4-.3-.4-.6-.8-.6-1.4 0-1.1.9-2 2-2h2.4A3.6 3.6 0 0 0 21 10.6C20.6 6.3 16.7 3 12 3z" opacity=".85" />
      <circle cx="7.5" cy="11" r="1.4" fill="#fff" />
      <circle cx="11" cy="7.5" r="1.4" fill="#fff" />
      <circle cx="15.5" cy="8.5" r="1.4" fill="#fff" />
    </svg>
  )
}
function CopyGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
      <rect x="8.5" y="8.5" width="12" height="12" rx="2" />
      <path d="M15.5 5.5v-1a2 2 0 0 0-2-2h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h1" />
    </svg>
  )
}
function TrashGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M4 7h16 M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2 M6.5 7l1 13h9l1-13 M10 11v5 M14 11v5" />
    </svg>
  )
}

/** 段落类型图标（下拉 / chips 共用；chip 模式下 H 用紧凑文本） */
function typeGlyph(t: BlockType, chip = false): React.ReactNode {
  if (t === 'p') return <span className="wt-t">T</span>
  if (/^h[1-9]$/.test(t)) return <span className="wt-h">{t.toUpperCase()}</span>
  switch (t) {
    case 'ol': return <OlGlyph />
    case 'li': return <ListGlyph />
    case 'task': return <TaskGlyph />
    case 'code': return <span className="wt-brace">{'{ }'}</span>
    case 'quote': return <QuoteGlyph />
    case 'callout': return <CalloutGlyph />
    case 'sync': return <SyncGlyph />
    default: return null
  }
}
