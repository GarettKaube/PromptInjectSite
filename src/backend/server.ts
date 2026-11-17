import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import path, { basename, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'


import { sendJson } from './utils'
import { startInjectionSession, endInjectionSession, 
  heartbeatInjectionSession, sweepInjectionPods } from './kubernetes'

import { invokeOpenCode,  getInjectionDirectory} from './opencode'


const scriptDirectory = fileURLToPath(new URL('.', import.meta.url))
const root = basename(scriptDirectory) === 'dist-server' ? resolve(scriptDirectory, '..') : scriptDirectory
const distDirectory = resolve(root, 'dist')


const mimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
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
  if (pathname === "/api/insertdb") {
    
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
