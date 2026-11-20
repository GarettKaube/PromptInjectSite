export interface InvokeResponse {
  text: string
  sessionId: string
  toolCalls: ToolCall[]
}

export interface ToolCall {
  id: string
  name: string
  status: string
  input: unknown
  output: string
}



export async function invokeRequest(prompt: string, injectionId: string): Promise<InvokeResponse> {

  let response: Response
  try {
    response = await fetch('/api/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, injectionId }),
    })
  } catch {
    throw new Error('The app API is unreachable. Start the app with `npm run dev` so the API server and frontend both run.')
  }

  const payload = await response.json().catch(() => ({})) as Partial<InvokeResponse> & { error?: string }
  if (!response.ok) {
    throw new Error(payload.error || `OpenCode request failed (${response.status})`)
  }
  if (typeof payload.text !== 'string' || typeof payload.sessionId !== 'string' || !Array.isArray(payload.toolCalls)) {
    throw new Error('The OpenCode server returned an unexpected response.')
  }

  return { text: payload.text, sessionId: payload.sessionId, toolCalls: payload.toolCalls }
}
