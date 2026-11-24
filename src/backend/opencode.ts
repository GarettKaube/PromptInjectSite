import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { basename, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sendJson, readRequestBody, isRecord, HttpError, apiUrl } from './utils'
import { validSessionId, attachInjectionSession } from './kubernetes'


const scriptDirectory = fileURLToPath(new URL('.', import.meta.url))
const root = basename(scriptDirectory) === 'dist-server' ? resolve(scriptDirectory, '..') : scriptDirectory
const distDirectory = resolve(root, 'dist')
const environmentFile = resolve(root, '.env')
const REQUEST_TIMEOUT_MS = 600_000



function loadLocalEnvironment() {
  if (!existsSync(environmentFile)) return

  for (const line of readFileSync(environmentFile, 'utf8').split(/\r?\n/)) {
    const entry = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!entry || entry[1] in process.env) continue

    const value = entry[2].replace(/^(['"])(.*)\1$/, '$2')
    process.env[entry[1]] = value
  }
}

loadLocalEnvironment()


interface MessagePart {
  type?: string
  id?: string
  name?: string
  text?: string
  executed?: boolean
  state?: {
    status?: string
    input?: unknown
    content?: MessagePart[]
  }
}

interface OpenCodeMessage {
  id?: string
  type?: string
  info?: {
    id?: string
    type?: string
    content?: MessagePart[]
  }
  parts?: MessagePart[]
  content?: MessagePart[]
}

async function readOpenCodeJson(response: Response, operation: string): Promise<unknown> {
  const raw = await response.text()
  if (!response.ok) {
    console.error(`OpenCode ${operation} returned ${response.status}: ${raw}`)
    throw Object.assign(new Error(`OpenCode ${operation} failed (${response.status}).`), { status: 502 })
  }

  if (!raw) return null
  try {
    const result = JSON.parse(raw)
    // OpenCode 2 wraps API response bodies in a `data` property.
    return result && typeof result === 'object' && 'data' in result ? result.data : result
  } catch {
    throw Object.assign(new Error(`OpenCode ${operation} returned invalid JSON.`), { status: 502 })
  }
}

async function openCodeRequest(url: URL, options: RequestInit, operation: string): Promise<unknown> {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  return readOpenCodeJson(response, operation)
}

function messageListFrom(result: unknown): OpenCodeMessage[] {
  if (Array.isArray(result)) return result as OpenCodeMessage[]
  if (!isRecord(result)) return []
  if (Array.isArray(result.items)) return result.items as OpenCodeMessage[]
  if (Array.isArray(result.messages)) return result.messages as OpenCodeMessage[]
  return []
}

function textFromAssistantMessage(message: OpenCodeMessage): string {
  const info = message?.info ?? message
  if (info?.type !== 'assistant') return ''

  return (message.parts ?? info.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text || '')
      .join('')
}

function toolCallsFrom(messages: OpenCodeMessage[]) {
  return messages.flatMap((message) => {
    const info = message?.info ?? message
    if (info?.type !== 'assistant') return []
    const parts = message.parts ?? info.content ?? []
    return parts.filter((part) => part?.type === 'tool').map((part) => {
      const state = part.state ?? {}
      const output = Array.isArray(state.content)
        ? state.content.filter((item) => item?.type === 'text').map((item) => item.text || '').join('\n')
        : ''
      return {
        id: part.id || `${info.id || 'tool'}-${part.name || 'call'}`,
        name: part.name || 'Tool',
        status: state.status || (part.executed ? 'completed' : 'unknown'),
        input: state.input ?? {},
        output: output.slice(0, 6000),
      }
    })
  })
}



export async function invokeOpenCode(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    return sendJson(response, 405, { error: 'Use POST to send a prompt.' })
  }

  const password = process.env.OPENCODE_SERVER_PASSWORD
  const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode'
  if (!password) {
    return sendJson(response, 503, {
      error: 'OpenCode authentication is not configured. Set OPENCODE_SERVER_PASSWORD in .env or the server deployment, then restart the app.',
    })
  }

  let payload: unknown
  try {
    payload = await readRequestBody(request)
  } catch (error) {
    const httpError = error as HttpError
    return sendJson(response, httpError.status || 400, { error: httpError.message })
  }
  if (!isRecord(payload) || typeof payload.prompt !== 'string' || !payload.prompt.trim()) {
    return sendJson(response, 400, { error: 'A non-empty prompt is required.' })
  }
  if (!validSessionId(payload.injectionId)) {
    return sendJson(response, 400, { error: 'The injection pod session is missing. Leave the injection area and enter it again.' })
  }

  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  const headers = { Authorization: authorization, 'Content-Type': 'application/json' }

  try {
    const injectionSession = await attachInjectionSession(payload.injectionId.toLowerCase())
    const baseUrl = injectionSession.baseUrl
    injectionSession.lastSeenAt = Date.now()

    const created = await openCodeRequest(apiUrl(baseUrl, 'session'), {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    }, 'POST /api/session')

    const sessionId = isRecord(created) ? created.id ?? created.sessionID : undefined
    if (typeof sessionId !== 'string' || !sessionId) {
      console.error('OpenCode POST /api/session returned an unexpected body:', JSON.stringify(created))
      return sendJson(response, 502, { error: 'OpenCode returned a session without an ID.' })
    }

    // V2 admits the prompt into the session inbox. The response confirms
    // admission; the wait endpoint blocks until the agent loop is idle.
    await openCodeRequest(apiUrl(baseUrl, `session/${encodeURIComponent(sessionId)}/prompt`), {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: payload.prompt, delivery: 'steer', resume: true }),
    }, `POST /api/session/${sessionId}/prompt`)

    await openCodeRequest(apiUrl(baseUrl, `experimental/session/${encodeURIComponent(sessionId)}/wait`), {
      method: 'POST',
      headers,
    }, `POST /api/experimental/session/${sessionId}/wait`)

    const messageResult = await openCodeRequest(apiUrl(baseUrl, `session/${encodeURIComponent(sessionId)}/message?order=desc&limit=20`), {
      method: 'GET',
      headers,
    }, `GET /api/session/${sessionId}/message`)

    const messages = messageListFrom(messageResult)
    const text = messages.map(textFromAssistantMessage).find((value) => value.length > 0) || ''
    const toolCalls = toolCallsFrom(messages).reverse()
    if (!text) {
      console.error('OpenCode completed the session but returned no assistant text:', JSON.stringify(messageResult))
      return sendJson(response, 502, { error: 'OpenCode finished without returning assistant text.' })
    }

    return sendJson(response, 200, { text, sessionId, toolCalls })
  } catch (error) {
    const httpError = error as HttpError
    console.error(`OpenCode request failed: ${httpError.message}`)
    return sendJson(response, httpError.status || 502, {
      error: httpError.message || 'Could not reach OpenCode. Check the server URL and that the server is running.',
    })
  }
}

export async function getInjectionDirectory(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET')
    return sendJson(response, 405, { error: 'Use GET to list the agent directory.' })
  }

  const url = new URL(request.url || '/', 'http://localhost')
  const id = url.searchParams.get('id')?.toLowerCase()
  const requestedPath = url.searchParams.get('path') || ''
  if (!validSessionId(id)) return sendJson(response, 400, { error: 'A valid injection session ID is required.' })
  if (requestedPath.length > 2048 || requestedPath.startsWith('/') || requestedPath.includes('\\')) {
    return sendJson(response, 400, { error: 'The directory path must be relative to the agent workspace.' })
  }
  const pathParts = requestedPath.split('/').filter((part) => part && part !== '.')
  if (pathParts.some((part) => part === '..' || part.includes('\0'))) {
    return sendJson(response, 400, { error: 'The directory path must stay inside the agent workspace.' })
  }
  const relativePath = pathParts.join('/')

  const password = process.env.OPENCODE_SERVER_PASSWORD
  if (!password) return sendJson(response, 503, { error: 'OpenCode authentication is not configured.' })
  const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode'
  const headers = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` }

  try {
    const session = await attachInjectionSession(id)
    session.lastSeenAt = Date.now()
    const location = await openCodeRequest(apiUrl(session.baseUrl, 'location'), { method: 'GET', headers }, 'GET /api/location')
    if (!isRecord(location) || typeof location.directory !== 'string') {
      throw Object.assign(new Error('OpenCode did not return the active workspace directory.'), { status: 502 })
    }

    const listUrl = apiUrl(session.baseUrl, 'fs/list')
    if (relativePath) listUrl.searchParams.set('path', relativePath)
    const listing = await openCodeRequest(listUrl, { method: 'GET', headers }, 'GET /api/fs/list')
    const rawEntries = Array.isArray(listing)
      ? listing
      : isRecord(listing) && Array.isArray(listing.entries)
        ? listing.entries
        : isRecord(listing) && Array.isArray(listing.items)
          ? listing.items
          : []
    const entries = rawEntries.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.path !== 'string' || (entry.type !== 'file' && entry.type !== 'directory')) return []
      const name = entry.path.split('/').filter(Boolean).at(-1)
      if (!name || name === '.' || name === '..') return []
      return [{ name, type: entry.type, path: relativePath ? `${relativePath}/${name}` : name }]
    }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1))

    return sendJson(response, 200, {
      directory: location.directory,
      path: relativePath,
      entries: entries.slice(0, 300),
      truncated: entries.length > 300,
    })
  } catch (error) {
    const httpError = error as HttpError
    console.error(`Could not list the agent directory: ${httpError.message}`)
    return sendJson(response, httpError.status || 502, { error: httpError.message || 'Could not list the agent directory.' })
  }
}