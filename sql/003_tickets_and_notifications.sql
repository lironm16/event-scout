-- Tickets scraped from WhatsApp groups
CREATE TABLE IF NOT EXISTS tickets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_message_id   TEXT UNIQUE,
  group_id        TEXT NOT NULL,
  event_title     TEXT NOT NULL,
  event_date      DATE,
  event_time      TIME,
  quantity        INTEGER NOT NULL DEFAULT 1,
  price           TEXT,
  seller_phone    TEXT,
  seller_name     TEXT,
  image_url       TEXT,
  raw_text        TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_tickets_status ON tickets (status);
CREATE INDEX idx_tickets_group ON tickets (group_id);
CREATE INDEX idx_tickets_created ON tickets (created_at DESC);

-- Notification queue for quiet hours / Shabbat
CREATE TABLE IF NOT EXISTS pending_notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id     TEXT NOT NULL REFERENCES profiles(telegram_id),
  ticket_id       UUID REFERENCES tickets(id),
  message_text    TEXT NOT NULL,
  image_url       TEXT,
  reason          TEXT,
  send_after      TIMESTAMPTZ NOT NULL,
  sent_at         TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_pending_status ON pending_notifications (status, send_after);
CREATE INDEX idx_pending_user ON pending_notifications (telegram_id);

-- Click tracking for "Contact Seller" deep links
CREATE TABLE IF NOT EXISTS click_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id     TEXT NOT NULL,
  ticket_id       UUID NOT NULL REFERENCES tickets(id),
  clicked_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_clicks_ticket ON click_log (ticket_id);

-- Add is_shabbat_observant to profiles
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_shabbat_observant BOOLEAN NOT NULL DEFAULT false;

-- Auto-update updated_at on tickets
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tickets_updated
  BEFORE UPDATE ON tickets
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

GRANT ALL ON tickets TO postgres, anon, authenticated, service_role;
GRANT ALL ON pending_notifications TO postgres, anon, authenticated, service_role;
GRANT ALL ON click_log TO postgres, anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
