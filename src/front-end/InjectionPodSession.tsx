import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'

interface InjectionPodSessionState {
  id: string | null
  ready: boolean
  error: string | null
}

const InjectionPodSessionContext = createContext<InjectionPodSessionState>({ id: null, ready: false, error: null })
const SESSION_STORAGE_KEY = 'prompt-injection-session'

async function postSessionAction(path: string, id: string, keepalive = false): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
    keepalive,
  })
}

async function endSession(id: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await postSessionAction('/api/injection/session/end', id, true)
      const result = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(result.error || `Could not delete the injection pod (${response.status}).`)
      console.info(`Injection session ${id} cleanup requested.`)
      return
    } catch (error) {
      lastError = error
      if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 500 * (attempt + 1)))
    }
  }
  console.error(`Could not delete injection session ${id}:`, lastError)
}

export function InjectionPodSessionProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const isInInjectionArea = pathname === '/direct' || pathname === '/indirect'
  const [id, setId] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const idRef = useRef<string | null>(null)
  const activeRef = useRef(isInInjectionArea)
  const startRequestRef = useRef<Promise<void> | null>(null)

  activeRef.current = isInInjectionArea

  useEffect(() => {
    if (!isInInjectionArea) {
      const sessionId = idRef.current
      if (sessionId) {
        const finish = () => endSession(sessionId)
        if (startRequestRef.current) void startRequestRef.current.finally(finish)
        else void finish()
      }
      idRef.current = null
      sessionStorage.removeItem(SESSION_STORAGE_KEY)
      setId(null)
      setReady(false)
      setError(null)
      return
    }

    let sessionId = sessionStorage.getItem(SESSION_STORAGE_KEY)
    if (!sessionId) {
      sessionId = crypto.randomUUID()
      sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId)
    }
    idRef.current = sessionId
    setId(sessionId)
    setReady(false)
    setError(null)

    if (!startRequestRef.current) {
      startRequestRef.current = postSessionAction('/api/injection/session/start', sessionId)
        .then(async (response) => {
          const result = await response.json().catch(() => ({})) as { error?: string }
          if (!response.ok) throw new Error(result.error || `Could not start the injection pod (${response.status}).`)
          if (activeRef.current && idRef.current === sessionId) setReady(true)
        })
        .catch((startError: unknown) => {
          if (activeRef.current && idRef.current === sessionId) {
            setError(startError instanceof Error ? startError.message : 'Could not start the injection pod.')
          }
        })
        .finally(() => { startRequestRef.current = null })
    }

    const heartbeat = window.setInterval(() => {
      if (idRef.current !== sessionId || !activeRef.current) return
      void postSessionAction('/api/injection/session/heartbeat', sessionId)
        .then((response) => {
          if (!response.ok) throw new Error('The injection pod session could not be renewed.')
          setReady(true)
          setError(null)
        })
        .catch((heartbeatError: unknown) => {
          setReady(false)
          setError(heartbeatError instanceof Error ? heartbeatError.message : 'The injection pod session could not be renewed.')
        })
    }, 60_000)

    let closeCleanupQueued = false
    const endOnPageClose = () => {
      
      if (closeCleanupQueued) return
      closeCleanupQueued = true
      const blob = new Blob([JSON.stringify({ id: sessionId })], { type: 'application/json' })
      // sendBeacon is designed for page shutdown, while keepalive fetch provides
      // a second delivery path if the browser queues but never delivers the beacon.
      try {
        if (typeof navigator.sendBeacon === 'function') {
          navigator.sendBeacon('/api/injection/session/end', blob)
        }
      } catch (cleanupError) {
        console.warn('Could not queue the injection session cleanup beacon:', cleanupError)
      }
      void postSessionAction('/api/injection/session/end', sessionId, true)
        .then((response) => {
          if (!response.ok) throw new Error(`Cleanup request returned ${response.status}.`)
        })
        .catch((cleanupError) => {
          console.error(`Could not queue cleanup for injection session ${sessionId}:`, cleanupError)
        })
    }
    window.addEventListener('pagehide', endOnPageClose)
    window.addEventListener('beforeunload', endOnPageClose)

    return () => {
      window.clearInterval(heartbeat)
      window.removeEventListener('pagehide', endOnPageClose)
      window.removeEventListener('beforeunload', endOnPageClose)
    }
  }, [isInInjectionArea])

  return (
    <InjectionPodSessionContext.Provider value={{ id, ready, error }}>
      {children}
    </InjectionPodSessionContext.Provider>
  )
}

export function useInjectionPodSession(): InjectionPodSessionState {
  return useContext(InjectionPodSessionContext)
}
