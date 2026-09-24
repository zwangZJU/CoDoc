import { useCallback, useEffect, useMemo, useState } from 'react'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { applyIdentity, getLocalUser, type LocalUser } from './user'

// 经 vite 代理：开发期同域 /collab 转发到后端 1234
const WS_BASE =
  (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/collab'

/**
 * 建立协同房间，并把本地身份（姓名/颜色/是否访客）写进 awareness。
 * identity 非空时用它（分享链接进来的访客），否则用本机用户。
 */
export function useCollab(docName: string, identity?: LocalUser | null) {
  const [user, setUser] = useState<LocalUser>(() => identity || getLocalUser())
  const ydoc = useMemo(() => new Y.Doc(), [docName])
  const provider = useMemo(
    () => new WebsocketProvider(WS_BASE, docName, ydoc, { connect: true }),
    [docName, ydoc]
  )

  // 身份变化（改名/换色）要立刻广播出去，别人看到的在线名单才会跟着变
  useEffect(() => {
    provider.awareness.setLocalStateField('user', {
      id: user.id,
      name: user.name,
      colorIndex: user.colorIndex,
      guest: !!user.guest,
    })
  }, [provider, user])

  useEffect(() => {
    return () => {
      provider.destroy()
    }
  }, [provider])

  const rename = useCallback((name: string, colorIndex?: number) => {
    setUser((prev) =>
      applyIdentity(prev, {
        ...(name ? { name: name.trim() } : {}),
        ...(colorIndex !== undefined ? { colorIndex } : {}),
      })
    )
  }, [])

  return { ydoc, provider, user, rename }
}
