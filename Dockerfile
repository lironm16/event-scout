# syntax=docker/dockerfile:1.7
#
# Production image for the Event-Scout Telegram bot.
#
# Why this shape:
#   - Two stages: install deps in a builder, copy node_modules into a
#     slim runtime. The runtime never touches npm — smaller, faster
#     boot, and no leftover npm cache in the final image.
#   - Pure JS — no compile step. The bot runs `node bot/telegramBot.js`
#     directly. (Project is JavaScript end-to-end; there is no
#     TypeScript build to run on Railway.)
#   - PUPPETEER_SKIP_DOWNLOAD=true at install time blocks the
#     whatsapp-web.js → puppeteer dependency from pulling Chromium
#     (~200MB) into the image. The bot doesn't load that scraper, so
#     we save space and install time without losing anything.
#   - Telegraf long-polls Telegram; Express listens on $PORT for
#     /health, /miniapp, and OAuth. HTTP starts at boot (before launch).
#   - bot/telegramBot.js installs SIGTERM / SIGINT handlers that flush
#     in-flight updates before exit. We invoke node via exec-form CMD
#     so the signals Railway sends reach node directly (no shell
#     wrapper to swallow them).

# ─── Stage 1: dependencies ─────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Skip Chromium download (transitive puppeteer via whatsapp-web.js)
# and lock npm to prod-only resolution.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    NPM_CONFIG_PRODUCTION=true \
    NODE_ENV=production

COPY package.json package-lock.json ./

# `npm ci` enforces the lockfile — reproducible installs on every
# build. `--omit=dev` is belt-and-braces with NPM_CONFIG_PRODUCTION;
# either alone would do the job, both is a defense against future
# devDependency additions creeping into the runtime.
RUN npm ci --omit=dev


# ─── Stage 2: runtime ──────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Asia/Jerusalem keeps `new Date()` and Luxon "local" times consistent
# with how the scheduler / event dates are produced and consumed.
# `tzdata` ships timezone definitions; Alpine doesn't include them by
# default.
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Jerusalem /etc/localtime && \
    echo "Asia/Jerusalem" > /etc/timezone

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    TZ=Asia/Jerusalem

COPY --from=deps /app/node_modules ./node_modules
# Copy source last so changes to .js files don't bust the deps cache.
COPY --chown=node:node . .

# Drop root — node's official Alpine image already provides a
# non-privileged `node` user.
USER node

# Exec form (JSON array) so SIGTERM/SIGINT reach node directly. The
# bot's gracefulShutdown handler stops polling and drains in-flight
# updates within a 15s window before exit.
CMD ["node", "bot/telegramBot.js"]
