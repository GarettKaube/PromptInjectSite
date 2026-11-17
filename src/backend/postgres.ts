import dotenv from 'dotenv'
import { Pool } from 'pg'
import cron from 'node-cron'


dotenv.config();


const pool = new Pool( {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: Number(process.env.DB_PORT),
});


type DirectPIDataRecord = {
    sessionid: string, 
    time: Date,
    task: string,
    uned_prompt: string,

    // the injected prompt. 
    // Can be multiple strings at multiple locations in the text
    inj_prompt: string[], 

    // Must keep track of where the injected text is placed
    inj_position: string,
    model: string, // What model was prompted
    model_output?: string,
    model_tool_calls?: string
}

async function verifyConnection(): Promise<void> {
  try {
    // Attempt to acquire a client from the pool
    const client = await pool.connect();
    console.log('Connected to PostgreSQL database');
    client.release(); // Release the client back to the pool
  } catch (error) {
    console.error('Error connecting to the database:', error);
  }
}

async function writeJSONtoDB(taskAttempt: DirectPIDataRecord): Promise<void> {
    const query: string = `
    INSERT INTO direct_pi_attempts 
        (data) 
        VALUES ($1::jsonb)
    `;

    try {
        await pool.query(query,
        [JSON.stringify(taskAttempt)]
    );
    } catch (error) {
        console.error('Error putting DIAttempt to database:', error);
    }
}

