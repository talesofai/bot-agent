-- Schema for opencode-bot-agent history store.
-- This runs only on first init of the Postgres data directory when using docker-compose.

CREATE TABLE IF NOT EXISTS history_entries (
  id BIGSERIAL PRIMARY KEY,
  bot_account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  meta JSONB
);

ALTER TABLE history_entries
  ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT '0';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'history_entries'
       AND column_name = 'created_at'
       AND data_type <> 'timestamp with time zone'
  ) THEN
    ALTER TABLE history_entries
      ALTER COLUMN created_at TYPE TIMESTAMPTZ
      USING (created_at::timestamptz);
  END IF;
END $$;

UPDATE history_entries
   SET session_id = COALESCE(NULLIF(meta->>'sessionId',''), session_id)
 WHERE session_id = '0'
   AND meta ? 'sessionId';

CREATE INDEX IF NOT EXISTS history_entries_lookup_idx
  ON history_entries (bot_account_id, user_id, id);

CREATE INDEX IF NOT EXISTS history_entries_group_lookup_idx
  ON history_entries (bot_account_id, group_id, id);

CREATE INDEX IF NOT EXISTS history_entries_group_session_lookup_idx
  ON history_entries (bot_account_id, group_id, session_id, id);
