

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


async function sendPostgres(taskAttempt: DirectPIDataRecord): Promise<void> {    
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