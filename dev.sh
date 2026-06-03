#!/usr/bin/env bash
# Local dev launcher for event-scout.
#
# Starts the ngrok tunnel (fixed static domain) + the bot, cleanly:
#   - kills any stale bot/ngrok first
#   - waits for Telegram to release the previous getUpdates poll lock
#     (avoids the 409 conflict churn on restart)
#   - confirms the public URL serves the Mini App
#
# Usage:  ./dev.sh
# Stop:   ./dev.sh stop   (or Ctrl-C if run in the foreground)
#
# NOTE: a 409 conflict that PERSISTS means another instance is polling the
# same bot token (e.g. a Railway deployment). Stop that deployment.

set -euo pipefail
cd "$(dirname "$0")"

NGROK_DOMAIN="amaze-matrimony-hardwood.ngrok-free.dev"
PORT=3000
MINIAPP_URL="https://${NGROK_DOMAIN}/miniapp"

stop() {
  echo "[dev] stopping bot + ngrok…"
  pkill -TERM -f "telegramBot" 2>/dev/null || true
  sleep 5
  pkill -9 -f "telegramBot" 2>/dev/null || true
  pkill -f "ngrok http" 2>/dev/null || true
  echo "[dev] stopped."
}

if [[ "${1:-}" == "stop" ]]; then stop; exit 0; fi

# 1) clean slate
stop

# 2) ensure MINIAPP_URL is set in .env.local
if grep -q '^MINIAPP_URL=' .env.local 2>/dev/null; then
  python3 - "$MINIAPP_URL" <<'PY'
import re,sys
url=sys.argv[1]; p=".env.local"; s=open(p).read()
s=re.sub(r'(?m)^MINIAPP_URL=.*$', f'MINIAPP_URL={url}', s)
open(p,"w").write(s)
PY
else
  echo "MINIAPP_URL=${MINIAPP_URL}" >> .env.local
fi
echo "[dev] MINIAPP_URL = ${MINIAPP_URL}"

# 3) start ngrok on the fixed domain
echo "[dev] starting ngrok on ${NGROK_DOMAIN}…"
nohup ngrok http --domain="${NGROK_DOMAIN}" "${PORT}" > /tmp/ngrok.log 2>&1 &
disown
sleep 5

# 4) wait for Telegram to release the previous poll lock, then start the bot
echo "[dev] waiting 45s for Telegram poll lock to release…"
sleep 45
echo "[dev] starting bot…"
nohup npm start > /tmp/eventscout-bot.log 2>&1 &
disown
sleep 16

# 5) verify
echo "[dev] --- status ---"
grep -iE "Running as|menu button set|listening" /tmp/eventscout-bot.log | tail -3 || true
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "${MINIAPP_URL}/profile.html" || echo 000)
echo "[dev] public profile.html → HTTP ${code}"
[[ "${code}" == "200" ]] && echo "[dev] ✅ ready — open the bot and tap a button" || echo "[dev] ⚠️ tunnel/app not responding; check /tmp/ngrok.log and /tmp/eventscout-bot.log"
