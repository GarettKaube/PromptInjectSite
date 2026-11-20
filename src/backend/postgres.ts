import { Pool } from 'pg'
import type { ToolCall } from '../front-end/InvokeRequest.ts'
import { sendJson, readRequestBody, isRecord} from './utils'
import { type IncomingMessage, type ServerResponse } from 'node:http'



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

    console.log(body)
    try {
        await pool.query(query, [JSON.stringify(body)]);
        return sendJson(response, 200, JSON.stringify("Succesfully inserted data into db."))

    } catch (error) {
        console.error('Error putting DIAttempt to database:', error);
        return sendJson(response, 400, { error: 'Error inserting data.' })
    }
}

