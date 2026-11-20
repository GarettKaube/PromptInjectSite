import { Pool } from 'pg'
import type { ToolCall } from '../front-end/InvokeRequest.ts'
import { sendJson, readRequestBody, isRecord, type HttpError} from './utils'
import { type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { resolve} from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = fileURLToPath(new URL('.', import.meta.url))

const srcDirectory = resolve(scriptDirectory, '..')
const root =  resolve(srcDirectory, '..') 


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

export type DirectPIDataRecord = {
    sessionid: string, 
    time: Date,
    task: string,
    uned_prompt: string,

    inj_prompt: string[], 
    complete_prompt: string,

    // Must keep track of where the injected text is placed
    inj_position_str: string[],

    model: string, // Which model was prompted
    model_output?: string,
    model_tool_calls?: ToolCall[]
}

export async function verifyConnection(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const pool = new Pool( {
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: Number(process.env.DB_PORT),
    });

    const client = await pool.connect();
    console.log('Connected to PostgreSQL database');
    client.release(); // Release the client back to the pool
    return sendJson(response, 200, JSON.stringify('Connected to PostgreSQL database'))

  } catch (error) {
    console.error('Error connecting to the database:', error);
    const httpError = error as HttpError
    return sendJson(response, httpError.status || 400, { error: httpError.message })
  }
}

export async function writeJSONtoDB(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const password = process.env.DB_PASSWORD;

    if (typeof password !== "string" || password.length === 0) {
        throw new Error("DB_PASSWORD is missing");
    };

    const pool = new Pool( {
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: Number(process.env.DB_PORT),
    });

    if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST')
        return sendJson(response, 405, { error: 'Use POST to send a prompt.' })
    }

    let body: unknown
    try {
        body = await readRequestBody(request)
    } catch (error) {
        const httpError = error as HttpError
        return sendJson(response, httpError.status || 400, { error: httpError.message })
    }
    if (!isRecord(body) || typeof body.uned_prompt !== 'string' || !body.uned_prompt.trim()) {
        return sendJson(response, 400, { error: 'A non-empty prompt is required.' })
    }
    

    const query: string = `
    INSERT INTO direct_pi_attempts 
        (data) 
        VALUES ($1::jsonb)
    `;

    
    try {
        await pool.query(query, [JSON.stringify(body)]);
        return sendJson(response, 200, JSON.stringify("Succesfully inserted data into db."))

    } catch (error) {
        
        console.error('Error putting DIAttempt to database:', error);
        console.error("Request body that generated error:", body)
        return sendJson(response, 400, { error: 'Error inserting data.' })
    }
}

export type ReservationStatus = 'starting' | 'active' | 'deleting'


export interface NewPodReservation {
  sessionId: string
  ownerIpHash: string
  podName?: string
  status?: ReservationStatus
}

export interface PodReservation extends NewPodReservation {
  createdAt: Date
  updatedAt: Date
}


const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: Number(process.env.DB_PORT),
})

export async function insertPodReservation(
  reservation: NewPodReservation,
): Promise<PodReservation> {
  
  const { rows } = await pool.query<PodReservation>(
    `INSERT INTO injection_pod_reservations
       (session_id, owner_ip_hash, pod_name, status)
     VALUES ($1, $2, $3, $4)
     RETURNING
       session_id AS "sessionId",
       owner_ip_hash AS "ownerIpHash",
       pod_name AS "podName",
       status,
       created_at AS "createdAt",
       updated_at AS "updatedAt"`,
    [
      reservation.sessionId,
      reservation.ownerIpHash,
      reservation.podName ?? null,
      reservation.status ?? 'starting',
    ],
  )

  if (!rows[0]) throw new Error('Reservation insert returned no row.')
  return rows[0]
}


export async function updatePodReservation(
  reservation: PodReservation,
): Promise<PodReservation> {
  console.log("updatePodReservation:", reservation)
  const { rows } = await pool.query<PodReservation>(
    `UPDATE injection_pod_reservations
       SET status = $1,
           created_at = $2,
           updated_at = $3,
           pod_name = $4
     WHERE owner_ip_hash = $5 AND session_id = $6

     RETURNING
       session_id AS "sessionId",
       owner_ip_hash AS "ownerIpHash",
       pod_name AS "podName",
       status,
       created_at AS "createdAt",
       updated_at AS "updatedAt"`,
    [
      reservation.status,
      reservation.createdAt,
      reservation.updatedAt,
      reservation.podName,
      reservation.ownerIpHash,
      reservation.sessionId,
    ],
  )

  if (!rows[0]) throw new Error('Reservation update returned no row.')
  return rows[0]
}

export async function deletePodReservation(
  reservation: NewPodReservation,
): Promise<void> {
  console.log("deletePodReservation", reservation)
  await pool.query<PodReservation>(
    `DELETE FROM  injection_pod_reservations
     WHERE session_id = $1`,
    [
      reservation.sessionId,
    ],
  )
}

export async function getCreatedAt(
  reservation: NewPodReservation,
): Promise<PodReservation> {
  console.log("getCreatedAt Reservation:", reservation)
  const { rows } = await pool.query<PodReservation>(
    `SELECT created_at AS "createdAt"
     FROM injection_pod_reservations
     WHERE session_id = $1 AND owner_ip_hash = $2

    `,
    [
      reservation.sessionId,
      reservation.ownerIpHash
    ],
  )

  if (!rows[0]) throw new Error('getCreatedAt returned no row.', rows)
  return rows[0]
}


export async function getNumSessionsByIP(
  reservation: NewPodReservation,
): Promise<number> {
  const { rows } = await pool.query<PodReservation>(
    `SELECT 
       COUNT(session_id) AS "session_count"
     FROM injection_pod_reservations
     WHERE owner_ip_hash = $1
    `,
    [
      reservation.ownerIpHash
    ],
  )

  if (!rows[0]) throw new Error('getNumSessionsByIP returned no row.', rows)
  return rows[0].session_count
}