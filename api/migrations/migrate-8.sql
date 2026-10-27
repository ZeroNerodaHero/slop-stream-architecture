-- the calendar (docs/calendar.md): a block per session, ending where the stream really ended.
--
-- last_beat_at: when the page last said heartbeat, written by the beat's own ownership check.
-- a row the sweeper ends (the api or video was down when the tab vanished, so nothing said stop)
-- ends there, within one beat of the truth, not minutes later at the sweep.
-- ended_by: how the block closed. stop (the page), video (the publisher's peer went and video
-- said so), sweep. null while open, and on rows from before this file.
ALTER TABLE sessions ADD COLUMN last_beat_at timestamptz;
UPDATE sessions SET last_beat_at = COALESCE(ended_at, started_at) WHERE last_beat_at IS NULL;
ALTER TABLE sessions ADD COLUMN ended_by text;

-- a month of one account's blocks. a free name's range walks sessions_name_started_idx.
CREATE INDEX sessions_user_started_idx ON sessions (user_id, started_at DESC) WHERE user_id IS NOT NULL;
