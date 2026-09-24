import { useEffect, useState } from 'react'
import type { WebsocketProvider } from 'y-websocket'

export interface RemotePeer {
  clientId: number
  user?: { id: string; name: string; colorIndex: number }
  selection?: { r: number; c: number }
  editing?: { r: number; c: number }
}

/** 订阅 Yjs awareness，返回除自己以外的所有在线协作者及其选区/编辑位置 */
export function useAwareness(provider: WebsocketProvider): RemotePeer[] {
  const [peers, setPeers] = useState<RemotePeer[]>([])

  useEffect(() => {
    const awareness = provider.awareness
    const update = () => {
      const arr: RemotePeer[] = []
      awareness.getStates().forEach((state: any, clientId: number) => {
        if (clientId === awareness.clientID) return
        if (!state.user) return
        arr.push({
          clientId,
          user: state.user,
          selection: state.selection,
          editing: state.editing,
        })
      })
      setPeers(arr)
    }
    awareness.on('change', update)
    update()
    return () => awareness.off('change', update)
  }, [provider])

  return peers
}

/** 在线名单快照（含自己），并不订阅变更——用于一次性重名校验 */
export function snapshotPeers(provider: WebsocketProvider): RemotePeer[] {
  const arr: RemotePeer[] = []
  provider.awareness.getStates().forEach((state: any, clientId: number) => {
    if (clientId === provider.awareness.clientID) return
    if (!state.user) return
    arr.push({ clientId, user: state.user })
  })
  return arr
}
