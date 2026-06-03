#!/usr/bin/env bash
# Local dev launcher for event-scout.
#
# Starts the ngrok tunnel (fixed static domain) in the background, then runs
# the bot IN THE FOREGROUND so its logs stream live in your terminal.
# Ctrl-C stops the bot AND the tunnel.
#
# Why this avoids the 409 churn: it kills any stale bot/ngrok first and waits
# for Telegram to release the previous getUpdates poll lock before starting,
# so you can never end up with two local instances fighting.
#
# Usage:  ./dev.sh          # start (foreground, live logs; Ctrl-C to stop)
#         ./dev.sh stop     # stop a previously running bot + ngrok
#
# NOTE: a 409 that PERSISTS even after a clean start means ANOTHER machine is
# polling the same bot token (e.g. a Railway deployment). Stop that one.

set -uo pipefail
cd "$(dirname "$0")"

NGROK_DOMAIN="amaze-matrimony-hardwood.ngrok-free.dev"
PORT=3000
MINIAPP_URL="https://${NGROK_DOMAIN}/miniapp"

kill_all() {
  pkill -TERM -f "telegramBot" 2>/dev/null || true
  sleep 5
  pkill -9 -f "telegramBot" 2>/dev/null || true
  pkill -f "ngrok http" 2>/dev/null || true
}

if [[ "${1:-}" == "stop" ]]; then
  echo "[dev] stopping bot + ngrok…"; kill_all; echo "[dev] stopped."; exit 0
fi

# 1) clean slate
echo "[dev] clearing any stale bot/ngrok…"
kill_all

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

# 3) start ngrok in the background (its own log file)
echo "[dev] starting ngrok on ${NGROK_DOMAIN}…"
nohup ngrok http --domain="${NGROK_DOMAIN}" "${PORT}" > /tmp/ngrok.log 2>&1 &
disown

# stop ngrok when the bot (foreground) exits / Ctrl-C
trap 'echo; echo "[dev] shutting down…"; pkill -f "ngrok http" 2>/dev/null || true' EXIT INT TERM

# 4) wait for Telegram to release the previous poll lock
echo "[dev] waiting 45s for Telegram poll lock to release…"
sleep 45

# 5) run the bot in the FOREGROUND — logs stream here, Ctrl-C stops it
echo "[dev] starting bot (logs below; Ctrl-C to stop everything)…"
echo "──────────────────────────────────────────────────────────────"
exec npm start
