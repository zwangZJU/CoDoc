import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import type { CellData, MergeInfo } from '../sheets/useSheet'

const WS_BASE =
  (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/collab'

/**
 * 临时连一次协同房间，读取完整内容后立刻断开。
 * 用于工作台这类"不常驻编辑器但要读内容"的场景（导出 / 缩略图）。
 */
export async function withDoc<T>(
  docId: string,
  fn: (ydoc: Y.Doc) => T,
  timeoutMs = 4000
): Promise<T> {
  const ydoc = new Y.Doc()
  const provider = new WebsocketProvider(WS_BASE, docId, ydoc, { connect: true })
  try {
    await new Promise<void>((resolve) => {
      if (provider.synced) return resolve()
      const done = () => {
        provider.off('sync', onSync)
        resolve()
      }
      const onSync = (s: boolean) => s && done()
      provider.on('sync', onSync)
      window.setTimeout(() => {
        provider.off('sync', onSync)
        resolve()
      }, timeoutMs)
    })
    // 再等一帧，确保从服务端收到的 update 已 apply
    await new Promise((r) => window.setTimeout(r, 60))
    return fn(ydoc)
  } finally {
    provider.destroy()
    ydoc.destroy()
  }
}

export interface SheetSnapshot {
  name: string
  rows: CellData[][]
  merges: MergeInfo[]
  colw: Record<number, number>
  rowh: Record<number, number>
}

/** 读取全部工作表（含单元格样式 / 合并 / 列宽行高） */
export function readSheets(ydoc: Y.Doc): SheetSnapshot[] {
  const map = ydoc.getMap<any>('sheets')
  const mergesRoot = ydoc.getMap<any>('merges')
  const colwRoot = ydoc.getMap<any>('colw')
  const rowhRoot = ydoc.getMap<any>('rowh')
  const out: SheetSnapshot[] = []
  map.forEach((arr: Y.Array<Y.Array<any>>, name: string) => {
    const rows: CellData[][] = []
    arr.forEach((row) => {
      const r: CellData[] = []
      row.forEach((c: any) => {
        if (c && typeof c === 'object' && 'v' in c) r.push(c as CellData)
        else r.push({ v: c == null ? '' : String(c) })
      })
      rows.push(r)
    })

    const merges: MergeInfo[] = []
    mergesRoot.get(name)?.forEach((v: MergeInfo) => merges.push(v))

    const colw: Record<number, number> = {}
    colwRoot.get(name)?.forEach((v: number, k: string) => {
      colw[Number(k)] = v
    })

    const rowh: Record<number, number> = {}
    rowhRoot.get(name)?.forEach((v: number, k: string) => {
      rowh[Number(k)] = v
    })

    out.push({ name, rows, merges, colw, rowh })
  })
  return out
}

export interface BlockSnapshot {
  id: string
  type:
    | 'p'
    | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'h7' | 'h8' | 'h9'
    | 'ol' | 'li' | 'task'
    | 'code' | 'quote' | 'callout' | 'sync'
  text: string
}

/** 读取全部段落 */
export function readBlocks(ydoc: Y.Doc): BlockSnapshot[] {
  const arr = ydoc.getArray<any>('blocks')
  const out: BlockSnapshot[] = []
  arr.forEach((m) => {
    const t = m?.get('text')
    out.push({
      id: String(m?.get('id') || ''),
      type: (m?.get('type') || 'p') as BlockSnapshot['type'],
      text: t?.toString?.() || '',
    })
  })
  return out
}
