import { useEffect, useState } from 'react'
import {
  api,
  type LinkPerm,
  type Perm3,
  type ShareInfo,
  type ShareScope,
} from '../store/api'
import { colorOf } from '../store/user'

const PERM_LABEL: Record<Perm3, string> = {
  manage: '可管理',
  edit: '可编辑',
  view: '只读',
}
const PERM_HINT: Record<Perm3, string> = {
  manage: '可改内容、改权限、邀请或移除成员',
  edit: '可修改内容，不能改权限设置',
  view: '只能查看，编辑操作会被服务端拒绝',
}
const SCOPE_LABEL: Record<ShareScope, string> = {
  off: '仅协作者',
  org: '组织内',
  any: '任何人',
}
const SCOPE_HINT: Record<ShareScope, string> = {
  off: '只有下方成员能打开；其他人打开链接需要向你申请。',
  org: '同一组织内的成员凭链接即可打开，无需逐个邀请。',
  any: '任何拿到链接的人都能打开，请谨慎使用。',
}
const VIA_LABEL: Record<string, string> = {
  owner: '所有者',
  invite: '已邀请',
  link: '凭链接进入',
  request: '申请获批',
}

const PERMS: Perm3[] = ['view', 'edit', 'manage']

/**
 * 分享与权限抽屉。
 *
 * 布局顺序照飞书的逻辑：**先回答"现在谁能看" → 再加人/发链接 → 再处理"想加但加不了"
 * 的求助路径 → 最后是精细开关**。常用动作在前，危险动作在后。
 * 所有权限都落后端并由服务端强制执行，这里只是入口。
 */
export default function ShareDrawer({
  docId,
  selfName,
  onClose,
  onToast,
}: {
  docId: string
  selfName: string
  onClose: () => void
  onToast: (m: string) => void
}) {
  const [info, setInfo] = useState<ShareInfo | null>(null)
  const [inviteName, setInviteName] = useState('')
  const [invitePerm, setInvitePerm] = useState<Perm3>('view')
  const [busy, setBusy] = useState(false)

  const load = () =>
    api
      .getShare(docId)
      .then(setInfo)
      .catch((e) => onToast('读取分享信息失败：' + (e?.message || e)))

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId])

  const setScope = async (scope: ShareScope) => {
    if (!info) return
    try {
      await api.updateShare(docId, { scope })
      await load()
      onToast(
        scope === 'off'
          ? '已关闭链接分享，凭链接进入的人已立即失去访问权'
          : '链接范围已改为「' + SCOPE_LABEL[scope] + '」'
      )
    } catch (e) {
      onToast('修改失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const setLinkPerm = async (linkPerm: LinkPerm) => {
    try {
      await api.updateShare(docId, { linkPerm })
      await load()
      onToast('凭链接进入的人现在「' + PERM_LABEL[linkPerm] + '」')
    } catch (e) {
      onToast('修改失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const setPerm = async (id: string, perm: Perm3, name: string) => {
    try {
      await api.setMemberPerm(docId, id, perm)
      await load()
      onToast(`${name} 的权限已设为「${PERM_LABEL[perm]}」`)
    } catch (e) {
      onToast('修改权限失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const invite = async () => {
    const name = inviteName.trim()
    if (!name) {
      onToast('请先填写姓名')
      return
    }
    setBusy(true)
    try {
      await api.invite(docId, name, invitePerm)
      setInviteName('')
      await load()
      onToast(`已添加 ${name}（${PERM_LABEL[invitePerm]}）`)
    } catch (e) {
      onToast('添加失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  const removeMember = async (id: string, name: string) => {
    try {
      const r = await api.removeMember(docId, id)
      await load()
      onToast(
        r.linkStillOpen
          ? `已移除 ${name}，但链接仍对外开放，对方还能凭链接再次进入`
          : `已移除 ${name}，其连接已断开`
      )
    } catch (e) {
      onToast('移除失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const resolveRequest = async (id: string, approve: boolean, name: string) => {
    try {
      await api.resolveRequest(docId, id, approve, 'edit')
      await load()
      onToast(approve ? `已批准 ${name} 的访问申请` : `已拒绝 ${name} 的申请`)
    } catch (e) {
      onToast('操作失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const copyLink = async () => {
    if (!info) return
    try {
      await navigator.clipboard.writeText(info.link)
      onToast('链接已复制')
    } catch {
      onToast('复制失败，请手动选择输入框内的链接')
    }
  }

  return (
    <div className="drawer-mask" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>分享与权限</h3>
          <button className="btn-ghost" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        {!info ? (
          <div className="drawer-body">
            <p className="hint">正在读取分享信息…</p>
          </div>
        ) : (
          <div className="drawer-body">
            {!info.canManage && (
              <div className="notice-bar">
                你在这份文档上是「{PERM_LABEL[(info.myLevel === 'owner' ? 'manage' : info.myLevel) as Perm3] || '只读'}
                」，不能改动分享设置。
              </div>
            )}

            {/* ---- 待处理的访问申请：所有者一进来就能看到，不用去别处找 ---- */}
            {info.canManage && info.requests.length > 0 && (
              <>
                <label className="field-label">访问申请 · {info.requests.length}</label>
                {info.requests.map((r) => (
                  <div className="member-row" key={r.id}>
                    <span className="avatar" style={{ background: '#B54708' }}>
                      {r.name.slice(0, 1)}
                    </span>
                    <span className="member-meta">
                      <span className="member-name">{r.name}</span>
                      <span className="member-sub">
                        申请「{r.want === 'edit' ? '可编辑' : '只查看'}
                        」{r.note ? ' · ' + r.note : ''}
                      </span>
                    </span>
                    <span className="member-perm">
                      <button className="on" onClick={() => resolveRequest(r.id, true, r.name)}>
                        批准
                      </button>
                      <button onClick={() => resolveRequest(r.id, false, r.name)}>拒绝</button>
                    </span>
                  </div>
                ))}
              </>
            )}

            {/* ---- 邀请成员 ---- */}
            {info.canManage && (
              <>
                <label className="field-label">添加成员</label>
                <div className="invite-row">
                  <input
                    placeholder="姓名"
                    value={inviteName}
                    onChange={(e) => setInviteName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && invite()}
                  />
                  <select
                    value={invitePerm}
                    onChange={(e) => setInvitePerm(e.target.value as Perm3)}
                    aria-label="新成员权限"
                  >
                    {PERMS.map((p) => (
                      <option key={p} value={p}>
                        {PERM_LABEL[p]}
                      </option>
                    ))}
                  </select>
                </div>
                <button className="btn-primary" disabled={busy} onClick={invite}>
                  {busy ? '添加中…' : '添加'}
                </button>
              </>
            )}

            {/* ---- 链接分享 ---- */}
            <label className="field-label">链接分享</label>
            <div className="segmented">
              {(Object.keys(SCOPE_LABEL) as ShareScope[]).map((s) => (
                <button
                  key={s}
                  className={info.scope === s ? 'active' : ''}
                  disabled={!info.canManage}
                  onClick={() => setScope(s)}
                >
                  {SCOPE_LABEL[s]}
                </button>
              ))}
            </div>
            <p className="hint">{SCOPE_HINT[info.scope]}</p>

            {info.scope !== 'off' && (
              <>
                <label className="field-label">凭链接进入的人可以</label>
                <div className="segmented">
                  {(['view', 'edit'] as LinkPerm[]).map((p) => (
                    <button
                      key={p}
                      className={info.linkPerm === p ? 'active' : ''}
                      disabled={!info.canManage}
                      onClick={() => setLinkPerm(p)}
                    >
                      {PERM_LABEL[p]}
                    </button>
                  ))}
                </div>
                {info.scope === 'any' && (
                  <div className="notice-bar warn">
                    任何拿到链接的人都能打开这份文档。收回时请把范围改回「仅协作者」，
                    那会立即断开所有凭链接进入的人。
                  </div>
                )}
              </>
            )}

            {info.canManage && (
              <>
                <label className="field-label">分享链接</label>
                <div className="share-link">
                  <input readOnly value={info.link} onFocus={(e) => e.currentTarget.select()} />
                  <button className="btn-primary" onClick={copyLink}>
                    复制链接
                  </button>
                </div>
              </>
            )}

            {/* ---- 成员名单 ---- */}
            <label className="field-label">成员 · {info.members.length}</label>
            <div>
              {info.members.map((m, i) => {
                const c = colorOf(i)
                const isSelf = m.name === selfName
                return (
                  <div className="member-row" key={m.id}>
                    <span className="avatar" style={{ background: c.c }}>
                      {m.name.slice(0, 1)}
                    </span>
                    <span className="member-meta">
                      <span className="member-name">
                        {m.name}
                        {isSelf && <span className="member-self-tag">我</span>}
                        {m.owner && <span className="member-self-tag">所有者</span>}
                      </span>
                      <span className="member-sub">
                        {m.owner ? '拥有全部权限，可转让所有权' : `${VIA_LABEL[m.via] || ''} · ${PERM_HINT[m.perm as Perm3]}`}
                      </span>
                    </span>
                    {m.owner ? (
                      <span className="member-sub">可管理</span>
                    ) : (
                      <span className="member-perm">
                        {PERMS.map((p) => (
                          <button
                            key={p}
                            className={m.perm === p ? 'on' : ''}
                            disabled={!info.canManage}
                            onClick={() => setPerm(m.id, p, m.name)}
                            title={PERM_HINT[p]}
                          >
                            {PERM_LABEL[p]}
                          </button>
                        ))}
                      </span>
                    )}
                    {info.canManage && !m.owner && (
                      <button
                        className="member-remove"
                        title="移除成员"
                        onClick={() => removeMember(m.id, m.name)}
                      >
                        ×
                      </button>
                    )}
                  </div>
                )
              })}
            </div>

            <p className="hint">
              权限由服务端强制执行：只读成员的编辑请求会被直接丢弃，
              移除成员或收回链接会立即断开对方的协同连接。
            </p>
          </div>
        )}
      </aside>
    </div>
  )
}
