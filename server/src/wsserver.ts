/**
 * CoDoc 协同房间服务核心。
 * 自行实现 y-websocket 协议（messageSync / messageAwareness），
 * 与前端 `y-websocket` 的 WebsocketProvider 客户端完全兼容。
 *
 * 依赖：yjs / y-protocols / lib0 / ws
 * 参考：y-websocket 官方 bin/utils.js（精简移植，确定性更高）
 */
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const messageSync = 0
const messageAwareness = 1

const PERSIST_DIR = path.resolve(__dirname, '../data')

// open: 已连接可收发；connecting/closed 视为不可用
const wsReadyStateOpen = 1

const docs = new Map<string, WSSharedDoc>()
const saveTimers = new Map<string, NodeJS.Timeout>()

/**
 * 同用户去重：同一 user.id 只保留最新写入的一份 awareness（按 clock 比较），
 * 其余旧的（通常来自刷新前的旧连接 / 多标签页残留）立即移除。
 * 这样在线名单里永远只有一个同名协作者。
 */
const sweepDuplicates = (doc: WSSharedDoc) => {
  if (doc.conns.size < 2) return
  const newest = new Map<string, number>() // user.id -> clientId（保留者）
  const clocks = new Map<string, number>() // user.id -> clock
  doc.awareness.getStates().forEach((st: any, cid: number) => {
    const uid = st?.user?.id
    const clock = st?.clock ?? 0
    if (!uid) return
    const prevClock = clocks.get(uid)
    if (prevClock === undefined || clock >= prevClock) {
      clocks.set(uid, clock)
      newest.set(uid, cid)
    }
  })
  const stale: number[] = []
  doc.awareness.getStates().forEach((st: any, cid: number) => {
    const uid = st?.user?.id
    if (!uid) return
    if (newest.get(uid) !== cid) stale.push(cid)
  })
  if (stale.length > 0) {
    awarenessProtocol.removeAwarenessStates(doc.awareness, stale, null)
  }
}

export class WSSharedDoc extends Y.Doc {
  name: string
  awareness: awarenessProtocol.Awareness
  conns: Map<any, Set<number>>

  constructor(name: string) {
    super({ gc: true })
    this.name = name
    this.conns = new Map()
    this.awareness = new awarenessProtocol.Awareness(this)
    this.awareness.setLocalState(null)

    this.awareness.on(
      'update',
      ({ added, updated, removed }: any, conn: any) => {
        // 登记/同步该连接控制的 clientId 集合：连接断开时据此移除对应的
        // awareness 状态，否则刷新/断线后旧用户在在线名单里永远残留（越刷越多）。
        if (conn !== null && added.length > 0) {
          const set = this.conns.get(conn)
          if (set) added.forEach((cid: number) => set.add(cid))
        }
        const changedClients = added.concat(updated, removed)
        if (conn !== null) {
          const encoder = encoding.createEncoder()
          encoding.writeVarUint(encoder, messageAwareness)
          encoding.writeVarUint8Array(
            encoder,
            awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients)
          )
          const buff = encoding.toUint8Array(encoder)
          this.conns.forEach((_, c) => send(this, c, buff))
        }
        // 同用户去重：任何 awareness 变化（尤其新连接身份晚到）后都收敛一次，
        // 同一 user.id 只保留最新写入的那一份，在线名单不会出现同名重复。
        sweepDuplicates(this)
      }
    )

    this.on('update', (update: Uint8Array, _origin: any, _doc: Y.Doc) => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageSync)
      syncProtocol.writeUpdate(encoder, update)
      const buff = encoding.toUint8Array(encoder)
      this.conns.forEach((_, c) => send(this, c, buff))
      scheduleSave(this)
    })
  }
}

const getYDoc = (docName: string): WSSharedDoc => {
  let doc = docs.get(docName)
  if (!doc) {
    doc = new WSSharedDoc(docName)
    docs.set(docName, doc)
    loadDoc(doc)
  }
  return doc
}

const loadDoc = (doc: WSSharedDoc) => {
  try {
    const file = path.join(PERSIST_DIR, doc.name + '.bin')
    if (fs.existsSync(file)) {
      const data = fs.readFileSync(file)
      Y.applyUpdate(doc, new Uint8Array(data))
    }
  } catch (e) {
    console.error('[load] failed', doc.name, e)
  }
}

const scheduleSave = (doc: WSSharedDoc) => {
  const existing = saveTimers.get(doc.name)
  if (existing) clearTimeout(existing)
  const t = setTimeout(() => {
    try {
      fs.mkdirSync(PERSIST_DIR, { recursive: true })
      const data = Y.encodeStateAsUpdate(doc)
      fs.writeFileSync(path.join(PERSIST_DIR, doc.name + '.bin'), data)
    } catch (e) {
      console.error('[save] failed', doc.name, e)
    }
    saveTimers.delete(doc.name)
  }, 2000)
  saveTimers.set(doc.name, t)
}

const send = (doc: WSSharedDoc, conn: any, m: Uint8Array) => {
  if (conn.readyState !== wsReadyStateOpen) {
    closeConn(doc, conn)
    return
  }
  try {
    conn.send(m, (err: any) => err != null && closeConn(doc, conn))
  } catch (e) {
    closeConn(doc, conn)
  }
}

const closeConn = (doc: WSSharedDoc, conn: any) => {
  if (doc.conns.has(conn)) {
    const controlledIds = doc.conns.get(conn)!
    doc.conns.delete(conn)
    awarenessProtocol.removeAwarenessStates(
      doc.awareness,
      Array.from(controlledIds),
      null
    )
  }
  try {
    conn.close()
  } catch (e) {
    /* ignore */
  }
}

const messageListener = (conn: any, doc: WSSharedDoc, message: Uint8Array) => {
  try {
    const encoder = encoding.createEncoder()
    const decoder = decoding.createDecoder(message)
    const messageType = decoding.readVarUint(decoder)
    switch (messageType) {
      case messageSync:
        encoding.writeVarUint(encoder, messageSync)
        syncProtocol.readSyncMessage(decoder, encoder, doc, conn)
        if (encoding.length(encoder) > 1) {
          send(doc, conn, encoding.toUint8Array(encoder))
        }
        break
      case messageAwareness:
        awarenessProtocol.applyAwarenessUpdate(
          doc.awareness,
          decoding.readVarUint8Array(decoder),
          conn
        )
        break
    }
  } catch (err) {
    console.error('[message] error', err)
  }
}

export const setupWSConnection = (conn: any, docName: string) => {
  conn.binaryType = 'arraybuffer'
  const doc = getYDoc(docName)
  doc.conns.set(conn, new Set())

  conn.on('message', (message: ArrayBuffer) =>
    messageListener(conn, doc, new Uint8Array(message))
  )

  // 心跳保活
  let pongReceived = true
  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      if (doc.conns.has(conn)) closeConn(doc, conn)
      clearInterval(pingInterval)
      return
    }
    if (doc.conns.has(conn)) {
      pongReceived = false
      try {
        conn.ping()
      } catch (e) {
        closeConn(doc, conn)
        clearInterval(pingInterval)
      }
    }
  }, 30000)
  conn.on('pong', () => {
    pongReceived = true
  })
  conn.on('close', () => {
    closeConn(doc, conn)
    clearInterval(pingInterval)
  })

  // 新连接刚进来，马上收敛一次同用户重复状态（去重逻辑见文件顶部 sweepDuplicates）
  sweepDuplicates(doc)

  // 1) 发送 sync step 1（含服务端 state vector）
  {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageSync)
    syncProtocol.writeSyncStep1(encoder, doc)
    send(doc, conn, encoding.toUint8Array(encoder))
  }
  // 2) 同步当前已存在的 awareness
  const states = doc.awareness.getStates()
  if (states.size > 0) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageAwareness)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(doc.awareness, Array.from(states.keys()))
    )
    send(doc, conn, encoding.toUint8Array(encoder))
  }
}

export const getDocNames = (): string[] => Array.from(docs.keys())

export interface LiveRoom {
  /** WebSocket 连接数（≈ 在线客户端数） */
  conns: number
  /** awareness 中已声明身份的用户名去重列表 */
  users: string[]
  /** 正在编辑的位置描述（表格单元格 / 文档段落），取前 5 个 */
  editing: string[]
}

/** 供 HTTP 查询的实时在线信息：哪些房间有人、都是谁 */
export const getLiveRooms = (): Record<string, LiveRoom> => {
  const out: Record<string, LiveRoom> = {}
  docs.forEach((doc, name) => {
    const users: string[] = []
    const editing: string[] = []
    doc.awareness.getStates().forEach((st: any) => {
      const u = st?.user
      if (!u?.name) return
      if (!users.includes(u.name)) users.push(u.name)
      if (st?.editing) editing.push('正在编辑单元格')
      else if (st?.wblock) editing.push('正在编辑段落')
    })
    out[name] = { conns: doc.conns.size, users, editing: editing.slice(0, 5) }
  })
  return out
}

/* ============================================================================
 * 历史版本（快照 + 恢复）
 * 快照文件：data/versions/<docName>-<vid>.bin
 * 索引文件：data/versions/<docName>.json  { versions: [...] }
 * ========================================================================== */
export interface DocVersion {
  id: string
  /** unix 毫秒时间戳 */
  ts: number
  /** 是否自动快照（false=手动命名） */
  auto: boolean
  /** 手动命名（可选） */
  label?: string
  /** 快照时的在线人数（仅供参考展示） */
  peers: number
  /** 触发者：手动保存时为保存者姓名，自动快照为「系统」 */
  author?: string
}

const versionsDir = (docName: string) => path.join(PERSIST_DIR, 'versions')

const versionsInfoFile = (docName: string) =>
  path.join(PERSIST_DIR, 'versions', docName + '.json')

function readVersions(docName: string): DocVersion[] {
  try {
    const file = versionsInfoFile(docName)
    if (!fs.existsSync(file)) return []
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return Array.isArray(raw?.versions) ? raw.versions : []
  } catch {
    return []
  }
}

export function getVersions(docName: string): DocVersion[] {
  return readVersions(docName).sort((a, b) => b.ts - a.ts)
}

function writeVersions(docName: string, versions: DocVersion[]) {
  fs.mkdirSync(versionsDir(docName), { recursive: true })
  fs.writeFileSync(
    versionsInfoFile(docName),
    JSON.stringify({ versions }, null, 2)
  )
}

/** 保存一个快照（自动 or 手动），返回新版本 id */
export function saveVersion(
  docName: string,
  label?: string,
  author?: string
): DocVersion | null {
  try {
    const doc = docs.get(docName)
    if (!doc) return null
    const versions = readVersions(docName)
    const v: DocVersion = {
      id: Math.random().toString(36).slice(2, 10),
      ts: Date.now(),
      auto: !label,
      ...(label ? { label } : {}),
      peers: doc.conns.size,
      author: label ? author || '匿名' : '系统快照',
    }
    fs.mkdirSync(versionsDir(docName), { recursive: true })
    const data = Y.encodeStateAsUpdate(doc)
    fs.writeFileSync(path.join(versionsDir(docName), docName + '-' + v.id + '.bin'), data)
    versions.push(v)
    writeVersions(docName, versions)
    return v
  } catch (e) {
    console.error('[version] save failed', docName, e)
    return null
  }
}

/** 给已存在的版本命名（或改名） */
export function renameVersion(docName: string, vid: string, label: string): boolean {
  try {
    const versions = readVersions(docName)
    const v = versions.find((x) => x.id === vid)
    if (!v) return false
    v.label = label || undefined
    v.auto = !label
    writeVersions(docName, versions)
    return true
  } catch (e) {
    console.error('[version] rename failed', docName, vid, e)
    return false
  }
}

/** 从调用保存快照的自动去重：与上一个快照间隔 < 60s 不再新增 */
export function autoSaveVersionIfStale(docName: string) {
  try {
    const versions = readVersions(docName)
    const last = versions.length ? versions[versions.length - 1] : null
    if (!last || Date.now() - last.ts > 60_000) {
      saveVersion(docName)
    }
  } catch (e) {
    /* ignore */
  }
}

/**
 * 从快照内容重建到线上 doc。
 * 注意：不能用 Y.applyUpdate(doc, snapshot) 直接重放——快照里的 item 与当前 doc
 * 属于同一批 clientID 且已被删除，重放会被 Yjs 判为"已存在"而静默丢弃。
 * 正确做法是读出快照内容，用当前 doc 产生**新**的插入操作（新 clientID）。
 */
function rebuildFromSnapshot(doc: WSSharedDoc, tmp: Y.Doc): boolean {
  const srcBlocks = tmp.getArray<any>('blocks')
  const srcSheets = tmp.getMap<any>('sheets')

  if (srcBlocks.length > 0) {
    const target = doc.getArray<any>('blocks')
    const items = srcBlocks.toArray().map((m: any) => {
      const nm = new Y.Map<any>()
      nm.set('id', Math.random().toString(36).slice(2, 10))
      nm.set('type', m.get('type') || 'p')
      const align = m.get('align')
      if (align) nm.set('align', align)
      const t = new Y.Text()
      const src = m.get('text')
      const txt = src ? src.toString() : ''
      if (txt) t.insert(0, txt)
      nm.set('text', t)
      return nm
    })
    target.push(items)
    doc.getMap<any>('wmeta').set('init', true)
    return true
  }

  if (srcSheets.size > 0) {
    const target = doc.getMap<any>('sheets')
    const merges = doc.getMap<any>('merges')
    const colw = doc.getMap<any>('colw')
    const rowh = doc.getMap<any>('rowh')

    srcSheets.forEach((arr: Y.Array<Y.Array<any>>, name: string) => {
      const na = new Y.Array<Y.Array<any>>()
      arr.forEach((row: Y.Array<any>) => {
        const nr = new Y.Array<any>()
        nr.insert(
          0,
          row.toArray().map((c: any) =>
            c == null ? { v: '' } : typeof c === 'string' ? { v: c } : { ...c }
          )
        )
        na.push([nr])
      })
      target.set(name, na)
      if (!merges.has(name)) merges.set(name, new Y.Map())
      if (!colw.has(name)) colw.set(name, new Y.Map())
      if (!rowh.has(name)) rowh.set(name, new Y.Map())
    })

    /** 复制"按工作表分组的 Y.Map"里的普通键值 */
    const copyGrouped = (srcKey: string, dst: Y.Map<any>) => {
      const src = tmp.getMap<any>(srcKey)
      src.forEach((v: any, k: string) => {
        const n = new Y.Map<any>()
        // 同样不用 instanceof：能 forEach + set 的就是 Y.Map
        if (v && typeof v.forEach === 'function' && typeof v.set === 'function') {
          v.forEach((vv: any, kk: string) => n.set(kk, vv))
        }
        dst.set(k, n)
      })
    }
    copyGrouped('merges', merges)
    copyGrouped('colw', colw)
    copyGrouped('rowh', rowh)
    return true
  }

  return false
}

/** 恢复某版本：清空当前内容后按快照重建 */
export function restoreVersion(docName: string, vid: string): boolean {
  try {
    const doc = docs.get(docName)
    if (!doc) return false
    const versions = readVersions(docName)
    const v = versions.find((x) => x.id === vid)
    if (!v) return false
    const file = path.join(versionsDir(docName), docName + '-' + vid + '.bin')
    if (!fs.existsSync(file)) return false
    const snap = new Uint8Array(fs.readFileSync(file))

    // 1) 快照读进临时 doc
    const tmp = new Y.Doc()
    Y.applyUpdate(tmp, snap)

    doc.transact(() => {
      // 2) 清空当前 doc 已知顶层类型（本应用全部类型均为顶层 Map / Array）
      //    注意：这里必须用 getMap / getArray 显式指定类型，doc.get(key) 不带
      //    构造函数会拿到 AbstractType 占位，instanceof 判断也会失效。
      for (const key of TOP_MAP_KEYS) doc.getMap<any>(key).clear()
      for (const key of TOP_ARRAY_KEYS) {
        const arr = doc.getArray<any>(key)
        arr.delete(0, arr.length)
      }
      // 3) 用新操作重建内容 → 触发 update 广播给所有客户端
      rebuildFromSnapshot(doc, tmp)
    })
    scheduleSave(doc)
    return true
  } catch (e) {
    console.error('[version] restore failed', docName, vid, e)
    return false
  }
}

/**
 * 读取某个快照的内容摘要（用于抽屉内预览）。
 * 表格返回前若干行的单元格拼接，文档返回前若干段落文本。
 */
export function readVersionPreview(
  docName: string,
  vid: string
): { kind: 'doc' | 'sheet' | 'empty'; lines: string[]; sheetName?: string } {
  const file = path.join(versionsDir(docName), docName + '-' + vid + '.bin')
  if (!fs.existsSync(file)) return { kind: 'empty', lines: [] }
  try {
    const snap = new Uint8Array(fs.readFileSync(file))
    const doc = new Y.Doc()
    Y.applyUpdate(doc, snap)

    const blocks = doc.getArray<any>('blocks')
    if (blocks.length > 0) {
      const lines: string[] = []
      blocks.forEach((m: any) => {
        if (lines.length >= 8) return
        const t = m?.get('text')
        const s = t?.toString?.() || ''
        if (s.trim()) lines.push(s)
      })
      return { kind: 'doc', lines }
    }

    const sheets = doc.getMap<any>('sheets')
    const name = Array.from(sheets.keys())[0] as string | undefined
    if (!name) return { kind: 'empty', lines: [] }
    const arr = sheets.get(name) as Y.Array<Y.Array<any>>
    const lines: string[] = []
    for (let r = 0; r < Math.min(8, arr.length); r++) {
      const row = arr.get(r)
      const cells: string[] = []
      row.forEach((c: any) => cells.push(typeof c === 'string' ? c : String(c?.v ?? '')))
      if (cells.some((c) => c.trim())) lines.push(cells.join(' | '))
    }
    return { kind: 'sheet', lines, sheetName: name }
  } catch (e) {
    console.error('[version] preview failed', docName, vid, e)
    return { kind: 'empty', lines: [] }
  }
}

/** 本应用顶层共享类型的固定 key 集合（按容器类型分组） */
const TOP_MAP_KEYS = ['sheets', 'merges', 'colw', 'rowh', 'wmeta', 'docMeta']
const TOP_ARRAY_KEYS = ['blocks']
