#!/bin/bash
set -e

echo "Starting Ollama..."
ollama serve &
for i in $(seq 1 30); do
  curl -sf http://localhost:11434 >/dev/null && break
  sleep 1
done
echo "Ollama ready."

exec node server.js
