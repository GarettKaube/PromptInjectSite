import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'


export interface HttpError extends Error {
  status?: number
}


export function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(data))
}


export async function readRequestBody(request: IncomingMessage): Promise<unknown> {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function apiUrl(baseUrl: string, path: string): URL {
  return new URL(`/api/${path.replace(/^\/+/, '')}`, baseUrl)
}

