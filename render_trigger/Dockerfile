FROM node:20-bookworm

# Xvfb for headed Chrome (X bot-detects real headless mode - see project_trend_monitor memory).
# git for cloning the code+data repo at container boot.
RUN apt-get update && apt-get install -y xvfb git ca-certificates && rm -rf /var/lib/apt/lists/*

# No local Ollama here on purpose (removed 2026-09-29): this container's free-tier RAM limit
# is 512MB total, and qwen2.5:3b's weights alone are ~1.9GB - physically cannot fit, confirmed
# live (container hung/OOM'd with zero error output once Chrome tried to launch alongside it).
# Scoring on Render uses the Groq API instead (see GROQ_API_KEY in doom_scroll_agent.js) - free,
# no card, and needs no local memory. GitHub Actions/local PC keep using real Ollama unchanged,
# they have the RAM for it.

WORKDIR /app

# Minimal package.json just for this trigger service - only needs playwright (for
# doom_scroll_agent.js, fetched fresh from the repo at boot) and nothing else.
COPY package.json ./
RUN npm install
# doom_scroll_agent.js launches with channel: 'chrome' (real Google Chrome, not Playwright's
# bundled Chromium) - same requirement as everywhere else in this project. Installing plain
# "chromium" here isn't enough; confirmed live 2026-09-29: "Chromium distribution 'chrome' is
# not found at /opt/google/chrome/chrome".
RUN npx playwright install --with-deps chrome

COPY server.js entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 10000
CMD ["./entrypoint.sh"]
