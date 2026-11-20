import type { DirectPIDataRecord } from '../backend/postgres.ts'




export async function sendPostgres(taskAttempt: DirectPIDataRecord): Promise<void> { 
    console.log(JSON.stringify(taskAttempt))   
    const response = await fetch('/api/insertdb', {
        'method': 'POST',
        'headers': {'Content-Type': 'application/json'},
        'body': JSON.stringify(taskAttempt)
    })
    
    const raw = await response.text()
    const payload = await response.json().catch(() => ({})) as Partial<unknown> & { error?: string }
    if (!response.ok) {
        console.error(`Postgress insert request returned ${response.status}: ${raw}`)
        throw new Error(payload.error || `postgres request failed (${response.status})`)
    }
}