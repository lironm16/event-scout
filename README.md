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
