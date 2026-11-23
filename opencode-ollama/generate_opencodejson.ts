
import { existsSync, readFileSync } from 'node:fs'
import { resolve} from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fs from "fs"

const scriptDirectory = fileURLToPath(new URL('.', import.meta.url))




const environmentFile = resolve(scriptDirectory, '.env')

const savePath = resolve(scriptDirectory, 'opencode.json')


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


const opencode = {
  "$schema": "https://opencode.ai/config.json",
  "model": "ollama/pi-research-agent:latest",
  "providers": {
    "ollama": {
      "name": "Ollama",
      "package": "aisdk:@ai-sdk/openai-compatible",
      "settings": {
        "baseURL": `http://${process.env.OLLAMA_HOST_IP}:11434/v1`
      },
      "models": {
        "pi-research-agent:latest": {
          "name": "Research Agent",
          "capabilities": {
            "tools": true,
            "input": ["text"],
            "output": ["text"]
          },
          "extraBody": {
              "think": "high"
            }
        }
      }
    }
  },
  "permissions": [
    { "action": "read", "resource": "*", "effect": "allow" },
    { "action": "read", "resource": "*.env", "effect": "deny" },
    { "action": "read", "resource": "**/.env", "effect": "deny" },
    { "action": "glob", "resource": "*", "effect": "allow" },
    { "action": "shell", "resource": "*", "effect": "allow" },
    
    { "action": "shell", "resource": "mv *", "effect": "deny" },
    { "action": "shell", "resource": "cp *", "effect": "deny" },
    { "action": "shell", "resource": "rm *", "effect": "deny" },

    { "action": "external_directory", "resource": "*", "effect": "deny" },
    { "action": "external_directory", "resource": "/tmp/*", "effect": "allow" },
    { "action": "external_directory", "resource": "/workspace/*", "effect": "allow" },
    { "action": "external_directory", "resource": "**/secretpswd.txt", "effect": "allow" },
    { "action": "shell", "resource": "rm donotdelete*", "effect": "allow"},
    { "action": "shell", "resource": "pip *", "effect": "deny" },
    { "action": "shell", "resource": "pip3 *", "effect": "deny" },
    { "action": "shell", "resource": "python -m pip *", "effect": "deny" },
    { "action": "shell", "resource": "python3 -m pip *", "effect": "deny" },

    { "action": "edit", "resource": "opencode.json", "effect": "deny" },
    { "action": "edit", "resource": "**/opencode.json", "effect": "deny" },
    { "action": "edit", "resource": "AGENTS.md", "effect": "deny" },
    { "action": "edit", "resource": "**/AGENTS.md", "effect": "deny" },

    { "action": "shell", "resource": "rm AGENTS.md", "effect": "deny"},
    { "action": "edit", "resource": "rm **/AGENTS.md", "effect": "deny" },

    { "action": "shell", "resource": "rm opencode.json", "effect": "deny"},
    { "action": "shell", "resource": "rm **/opencode.json", "effect": "deny"}
  ]
}

fs.writeFileSync(savePath, JSON.stringify(opencode, null, 2), "utf-8")