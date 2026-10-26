-- what a watcher sees while the name is not live: a picture where the player would be, and a
-- line under the word. the jpeg is in the bucket at offline/<id>.jpg; offline_at is its version.

ALTER TABLE streamers ADD COLUMN offline_at timestamptz;
ALTER TABLE streamers ADD COLUMN offline_note text NOT NULL DEFAULT '';
