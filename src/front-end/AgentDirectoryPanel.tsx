import { useCallback, useEffect, useState } from 'react'
import { File, Folder, CornerDownRight, RotateCcw } from 'lucide-react';

interface AgentDirectoryEntry {
  name: string
  path: string
  type: 'file' | 'directory'
}

interface AgentDirectoryResponse {
  directory: string
  path: string
  entries: AgentDirectoryEntry[]
  truncated: boolean
  error?: string
}

interface AgentDirectoryPanelProps {
  sessionId: string | null
  ready: boolean
}

export function AgentDirectoryPanel({ sessionId, ready }: AgentDirectoryPanelProps) {
  const [relativePath, setRelativePath] = useState('')
  const [listing, setListing] = useState<AgentDirectoryResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  const filecolor: string = '#7573f2';

  useEffect(() => {
    setRelativePath('')
    setListing(null)
    setError(null)
  }, [sessionId])

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!sessionId || !ready) return
    setLoading(true)
    try {
      const query = new URLSearchParams({ id: sessionId })
      if (relativePath) query.set('path', relativePath)
      const response = await fetch(`/api/injection/session/directory?${query}`, { signal })
      const result = await response.json() as AgentDirectoryResponse
      if (!response.ok) throw new Error(result.error || `Directory request failed (${response.status}).`)
      setListing(result)
      setError(null)
    } catch (requestError) {
      if (requestError instanceof Error && requestError.name === 'AbortError') return
      setError(requestError instanceof Error ? requestError.message : 'Could not load the agent directory.')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [sessionId, ready, relativePath])

  useEffect(() => {
    if (!sessionId || !ready) {
      setListing(null)
      setLoading(false)
      return
    }

    

    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = window.setInterval(() => void refresh(controller.signal), 10_000)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [sessionId, ready, relativePath, refreshKey, refresh])

  const pathParts = relativePath ? relativePath.split('/') : []
  const crumbs = [{ label: listing?.directory || 'Workspace', path: '' }, ...pathParts.map((part, index) => ({
    label: part,
    path: pathParts.slice(0, index + 1).join('/'),
  }))]



  return (
    <section className="panel agent-directory-panel" aria-label="Agent's directory">
      <header className="panel-header agent-directory-header">
        <div>
          <h2><span className="step-number lime"><CornerDownRight size={18}/></span>Agent's directory</h2>
          <p className="agent-directory-caption">These are the workspace files in the agent's working directory · refreshes every 10 seconds</p>
        </div>
        <button className="agent-directory-refresh" type="button" onClick={() => setRefreshKey((value) => value + 1)} disabled={!ready || loading}>
          {loading ? 'Refreshing…' : (<><div className="reload-button"><RotateCcw size={12}/> Refresh</div></>)}
        </button>
      </header>
      <div className="panel-content">
        {!sessionId ? (
          <p className="agent-directory-message">Enter the injection area to start a workspace.</p>
        ) : !ready ? (
          <p className="agent-directory-message">The agent workspace will appear when the pod is ready.</p>
        ) : error ? (
          <p className="agent-directory-error" role="alert">{error}</p>
        ) : (
          <>
            <nav className="agent-directory-breadcrumbs" aria-label="Workspace directory path">
              {crumbs.map((crumb, index) => (
                <span className="agent-directory-crumb" key={crumb.path || 'root'}>
                  {index > 0 && <span className="agent-directory-separator">/</span>}
                  <button type="button" onClick={() => setRelativePath(crumb.path)} disabled={relativePath === crumb.path} title={crumb.path || listing?.directory}>
                    {crumb.label}
                  </button>
                </span>
              ))}
            </nav>
            {listing?.entries.length ? (
              <ul className="agent-directory-list">
                {listing.entries.map((entry) => (
                  <li key={`${entry.type}:${entry.path}`}>
                    {entry.type === 'directory' ? (
                      <button className="agent-directory-entry" type="button" onClick={() => setRelativePath(entry.path)}>
                        <span aria-hidden="true"><Folder color={filecolor} size={18} strokeWidth={3}/></span><span>{entry.name}</span><span className="agent-directory-open">Open</span>
                      </button>
                    ) : (
                      <div className="agent-directory-entry agent-directory-file"><span aria-hidden="true"><File color={filecolor} size={18} strokeWidth={3}/></span><span>{entry.name}</span></div>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="agent-directory-message">This directory is empty.</p>
            )}
            {listing?.truncated && <p className="agent-directory-message">Showing the first 300 entries.</p>}
          </>
        )}
      </div>
    </section>
  )
}
