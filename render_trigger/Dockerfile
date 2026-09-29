FROM node:20-bookworm

# Xvfb for headed Chrome (X bot-detects real headless mode - see project_trend_monitor memory).
# git for cloning the code+data repo at container boot.
RUN apt-get update && apt-get install -y xvfb git curl ca-certificates zstd && rm -rf /var/lib/apt/lists/*

# Ollama, baked into the image with the model already pulled - Render's free tier disk is
# ephemeral across restarts, so pulling the ~2GB model at every cold boot would make wake-ups
# painfully slow. Doing it at build time means it's part of the image layer, not the runtime
# container's writable layer, so it survives sleep/wake cycles for free.
RUN curl -fsSL https://ollama.com/install.sh | sh
RUN (ollama serve &) && sleep 5 && ollama pull qwen2.5:3b

WORKDIR /app

# Minimal package.json just for this trigger service - only needs playwright (for
# doom_scroll_agent.js, fetched fresh from the repo at boot) and nothing else.
COPY package.json ./
RUN npm install
RUN npx playwright install --with-deps chromium

COPY server.js entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 10000
CMD ["./entrypoint.sh"]
