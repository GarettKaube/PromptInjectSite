import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { basename, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KubeConfig } from '@kubernetes/client-node'
import { CoreV1Api, type V1Pod } from '@kubernetes/client-node/dist/gen/index.js'

const scriptDirectory = fileURLToPath(new URL('.', import.meta.url))
const root = basename(scriptDirectory) === 'dist-server' ? resolve(scriptDirectory, '..') : scriptDirectory
const distDirectory = resolve(root, 'dist')
const environmentFile = resolve(root, '.env')
const REQUEST_TIMEOUT_MS = 240_000

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

interface HttpError extends Error {
  status?: number
}

interface InjectionSession {
  id: string
  podName: string
  baseUrl: string
  portForward?: ChildProcess
  lastSeenAt: number
}

const INJECTION_LABEL = 'app.kubernetes.io/name=prompt-injection'
const SESSION_LABEL = 'session-id'
const MANAGED_LABEL = 'managed-by'
const MANAGED_VALUE = 'prompt-injection'
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const injectionSessions = new Map<string, InjectionSession>()
const injectionSessionStarts = new Map<string, Promise<InjectionSession>>()
let kubernetesApi: CoreV1Api | undefined
let kubeConfig: KubeConfig | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

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

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(data))
}

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  let body = ''
  for await (const chunk of request) {
    body += chunk.toString()
    if (body.length > 150_000) {
      throw Object.assign(new Error('Prompt is too large.'), { status: 413 })
    }
  }

  try {
    return JSON.parse(body)
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 })
  }
}

function getKubernetesApi(): CoreV1Api {
  if (!kubernetesApi) {
    kubeConfig = new KubeConfig()
    kubeConfig.loadFromDefault()
    const cluster = kubeConfig.getCurrentCluster()
    if (cluster?.server === 'http://localhost:8080' && !cluster.skipTLSVerify) {
      throw new Error('No Kubernetes kubeconfig was loaded. Set KUBECONFIG in .env to the config file used by kubectl, then restart the app.')
    }
    if (cluster?.server.startsWith('http:') && !cluster.skipTLSVerify) {
      throw new Error('The Kubernetes API URL uses HTTP without explicit insecure access. Point KUBECONFIG at the HTTPS cluster config; only set skipTLSVerify for a cluster intentionally configured for HTTP.')
    }
    kubernetesApi = kubeConfig.makeApiClient(CoreV1Api)
  }
  return kubernetesApi
}

function getKubernetesNamespace(): string {
  if (process.env.KUBERNETES_NAMESPACE) return process.env.KUBERNETES_NAMESPACE
  if (process.env.POD_NAMESPACE) return process.env.POD_NAMESPACE

  if (!kubeConfig) getKubernetesApi()
  const context = kubeConfig?.getContextObject(kubeConfig.getCurrentContext())
  return context?.namespace || 'default'
}

function kubernetesErrorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined
  if (typeof error.statusCode === 'number') return error.statusCode
  if (typeof error.code === 'number') return error.code
  if (isRecord(error.response) && typeof error.response.status === 'number') return error.response.status
  return undefined
}

function sessionPodName(id: string): string {
  return `prompt-injection-${id.toLowerCase()}`
}

function makeSessionPod(namespace: string, id: string): V1Pod {
  const secretName = process.env.OPENCODE_POD_SECRET_NAME || 'opencode-auth'
  const secretKey = process.env.OPENCODE_POD_SECRET_KEY || 'OPENCODE_SERVER_PASSWORD'
  const image = process.env.OPENCODE_POD_IMAGE || 'opencode-ollama-pi-env:latest'

  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: sessionPodName(id),
      namespace,
      labels: {
        'app.kubernetes.io/name': 'prompt-injection',
        [SESSION_LABEL]: id.toLowerCase(),
        [MANAGED_LABEL]: MANAGED_VALUE,
      },
      annotations: { 'prompt-injection/created-at': new Date().toISOString() },
    },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true, runAsUser: 10001, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [{
        name: 'opencode',
        image,
        imagePullPolicy: process.env.OPENCODE_POD_IMAGE_PULL_POLICY || 'IfNotPresent',
        ports: [{ name: 'opencode', containerPort: 4096, protocol: 'TCP' }],
        env: [
          { name: 'OPENCODE_SERVER_USERNAME', value: process.env.OPENCODE_SERVER_USERNAME || 'opencode' },
          {
            name: 'OPENCODE_SERVER_PASSWORD',
            valueFrom: { secretKeyRef: { name: secretName, key: secretKey } },
          },
        ],
        resources: {
          requests: {
            cpu: process.env.OPENCODE_POD_CPU_REQUEST || '250m',
            memory: process.env.OPENCODE_POD_MEMORY_REQUEST || '512Mi',
          },
          limits: {
            cpu: process.env.OPENCODE_POD_CPU_LIMIT || '2',
            memory: process.env.OPENCODE_POD_MEMORY_LIMIT || '4Gi',
          },
        },
        securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
      }],
    },
  }
}

async function ensureSessionPod(namespace: string, id: string): Promise<V1Pod> {
  const api = getKubernetesApi()
  const name = sessionPodName(id)

  try {
    const existing = await api.readNamespacedPod({ namespace, name })
    if (existing.metadata?.labels?.[MANAGED_LABEL] !== MANAGED_VALUE
      || existing.metadata?.labels?.[SESSION_LABEL] !== id.toLowerCase()) {
      throw Object.assign(new Error('A pod with the generated session name is not managed by this app.'), { status: 409 })
    }
    return existing
  } catch (error) {
    if (kubernetesErrorStatus(error) !== 404) throw error
  }

  try {
    return await api.createNamespacedPod({ namespace, body: makeSessionPod(namespace, id) })
  } catch (error) {
    // An idempotent start may race with another request from the same tab.
    if (kubernetesErrorStatus(error) !== 409) throw error
    const existing = await api.readNamespacedPod({ namespace, name })
    if (existing.metadata?.labels?.[MANAGED_LABEL] !== MANAGED_VALUE
      || existing.metadata?.labels?.[SESSION_LABEL] !== id.toLowerCase()) throw error
    return existing
  }
}

async function enforceInjectionPodLimit(namespace: string, id: string): Promise<void> {
  const maximum = Number(process.env.INJECTION_MAX_ACTIVE_PODS || 3)
  const pods = await getKubernetesApi().listNamespacedPod({
    namespace,
    labelSelector: `${INJECTION_LABEL},${MANAGED_LABEL}=${MANAGED_VALUE}`,
  })
  const activePods = (pods.items || []).filter((pod) => pod.status?.phase !== 'Failed' && pod.status?.phase !== 'Succeeded')
  if (activePods.some((pod) => pod.metadata?.name === sessionPodName(id))) return
  if (activePods.length >= maximum) {
    throw Object.assign(new Error(`The injection lab is at capacity (${maximum} active sessions). Try again later.`), { status: 429 })
  }
}

async function waitForPodReady(namespace: string, name: string): Promise<V1Pod> {
  const api = getKubernetesApi()
  const deadline = Date.now() + Number(process.env.OPENCODE_POD_START_TIMEOUT_MS || 180_000)

  while (Date.now() < deadline) {
    const pod = await api.readNamespacedPod({ namespace, name })
    const phase = pod.status?.phase
    if (phase === 'Failed' || phase === 'Succeeded') {
      const detail = pod.status?.message || pod.status?.reason || phase
      throw Object.assign(new Error(`The OpenCode pod stopped before becoming ready: ${detail}`), { status: 503 })
    }
    const waiting = pod.status?.containerStatuses?.find((container) => container.state?.waiting?.reason)
    if (waiting?.state?.waiting?.reason === 'ImagePullBackOff' || waiting?.state?.waiting?.reason === 'ErrImagePull') {
      throw Object.assign(new Error(`Kubernetes could not pull the OpenCode image: ${waiting.state?.waiting?.message || waiting.state?.waiting?.reason}`), { status: 503 })
    }
    if (pod.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True')) return pod
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000))
  }

  throw Object.assign(new Error('Timed out waiting for the OpenCode pod to become ready.'), { status: 504 })
}

async function startPortForward(namespace: string, podName: string): Promise<{ process: ChildProcess; baseUrl: string }> {
  const kubectl = process.env.KUBECTL_PATH || 'kubectl'
  const child = spawn(kubectl, [
    'port-forward', '--address=127.0.0.1', `--namespace=${namespace}`, `pod/${podName}`, ':4096',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

  return await new Promise((resolveForward, rejectForward) => {
    let output = ''
    let settled = false
    const timeout = setTimeout(() => finish(new Error('Timed out starting kubectl port-forward for the OpenCode pod.')), 30_000)
    const finish = (error?: Error, baseUrl?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) {
        child.kill()
        rejectForward(error)
      } else if (baseUrl) {
        resolveForward({ process: child, baseUrl })
      }
    }
    const onOutput = (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.match(/Forwarding from 127\.0\.0\.1:(\d+) -> 4096/)
      if (match) finish(undefined, `http://127.0.0.1:${match[1]}`)
      else if (output.length > 4_000) output = output.slice(-2_000)
    }

    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', onOutput)
    child.once('error', (error) => finish(new Error(`Could not start kubectl port-forward: ${error.message}`)))
    child.once('exit', (code) => finish(new Error(`kubectl port-forward exited before connecting (code ${code ?? 'unknown'}): ${output.trim()}`)))
  })
}

async function waitForOpenCode(baseUrl: string): Promise<void> {
  const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode'
  const password = process.env.OPENCODE_SERVER_PASSWORD
  const authorization = `Basic ${Buffer.from(`${username}:${password || ''}`).toString('base64')}`
  const deadline = Date.now() + Number(process.env.OPENCODE_HEALTH_TIMEOUT_MS || 90_000)

  while (Date.now() < deadline) {
    try {
      const health = await fetch(`${baseUrl}/api/info`, {
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(5_000),
      })
      if (health.ok) return
      if (health.status !== 404 && health.status !== 503) {
        throw Object.assign(new Error(`OpenCode health check returned ${health.status}.`), { status: 503 })
      }
    } catch (error) {
      if (isRecord(error) && error.status === 503) throw error
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500))
  }

  throw Object.assign(new Error('Timed out waiting for the OpenCode API inside the new pod.'), { status: 504 })
}

async function prepareInjectionSession(id: string): Promise<InjectionSession> {
  const existingSession = injectionSessions.get(id)
  if (existingSession) {
    if (existingSession.portForward
      && (existingSession.portForward.exitCode !== null || existingSession.portForward.signalCode !== null)) {
      injectionSessions.delete(id)
      existingSession.portForward.kill()
    } else {
      existingSession.lastSeenAt = Date.now()
      return existingSession
    }
  }

  const namespace = getKubernetesNamespace()
  const podName = sessionPodName(id)
  await enforceInjectionPodLimit(namespace, id)
  await ensureSessionPod(namespace, id)
  const pod = await waitForPodReady(namespace, podName)

  let baseUrl: string
  let portForward: ChildProcess | undefined
  const usePortForward = process.env.INJECTION_USE_PORT_FORWARD
    ? process.env.INJECTION_USE_PORT_FORWARD.toLowerCase() === 'true'
    : !process.env.KUBERNETES_SERVICE_HOST

  if (usePortForward) {
    const forwarded = await startPortForward(namespace, podName)
    baseUrl = forwarded.baseUrl
    portForward = forwarded.process
  } else {
    const podIP = pod.status?.podIP
    if (!podIP) throw Object.assign(new Error('The OpenCode pod is ready but has no pod IP.'), { status: 503 })
    baseUrl = `http://${podIP}:4096`
  }

  try {
    await waitForOpenCode(baseUrl)
  } catch (error) {
    portForward?.kill()
    throw error
  }

  const session = { id, podName, baseUrl, portForward, lastSeenAt: Date.now() }
  injectionSessions.set(id, session)
  return session
}

async function attachInjectionSession(id: string): Promise<InjectionSession> {
  const existingSession = injectionSessions.get(id)
  if (existingSession && (!existingSession.portForward
    || (existingSession.portForward.exitCode === null && existingSession.portForward.signalCode === null))) {
    existingSession.lastSeenAt = Date.now()
    return existingSession
  }
  const pending = injectionSessionStarts.get(id)
  if (pending) return pending

  const start = prepareInjectionSession(id)
  injectionSessionStarts.set(id, start)
  try {
    return await start
  } finally {
    if (injectionSessionStarts.get(id) === start) injectionSessionStarts.delete(id)
  }
}

async function deleteInjectionSession(id: string): Promise<void> {
  const session = injectionSessions.get(id)
  session?.portForward?.kill()
  injectionSessions.delete(id)

  const namespace = getKubernetesNamespace()
  try {
    const pod = await getKubernetesApi().readNamespacedPod({ namespace, name: sessionPodName(id) })
    if (pod.metadata?.labels?.[MANAGED_LABEL] !== MANAGED_VALUE
      || pod.metadata?.labels?.[SESSION_LABEL] !== id.toLowerCase()) return
    await getKubernetesApi().deleteNamespacedPod({ namespace, name: sessionPodName(id), gracePeriodSeconds: 0 })
    console.log(`Requested deletion of injection pod ${sessionPodName(id)} in namespace ${namespace}.`)
  } catch (error) {
    if (kubernetesErrorStatus(error) !== 404) throw error
  }
}

function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

async function startInjectionSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    return sendJson(response, 405, { error: 'Use POST to start an injection session.' })
  }
  let id: string | undefined
  try {
    const payload = await readRequestBody(request)
    id = isRecord(payload) && validSessionId(payload.id) ? payload.id.toLowerCase() : undefined
    
    if (!id) return sendJson(response, 400, { error: 'A valid injection session ID is required.' })

    await attachInjectionSession(id)
    return sendJson(response, 200, { id, ready: true })
  } catch (error) {
    const httpError = error as HttpError
    console.error(`Could not start injection session: ${httpError.message}`)
    if (id) {
      try { await deleteInjectionSession(id) } catch (cleanupError) {
        console.error(`Could not clean up failed injection session ${id}: ${(cleanupError as Error).message}`)
      }
    }
    return sendJson(response, httpError.status || 503, { error: httpError.message || 'Could not start the injection pod.' })
  }
}

async function endInjectionSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    return sendJson(response, 405, { error: 'Use POST to end an injection session.' })
  }
  try {
    const payload = await readRequestBody(request)
    const id = isRecord(payload) && validSessionId(payload.id) ? payload.id.toLowerCase() : undefined
    if (!id) return sendJson(response, 400, { error: 'A valid injection session ID is required.' })
    // A tab can close while the start request is still creating the pod. Wait for
    // that work to settle so cleanup cannot race ahead of pod creation.
    const pendingStart = injectionSessionStarts.get(id)
    if (pendingStart) await pendingStart.catch(() => undefined)
    await deleteInjectionSession(id)
    return sendJson(response, 200, { stopped: true })
  } catch (error) {
    const httpError = error as HttpError
    console.error(`Could not delete injection session: ${httpError.message}`)
    return sendJson(response, httpError.status || 503, { error: 'Could not delete the injection pod.' })
  }
}

async function heartbeatInjectionSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    return sendJson(response, 405, { error: 'Use POST to renew an injection session.' })
  }
  try {
    const payload = await readRequestBody(request)
    const id = isRecord(payload) && validSessionId(payload.id) ? payload.id.toLowerCase() : undefined
    if (!id) return sendJson(response, 400, { error: 'A valid injection session ID is required.' })
    await attachInjectionSession(id)
    return sendJson(response, 200, { active: true })
  } catch (error) {
    const httpError = error as HttpError
    return sendJson(response, httpError.status || 503, { error: httpError.message || 'Could not renew the injection pod.' })
  }
}

async function sweepInjectionPods(): Promise<void> {
  const namespace = getKubernetesNamespace()
  const now = Date.now()
  // Browser close events are best-effort. Treat heartbeats as a short lease so
  // sessions are reclaimed promptly even when the browser cannot send its beacon.
  const idleTimeout = Number(process.env.INJECTION_IDLE_TIMEOUT_MS || 3 * 60_000)
  const orphanTimeout = Number(process.env.INJECTION_ORPHAN_TIMEOUT_MS || 60 * 60_000)

  for (const session of injectionSessions.values()) {
    if (now - session.lastSeenAt > idleTimeout) {
      try {
        await deleteInjectionSession(session.id)
        console.log(`Removed idle injection pod ${session.podName}`)
      } catch (error) {
        console.error(`Could not remove idle injection pod ${session.podName}: ${(error as Error).message}`)
      }
    }
  }

  try {
    const pods = await getKubernetesApi().listNamespacedPod({
      namespace,
      labelSelector: `${INJECTION_LABEL},${MANAGED_LABEL}=${MANAGED_VALUE}`,
    })
    for (const pod of pods.items || []) {
      const id = pod.metadata?.labels?.[SESSION_LABEL]
      const createdAt = pod.metadata?.creationTimestamp?.getTime() ?? now
      if (id && !injectionSessions.has(id) && now - createdAt > orphanTimeout) {
        await deleteInjectionSession(id)
        console.log(`Removed orphaned injection pod ${pod.metadata?.name || id}`)
      }
    }
  } catch (error) {
    console.error(`Injection pod cleanup sweep failed: ${(error as Error).message}`)
  }
}

function apiUrl(baseUrl: string, path: string): URL {
  return new URL(`/api/${path.replace(/^\/+/, '')}`, baseUrl)
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



async function invokeOpenCode(request: IncomingMessage, response: ServerResponse): Promise<void> {
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

async function getInjectionDirectory(request: IncomingMessage, response: ServerResponse): Promise<void> {
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

const mimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
}

async function yo(request: IncomingMessage, response: ServerResponse) {
  console.log("yo")
}

function serveBuiltApp(request: IncomingMessage, response: ServerResponse): void {
  if (!existsSync(join(distDirectory, 'index.html'))) {
    return sendJson(response, 503, { error: 'Build the frontend with npm run build before starting the production server.' })
  }

  let pathname
  try {
    pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname)
  } catch {
    return sendJson(response, 400, { error: 'Invalid URL.' })
  }

  const candidate = resolve(distDirectory, `.${pathname}`)
  if (candidate !== distDirectory && !candidate.startsWith(`${distDirectory}${sep}`)) {
    return sendJson(response, 403, { error: 'Forbidden.' })
  }

  const file = existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : join(distDirectory, 'index.html')
  response.writeHead(200, { 'Content-Type': mimeTypes[extname(file)] || 'application/octet-stream' })
  createReadStream(file).pipe(response)
}

const port = Number(process.env.PORT || 3001)
const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  let pathname
  try {
    pathname = new URL(request.url || '/', 'http://localhost').pathname
  } catch {
    return sendJson(response, 400, { error: 'Invalid URL.' })
  }

  if (pathname === '/api/injection/session/start') {
    void startInjectionSession(request, response)
    return
  }
  if (pathname === '/api/injection/session/end') {
    void endInjectionSession(request, response)
    return
  }
  if (pathname === '/api/injection/session/heartbeat') {
    void heartbeatInjectionSession(request, response)
    return
  }
  if (pathname === '/api/invoke') {
    void invokeOpenCode(request, response)
    return
  }
  if (pathname === '/api/injection/session/directory') {
    void getInjectionDirectory(request, response)
    return
  }
  if (pathname.startsWith('/api/yo')) {
    void yo(request, response)
    return
  }
    
  if (pathname.startsWith('/api/')) return sendJson(response, 404, { error: 'API route not found.' })
  serveBuiltApp(request, response)
  
})

const host = process.env.HOST || '127.0.0.1'
server.listen(port, host, () => {
  console.log(`API bridge listening on http://${host}:${port}`)
})

const cleanupTimer = setInterval(() => { void sweepInjectionPods() }, 15_000)
cleanupTimer.unref()
