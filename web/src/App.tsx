import { useCallback, useEffect, useState } from 'react'
import Workspace from './pages/Workspace'
import Editor from './pages/Editor'
import WordEditor from './pages/WordEditor'
import { Login } from './pages/Login'
import { AccessWaiting, GuestGate } from './components/GuestGate'
import TeamAdmin from './pages/TeamAdmin'
import { api, type DocMeta } from './store/api'
import { clearSession, setSession, type LocalUser } from './store/user'
import type { ImportPayload } from './store/importPayload'

type Route =
  | { page: 'workspace' }
  | { page: 'loading'; docId: string }
  /** 未登录：先登录再决定能看什么 */
  | { page: 'login'; docId?: string; docName?: string }
  /** 无权限：以当前账号提交访问申请 */
  | {
      page: 'gate'
      docId: string
      name: string
      kind: 'sheet' | 'doc'
      ownerName: string
      needApproval: boolean
    }
  /** 已提交申请，轮询等待批准 */
  | {
      page: 'waiting'
      docId: string
      name: string
      kind: 'sheet' | 'doc'
      ownerName: string
      rejected: boolean
    }
  | { page: 'editor'; docId: string; name: string; shared: boolean }
  | { page: 'word'; docId: string; name: string; shared: boolean }
  | { page: 'notfound'; docId: string }

function readDocParam(): string | null {
  const p = new URLSearchParams(location.search).get('doc')
  return p && p.trim() ? p.trim() : null
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => {
    const id = readDocParam()
    return id ? { page: 'loading', docId: id } : { page: 'workspace' }
  })
  /** 新建并导入时，先把解析好的内容交给编辑器，由它在同步完成后写入 Yjs */
  const [pendingImport, setPendingImport] = useState<ImportPayload | null>(null)
  /** 当前登录账号；身份由后端会话下发，前端不保存任何凭证 */
  const [me, setMe] = useState<LocalUser | null>(null)
  /** 登录态是否已确认：确认前不渲染业务页面，避免闪一下工作台又跳登录 */
  const [booted, setBooted] = useState(false)
  /** 当前查看的团队空间（非空表示进入某团队的团队空间视图） */
  const [teamView, setTeamView] = useState<{ id: string; name: string } | null>(null)
  /** 是否打开团队管理（管理员页面） */
  const [adminView, setAdminView] = useState(false)

  const refreshMe = useCallback(async () => {
    try {
      const r = await api.me()
      setMe(setSession(r.user))
      return true
    } catch {
      setMe(null)
      clearSession()
      return false
    }
  }, [])

  useEffect(() => {
    let alive = true
    refreshMe().finally(() => {
      if (alive) setBooted(true)
    })
    return () => {
      alive = false
    }
  }, [refreshMe])

  /**
   * 通过 ?doc= 进入时的分流。
   * 顺序很重要：先看登录没登录，再问"我有没有权限"，
   * 最后决定是直达编辑器、提交申请、还是等待批准。
   * 没有权限的人看到的是申请页，不是白屏或报错。
   */
  useEffect(() => {
    if (!booted) return
    if (route.page !== 'loading') return
    let alive = true
    const id = route.docId
    const enter = (d: DocMeta) =>
      setRoute(
        d.kind === 'doc'
          ? { page: 'word', docId: d.id, name: d.name, shared: true }
          : { page: 'editor', docId: d.id, name: d.name, shared: true }
      )
    ;(async () => {
      try {
        const d = await api.getDoc(id)
        if (!alive) return
        // 未登录：先去登录，登录后回到这里继续分流
        if (!me) {
          setRoute({ page: 'login', docId: id, docName: d.name })
          return
        }
        const access = await api.getMyAccess(id)
        if (!alive) return
        if (access.level && access.level !== 'none') {
          enter({ ...d, kind: access.kind, name: access.name })
          return
        }
        if (access.status === 'pending') {
          setRoute({
            page: 'waiting',
            docId: id,
            name: access.name,
            kind: access.kind,
            ownerName: access.ownerName,
            rejected: false,
          })
          return
        }
        setRoute({
          page: 'gate',
          docId: id,
          name: access.name,
          kind: access.kind,
          ownerName: access.ownerName,
          // 仅协作者可访问 → 必须申请；开放链接 → 登记后直接进
          needApproval: !access.linkOpen || access.status === 'rejected',
        })
      } catch (e) {
        if (!alive) return
        setRoute({ page: 'notfound', docId: id })
        console.warn('[CoDoc] 打开分享链接失败：', e instanceof Error ? e.message : e)
      }
    })()
    return () => {
      alive = false
    }
  }, [route, booted, me])

  /** 新建 / 打开文档（工作台入口） */
  const open = (docId: string, name: string, kind: 'sheet' | 'doc', payload?: ImportPayload | null) => {
    setPendingImport(payload || null)
    history.replaceState(null, '', '?doc=' + encodeURIComponent(docId))
    setRoute(
      kind === 'doc'
        ? { page: 'word', docId, name, shared: false }
        : { page: 'editor', docId, name, shared: false }
    )
  }

  /** 编辑器内改名后，同步 App 路由里的标题（返回工作台 / 再次分享时用新名） */
  const applyDocRename = (next: string) => {
    setRoute((r) => (r.page === 'editor' || r.page === 'word' ? { ...r, name: next } : r))
  }

  const back = useCallback(() => {
    setPendingImport(null)
    setTeamView(null)
    setAdminView(false)
    history.replaceState(null, '', location.pathname)
    setRoute({ page: 'workspace' })
  }, [])

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined)
    clearSession()
    setMe(null)
    history.replaceState(null, '', location.pathname)
    setRoute({ page: 'workspace' })
  }, [])

  /** 已登记并获授权 → 直接进入文档 */
  const onGranted = () => {
    setRoute((r) => {
      if (r.page !== 'gate' && r.page !== 'waiting') return r
      return r.kind === 'doc'
        ? { page: 'word', docId: r.docId, name: r.name, shared: true }
        : { page: 'editor', docId: r.docId, name: r.name, shared: true }
    })
  }

  /** 已提交申请，转入等待批准页 */
  const onPending = () => {
    setRoute((r) =>
      r.page === 'gate'
        ? {
            page: 'waiting',
            docId: r.docId,
            name: r.name,
            kind: r.kind,
            ownerName: r.ownerName,
            rejected: false,
          }
        : r
    )
  }

  /** 登录成功：确认身份后，从分享链接进来的人继续走分流 */
  const onLoggedIn = async () => {
    const ok = await refreshMe()
    if (!ok) return
    setRoute((r) =>
      r.page === 'login' && r.docId
        ? { page: 'loading', docId: r.docId }
        : { page: 'workspace' }
    )
  }

  // 登录态未确认：loading 占位
  if (!booted) {
    return (
      <div className="guest-mask">
        <div className="guest-card">
          <div className="guest-badge">CoDoc 同写</div>
          <h2 className="guest-title">正在确认登录状态…</h2>
          <p className="guest-sub">请稍候。</p>
        </div>
      </div>
    )
  }

  // 未登录：登录页（从分享链接进来时带上文档名，告诉用户要去哪）
  if (!me) {
    return (
      <Login
        docName={route.page === 'login' ? route.docName : undefined}
        onLoggedIn={onLoggedIn}
      />
    )
  }

  // 拉取文档元数据期间：loading 占位
  if (route.page === 'loading') {
    return (
      <div className="guest-mask">
        <div className="guest-card">
          <div className="guest-badge">正在打开</div>
          <h2 className="guest-title">正在连接文档…</h2>
          <p className="guest-sub">正在确认你的访问权限，请稍候。</p>
        </div>
      </div>
    )
  }

  if (route.page === 'gate') {
    return (
      <GuestGate
        docName={route.name}
        docId={route.docId}
        ownerName={route.ownerName}
        needApproval={route.needApproval}
        me={me}
        onGranted={onGranted}
        onPending={onPending}
        onBack={back}
      />
    )
  }

  if (route.page === 'waiting') {
    return (
      <AccessWaiting
        docName={route.name}
        docId={route.docId}
        ownerName={route.ownerName}
        rejected={route.rejected}
        onGranted={onGranted}
        onBack={back}
      />
    )
  }

  // 编辑器 / 文档编辑器（最高业务优先级：正在协同编辑）
  if (route.page === 'word') {
    return (
      <WordEditor
        docId={route.docId}
        name={route.name}
        identity={me}
        importPayload={pendingImport}
        onImported={() => setPendingImport(null)}
        onBack={back}
        onDocRenamed={applyDocRename}
      />
    )
  }
  if (route.page === 'editor') {
    return (
      <Editor
        docId={route.docId}
        name={route.name}
        identity={me}
        importPayload={pendingImport}
        onImported={() => setPendingImport(null)}
        onBack={back}
        onDocRenamed={applyDocRename}
      />
    )
  }
  if (route.page === 'notfound') {
    return (
      <div className="guest-mask">
        <div className="guest-card">
          <div className="guest-badge">链接失效</div>
          <h2 className="guest-title">这份文档打不开了</h2>
          <p className="guest-sub">链接对应的文档不存在，或已被创建者删除。请向分享者确认最新链接。</p>
          <div className="modal-actions">
            <button className="btn-primary" onClick={back}>
              返回工作台
            </button>
          </div>
        </div>
      </div>
    )
  }

  // 团队管理（管理员页面）
  if (adminView) {
    return (
      <TeamAdmin
        onClose={() => setAdminView(false)}
        onOpenTeam={(t) => {
          setAdminView(false)
          setTeamView(t)
        }}
      />
    )
  }

  // 团队空间（指定团队的文件视图）
  if (teamView) {
    return (
      <Workspace
        teamId={teamView.id}
        teamName={teamView.name}
        me={me}
        onExitTeam={() => setTeamView(null)}
        onManageTeam={() => {
          setTeamView(null)
          setAdminView(true)
        }}
        onOpenTeam={(t) => setTeamView(t)}
        onOpen={open}
        onLogout={logout}
      />
    )
  }

  return <Workspace me={me} onOpenTeam={(t) => setTeamView(t)} onOpen={open} onLogout={logout} />
}
