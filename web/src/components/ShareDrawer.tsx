import { useEffect, useState } from 'react'
import { api, type ShareMember } from '../store/api'
import { colorOf } from '../store/user'

const PERM_LABEL: Record<ShareMember['perm'], string> = {
  edit: '可编辑',
  comment: '可评论',
  view: '只读',
}
const PERM_HINT: Record<ShareMember['perm'], string> = {
  edit: '可以修改内容，也能邀请他人',
  comment: '只能添加评论，不产生编辑锁',
  view: '只可查看，工具栏将置灰',
}
const SCOPE_LABEL = { specified: '仅指定人', org: '组织内', any: '任何人有链接' } as const

/** 分享与权限抽屉（S5）：成员/权限/邀请/链接范围全部落到后端 */
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
  const [info, setInfo] = useState<{
    scope: 'specified' | 'org' | 'any'
    defaultPerm: ShareMember['perm']
    members: ShareMember[]
    link: string
  } | null>(null)
  const [inviteName, setInviteName] = useState('')
  const [inviteMail, setInviteMail] = useState('')
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

  const setScope = async (scope: 'specified' | 'org' | 'any') => {
    try {
      await api.updateShare(docId, { scope })
      setInfo((i) => (i ? { ...i, scope } : i))
      onToast('链接范围已改为「' + SCOPE_LABEL[scope] + '」')
    } catch (e) {
      onToast('修改失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const setPerm = async (id: string, perm: ShareMember['perm'], name: string) => {
    try {
      await api.setMemberPerm(docId, id, perm)
      setInfo((i) =>
        i ? { ...i, members: i.members.map((m) => (m.id === id ? { ...m, perm } : m)) } : i
      )
      onToast(`${name} 的权限已设为「${PERM_LABEL[perm]}」`)
    } catch (e) {
      onToast('修改权限失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const invite = async () => {
    const name = inviteName.trim() || inviteMail.trim().split('@')[0] || '新成员'
    if (!inviteName.trim() && !inviteMail.trim()) {
      onToast('请填写姓名或邮箱')
      return
    }
    setBusy(true)
    try {
      await api.invite(docId, name, 'edit')
      setInviteName('')
      setInviteMail('')
      await load()
      onToast(`已邀请 ${name}（默认可编辑）`)
    } catch (e) {
      onToast('邀请失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  const removeMember = async (m: ShareMember) => {
    try {
      await api.removeMember(docId, m.id)
      setInfo((i) => (i ? { ...i, members: i.members.filter((x) => x.id !== m.id) } : i))
      onToast(`已移除 ${m.name}`)
    } catch (e) {
      onToast('移除失败：' + (e instanceof Error ? e.message : String(e)))
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
            <label className="field-label">邀请成员</label>
            <div className="invite-row">
              <input
                placeholder="姓名"
                value={inviteName}
                onChange={(e) => setInviteName(e.target.value)}
              />
              <input
                placeholder="邮箱（可选）"
                value={inviteMail}
                onChange={(e) => setInviteMail(e.target.value)}
              />
            </div>
            <button className="btn-primary" disabled={busy} onClick={invite}>
              {busy ? '邀请中…' : '发送邀请'}
            </button>

            <label className="field-label">链接范围</label>
            <div className="segmented">
              {(['specified', 'org', 'any'] as const).map((s) => (
                <button
                  key={s}
                  className={info.scope === s ? 'active' : ''}
                  onClick={() => setScope(s)}
                >
                  {SCOPE_LABEL[s]}
                </button>
              ))}
            </div>
            <p className="hint">
              {info.scope === 'specified'
                ? '只有下方成员能打开，其他人请求访问需向你申请。'
                : info.scope === 'org'
                ? '同一组织内的成员凭链接即可打开。'
                : '任何拿到链接的人都能打开，请谨慎使用。'}
            </p>

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
                        {m.id === 'owner' && <span className="member-self-tag">所有者</span>}
                      </span>
                      <span className="member-sub">{PERM_HINT[m.perm]}</span>
                    </span>
                    {m.id === 'owner' ? (
                      <span className="member-sub">可编辑</span>
                    ) : (
                      <span className="member-perm">
                        {(['edit', 'comment', 'view'] as const).map((p) => (
                          <button
                            key={p}
                            className={m.perm === p ? 'on' : ''}
                            onClick={() => setPerm(m.id, p, m.name)}
                            title={PERM_HINT[p]}
                          >
                            {PERM_LABEL[p]}
                          </button>
                        ))}
                      </span>
                    )}
                    {m.id !== 'owner' && (
                      <button
                        className="member-remove"
                        title="移除成员"
                        onClick={() => removeMember(m)}
                      >
                        ×
                      </button>
                    )}
                  </div>
                )
              })}
            </div>

            <label className="field-label">分享链接</label>
            <div className="share-link">
              <input readOnly value={info.link} onFocus={(e) => e.currentTarget.select()} />
              <button className="btn-primary" onClick={copyLink}>
                复制链接
              </button>
            </div>
            <p className="hint">
              演示环境未接账号系统，成员名单由后端进程内存维护，服务端重启后会重置为仅所有者。
            </p>
          </div>
        )}
      </aside>
    </div>
  )
}
