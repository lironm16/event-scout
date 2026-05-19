# Event Scout

Monitors Smarticket events and syncs ticket data to Supabase. Detects when sold-out events get new tickets.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

3. Create an `events` table in your Supabase project:

```sql
create table events (
  id          text primary key,
  name        text not null,
  date        timestamptz,
  venue       text,
  tickets_left integer not null default 0,
  url         text,
  updated_at  timestamptz default now()
);
```

4. Run the checker:

```bash
npm run check
```

## Newsletter + Google Calendar

The bot delivers personalised event alerts on an **immediate-with-5-min-buffer**
cadence: as soon as a newly-discovered event qualifies for a user
(audience/age/access/proximity/no series-suppression), it lands in
that user's buffer. After 5 minutes the buffer flushes — as a single
card (1 event) or as a multi-select newsletter (≥ 2 events).
Low-stock alerts (≤10 tickets) bypass the buffer entirely. Users can
mark batches for bulk actions and add them straight into Google
Calendar.

### Database migrations

Apply (in order) before the newsletter / calendar features start working:

```sql
-- sql/047_newsletter_state.sql — newsletter delivery state,
-- low-stock dedup, events.first_seen_at column.
-- sql/048_google_oauth.sql — google_oauth_tokens table for the
-- per-user Calendar integration.
```

### Google Calendar OAuth

To enable the "📅 הוסיפי ליומן" bulk action in the newsletter:

1. In [Google Cloud Console](https://console.cloud.google.com):
   - Enable the **Google Calendar API**.
   - Create an **OAuth 2.0 Client ID** (type: Web application).
   - Add an **Authorized redirect URI** matching your deployment:
     - Production (Railway): `https://<your-app>.up.railway.app/oauth/google/callback`
     - Local dev (via ngrok / cloudflared): `https://<your-tunnel>/oauth/google/callback`
2. Set the three env vars in `.env` (or Railway variables):
   - `GOOGLE_OAUTH_CLIENT_ID`
   - `GOOGLE_OAUTH_CLIENT_SECRET`
   - `GOOGLE_OAUTH_REDIRECT_URI`
3. Restart the bot. `lib/oauthServer.js` will boot on `$PORT` (Railway
   provides this automatically; local default is `3000`).
4. In Telegram: `/connect_calendar` → tap the **Google התחברות** button
   → grant access. The bot replies with a ✅ confirmation once tokens
   land.

### Newsletter commands

- `/newsletter_off` — pause delivery for your account (low-stock
  alerts continue independently).
- `/newsletter_on` — re-enable it.
- `/newsletter_now` — admin only (`TELEGRAM_CHAT_ID`). Forces an
  immediate digest delivery to the caller across the
  "new-since-`last_sent_at`" window, useful for testing copy /
  content. Bumps `last_sent_at` like a normal delivery would.

### Filtering: "I know this event" (recurring suppression)

Tapping `❌ לא מתאים → 🔁 מכירה — אירוע חוזר` on any card writes the
event's series identity (`name + location_key`) into
`profile.user_context.known_series`. Future buffers + digests
suppress every event whose series key matches. Cap is FIFO 100 per
user — the most recent suppressions stay; the oldest get evicted
when the list overflows.

### Low-stock alerts

Independent of the weekly digest: any event whose stock crosses to
**≤ 10 tickets** triggers an immediate push to interested users
(per-event watchers + saved-search topic matches). Dedup is per
`(event_id, telegram_id)` so a stock value bouncing around the
threshold never re-pings the same user.
