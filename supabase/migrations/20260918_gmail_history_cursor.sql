-- Gmail Pub/Sub push: durable history cursor for self-healing gap backfill.
--
-- A push is ACKed (HTTP 200) as soon as the webhook returns; if the background
-- sync then fails (e.g. transient TLS error on the Google token refresh), the
-- historyId is never redelivered and that settlement email is permanently
-- dropped. This column stores the last successfully-consumed Gmail historyId
-- so the NEXT push starts from it and idempotently backfills the gap.
--
-- The application reads/writes this column DEFENSIVELY (app/api/v1/
-- gmail_ingestion.py `_read_history_cursor` / `_persist_history_cursor`), so an
-- unmigrated schema degrades to the previous behavior instead of dropping
-- pushes. This migration is therefore non-blocking but recommended.
ALTER TABLE tenant_integrations
    ADD COLUMN IF NOT EXISTS last_history_id TEXT;
