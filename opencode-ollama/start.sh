#!/bin/sh
set -eu
# ollama serve &
# OLLAMA_PID=$!
# trap 'kill "$OLLAMA_PID" 2>/dev/null || true' EXIT INT TERM
# n=0
# until curl -fsS http://127.0.0.1:11434/api/tags >/dev/null; do
#   n=$((n+1))
#   if [ "$n" -ge 60 ]; then echo 'Ollama did not start' >&2; exit 1; fi
#   sleep 2
# done
# if ! ollama list | grep -q '^qwen3:8b[[:space:]]'; then
#   ollama pull qwen3:8b
# fi
# ollama create pi-research-agent:latest -f /opt/ollama/Modelfile
exec opencode serve --hostname 0.0.0.0 --port 4096
