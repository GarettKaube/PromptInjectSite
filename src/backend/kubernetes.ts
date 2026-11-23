import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { basename, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KubeConfig } from '@kubernetes/client-node'
import { CoreV1Api, type V1Pod } from '@kubernetes/client-node/dist/gen/index.js'
import { sendJson, readRequestBody, isRecord, HttpError, NewPodReservation, apiUrl } from './utils'
import { insertPodReservation, PodReservation, updatePodReservation, deletePodReservation, getCreatedAt, getNumSessionsByIP } from './postgres'
import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'

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


const scriptDirectory = fileURLToPath(new URL('.', import.meta.url))
const root = basename(scriptDirectory) === 'dist-server' ? resolve(scriptDirectory, '..') : scriptDirectory
const environmentFile = resolve(root, '.env')


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


function hashClientIp(ip: string): string {
  const secret = process.env.IP_HASH_SECRET
  if (!secret) throw new Error('IP_HASH_SECRET is missing')

  // Normalize IPv4-mapped IPv6 so it hashes the same as plain IPv4.
  const normalizedIp = ip.replace(/^::ffff:/i, '')
  if (!isIP(normalizedIp)) throw new Error('Invalid client IP')

  return createHmac('sha256', secret)
    .update(normalizedIp)
    .digest('hex')
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

export async function attachInjectionSession(id: string): Promise<InjectionSession> {
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

export function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

export async function startInjectionSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    return sendJson(response, 405, { error: 'Use POST to start an injection session.' })
  }
  let id: string | undefined
  let hashed_ip : string | undefined


  try {
    const payload = await readRequestBody(request)
    id = isRecord(payload) && validSessionId(payload.id) ? payload.id.toLowerCase() : undefined
    
    if (!id) return sendJson(response, 400, { error: 'A valid injection session ID is required.' })
    const clientIp = request.headers['x-real-ip'] ?? request.socket.remoteAddress
    
    if (typeof clientIp !== "string") return sendJson(response, 400, { error: 'client IP is not a string' })
    
    hashed_ip = hashClientIp(clientIp)

    const session_ip = {
      sessionId: id,
      ownerIpHash: hashed_ip,
    }
    // reserve the ip for the session
    await insertPodReservation(session_ip)

    // number of sessions currently for the IP
    const num_sessions = await getNumSessionsByIP(session_ip)

    
    const limit = Number(process.env.IP_SESSION_LIMIT)
    
        
    // prevent users from creating more pods if maximum number of pds for
    // ip is reached
    if (num_sessions > limit) {
      await deletePodReservation(session_ip)

      return sendJson(response, 400, { error: 'Maximum number of sessions reached' })
    } 

    // attack session to the id
    await attachInjectionSession(id)

    await updatePodReservation( {
      sessionId: id,
      ownerIpHash: hashed_ip,
      podName: sessionPodName(id),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date()
    })

    return sendJson(response, 200, { id, ready: true })
  } catch (error) {
    const httpError = error as HttpError
    console.error(`Could not start injection session: ${httpError.message}`)
    console.error(error)
    if (id && hashed_ip) {
      try { 
        await deleteInjectionSession(id) 
        
        await deletePodReservation({
          sessionId: id,
          ownerIpHash: hashed_ip,
        })

      } catch (cleanupError) {
        console.error(`Could not clean up failed injection session ${id}: ${(cleanupError as Error).message}`)
      }
    }
    return sendJson(response, httpError.status || 503, { error: httpError.message || 'Could not start the injection pod.' })
  }
}

export async function endInjectionSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    return sendJson(response, 405, { error: 'Use POST to end an injection session.' })
  }
  let hashed_ip : string | undefined

  try {
    const payload = await readRequestBody(request)
    const id = isRecord(payload) && validSessionId(payload.id) ? payload.id.toLowerCase() : undefined
    if (!id) return sendJson(response, 400, { error: 'A valid injection session ID is required.' })
    // A tab can close while the start request is still creating the pod. Wait for
    // that work to settle so cleanup cannot race ahead of pod creation.
    const pendingStart = injectionSessionStarts.get(id)
    if (pendingStart) await pendingStart.catch(() => undefined)
    const clientIp = request.headers['x-real-ip'] ?? request.socket.remoteAddress
    
    if (typeof clientIp !== "string") return sendJson(response, 400, { error: 'Could not delete pod session from postgres, client IP is not a string' })
    hashed_ip = hashClientIp(clientIp)

    
    try {
      const res = await getCreatedAt({
        sessionId: id,
        ownerIpHash: hashed_ip
      })
      await updatePodReservation({
        sessionId: id,
        ownerIpHash: hashed_ip,
        podName: sessionPodName(id),
        status: "deleting",
        createdAt: res.createdAt,
        updatedAt: new Date()
      })
    } catch (error) {
      console.error("Failed to update during deleting", error)
    }
    
    const id_to_delete = id
    await deleteInjectionSession(id)
    
    try {
      await deletePodReservation({
        sessionId: id_to_delete,
        ownerIpHash: hashed_ip
    }
    )
    } catch (error) {
      console.error("Failed to delete from pg during deleting")
    }
    
    return sendJson(response, 200, { stopped: true })
  } catch (error) {
    console.error("could not delete pod",error)
    const httpError = error as HttpError
    console.error(`Could not delete injection session: ${httpError.message}`)
    return sendJson(response, httpError.status || 503, { error: 'Could not delete the injection pod.' })
  }
}

export async function heartbeatInjectionSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
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

export async function sweepInjectionPods(): Promise<void> {
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
        await deletePodReservation({
          sessionId: session.id,
          ownerIpHash: ''
          })
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

export async function cleanUpAllPods() {
  const namespace = getKubernetesNamespace()
  const coreAPI = getKubernetesApi()
  
  const response = await coreAPI.listNamespacedPod( {
      namespace: namespace
  })

  for (const pod of response.items) {
      const podName = pod.metadata?.name
      if (podName) {
          try {
              await coreAPI.deleteNamespacedPod({
                  name: podName,
                  namespace: namespace
              })
              console.log( `cleaning up: ${podName}`)
          } catch (error) {
              console.error(`Failed to delete pd ${podName}:`, error)
              throw error
          }
      } 
  }
}