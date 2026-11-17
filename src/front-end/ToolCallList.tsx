import type { ToolCall } from './InvokeRequest'

interface ToolCallListProps {
  calls: ToolCall[]
}

function formatInput(input: unknown): string {
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

export function ToolCallList({ calls }: ToolCallListProps) {
  return (
    <section className="tool-call-list" aria-label="OpenCode tool calls">
      <div className="tool-call-heading">OPENCODE TOOL CALLS <span>{calls.length}</span></div>
      {calls.length === 0 ? (
        <p className="tool-call-empty">OpenCode did not call any tools for this run.</p>
      ) : calls.map((call, index) => (
        <details className="tool-call-item" key={`${call.id}-${index}`}>
          <summary><code>{call.name}</code><span className={`tool-call-status ${call.status === 'error' ? 'is-error' : ''}`}>{call.status}</span></summary>
          <div className="tool-call-detail">
            <strong>Input</strong>
            <pre>{formatInput(call.input)}</pre>
            {call.output && <><strong>Output</strong><pre>{call.output}</pre></>}
          </div>
        </details>
      ))}
    </section>
  )
}
