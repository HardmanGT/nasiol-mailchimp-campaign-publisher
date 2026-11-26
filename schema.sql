-- nasiol_mailchimp_campaign_publisher — D1 schema
-- Claude (marketing agent) writes campaign rows + HTML parts through the
-- Cloudflare connector. The Worker does everything else.

CREATE TABLE IF NOT EXISTS campaigns (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_key           TEXT NOT NULL UNIQUE,   -- e.g. 2026-12-03-proclub-holiday-reminder
  status                 TEXT NOT NULL DEFAULT 'loading',
  -- loading -> ready_to_build -> building -> awaiting_approval
  --   -> approved -> sending -> sent
  --   side exits: changes_requested, rejected, cancelled, failed
  title                  TEXT NOT NULL,          -- internal name shown in Mailchimp
  subject                TEXT NOT NULL,
  preview_text           TEXT,
  from_name              TEXT NOT NULL DEFAULT 'Nasiol Pro Club',
  reply_to               TEXT NOT NULL DEFAULT 'support@nasiolusaproclub.com',
  audience_name          TEXT,                   -- Mailchimp audience name (case-insensitive) ...
  audience_id            TEXT,                   -- ... or its id
  segment_tag            TEXT,                   -- optional: only members with this tag
  send_at                TEXT,                   -- UTC ISO; NULL = send as soon as approved
  auto_send_after        TEXT,                   -- UTC ISO; only honored when settings.allow_auto_send = 'yes'
  html_part_count        INTEGER NOT NULL DEFAULT 1,
  html_sha256            TEXT,
  notes_for_reviewer     TEXT,                   -- one or two lines shown on the review page
  mailchimp_campaign_id  TEXT,
  mailchimp_web_id       TEXT,
  audience_resolved_name TEXT,
  recipient_count        INTEGER,
  checklist_json         TEXT,
  review_token_hash      TEXT,
  review_sent_at         TEXT,
  reminder_sent_at       TEXT,
  decision               TEXT,                   -- approved / changes_requested / rejected
  decision_note          TEXT,
  decided_at             TEXT,
  approved_html_sha256   TEXT,
  sent_at                TEXT,
  error                  TEXT,
  created_by             TEXT NOT NULL DEFAULT 'marketing',
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS campaigns_status ON campaigns(status);

CREATE TABLE IF NOT EXISTS campaign_html_parts (
  campaign_key TEXT NOT NULL,
  part_no      INTEGER NOT NULL,                 -- 1, 2, 3 ... (D1 caps one statement at ~100 KB)
  chunk        TEXT NOT NULL,
  PRIMARY KEY (campaign_key, part_no)
);

CREATE TABLE IF NOT EXISTS campaign_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_key TEXT NOT NULL,
  at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  event        TEXT NOT NULL,
  detail       TEXT
);
CREATE INDEX IF NOT EXISTS campaign_events_key ON campaign_events(campaign_key);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('approver_email', 'jeremy@artekya.com'),
  ('allow_auto_send', 'no'),
  ('public_base_url', NULL);

-- Refreshed by the Worker every 12 h so the agent can see audience and tag names.
CREATE TABLE IF NOT EXISTS mailchimp_audiences (
  list_id      TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  member_count INTEGER
);
CREATE TABLE IF NOT EXISTS mailchimp_tags (
  list_id      TEXT NOT NULL,
  tag_name     TEXT NOT NULL,
  segment_id   INTEGER NOT NULL,
  member_count INTEGER,
  PRIMARY KEY (list_id, segment_id)
);
