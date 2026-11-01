-- pictures on a direct message (docs/dms.md): the ids `POST /api/chat-images` handed back, joined
-- by commas, the way a chat line keeps its own (migrate-18.sql). null when the line has none. the
-- bytes stay in the bucket under `chat/<id>`; the row names them.
ALTER TABLE dms ADD COLUMN image text;
