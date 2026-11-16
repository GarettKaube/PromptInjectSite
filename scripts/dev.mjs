import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const backend = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server.ts'], {
  cwd: root,
  env: { ...process.env, PORT: '3001' },
  stdio: 'inherit',
})
const frontend = spawn(process.execPath, ['node_modules/vite/bin/vite.js', ...process.argv.slice(2)], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
})

let shuttingDown = false
function stopChildren(signal = 'SIGTERM') {
  if (shuttingDown) return
  shuttingDown = true
  backend.kill(signal)
  frontend.kill(signal)
}

process.on('SIGINT', () => stopChildren('SIGINT'))
process.on('SIGTERM', () => stopChildren('SIGTERM'))
backend.on('exit', (code) => {
  if (!shuttingDown && code !== 0) stopChildren()
})
frontend.on('exit', (code) => {
  if (!shuttingDown && code !== 0) stopChildren()
})
