-- Chat media hardening (docs/chat.md "who sees a picture or a video", "takedown"). Additive, plus
-- the poster's foreign key loosened so an admin can take a poster down.
--
-- Each chat picture and chat video keeps where it was first posted: `posted_kind` 'stream' (a
-- stream's chat, public), 'group' (a group's channel: `posted_room` the `server/channel` room,
-- `posted_group` the group) or 'dm' (`posted_dm_a`/`posted_dm_b`, the two accounts, least first).
-- Null is an upload not posted yet: only its uploader is served it. Each upload also keeps the
-- sha256 of the bytes kept and the uploader's address (ratelimit.rs `forwarded_ip`); so does a
-- group emote. `media_removed` remembers what an admin took down, so its lines say "removed".
ALTER TABLE chat_images
    ADD COLUMN sha256 text,
    ADD COLUMN uploader_ip text,
    ADD COLUMN posted_kind text CHECK (posted_kind IN ('stream', 'group', 'dm')),
    ADD COLUMN posted_room text,
    ADD COLUMN posted_group text,
    ADD COLUMN posted_dm_a uuid,
    ADD COLUMN posted_dm_b uuid,
    ADD COLUMN posted_at timestamptz;

ALTER TABLE chat_videos
    ADD COLUMN sha256 text,
    ADD COLUMN uploader_ip text,
    ADD COLUMN posted_kind text CHECK (posted_kind IN ('stream', 'group', 'dm')),
    ADD COLUMN posted_room text,
    ADD COLUMN posted_group text,
    ADD COLUMN posted_dm_a uuid,
    ADD COLUMN posted_dm_b uuid,
    ADD COLUMN posted_at timestamptz;

ALTER TABLE group_emotes
    ADD COLUMN sha256 text,
    ADD COLUMN uploader_ip text;

-- a poster taken down leaves its video without one; taking a video down deletes its poster itself
ALTER TABLE chat_videos ALTER COLUMN poster DROP NOT NULL;
ALTER TABLE chat_videos DROP CONSTRAINT chat_videos_poster_fkey;
ALTER TABLE chat_videos ADD CONSTRAINT chat_videos_poster_fkey FOREIGN KEY (poster) REFERENCES chat_images(id) ON DELETE SET NULL;

CREATE TABLE media_removed (
    id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('image', 'video')),
    removed_by uuid,
    removed_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (id),
    FOREIGN KEY (removed_by) REFERENCES streamers(id) ON DELETE SET NULL
);

-- What is already up: the first line that names it, a direct message's or a kept chat line's
-- (a room's `server/channel` is a group's; a bare name is a stream's). One no kept line names
-- (a room's lines in redis alone, or never posted) stays public, as it was.
WITH uses AS (
    SELECT lower(trim(u)) AS id, 'dm' AS kind, NULL::text AS room, NULL::text AS grp,
           LEAST(d.from_id, d.to_id) AS a, GREATEST(d.from_id, d.to_id) AS b, d.sent_at AS at
      FROM dms d, unnest(string_to_array(d.image, ',')) AS u WHERE d.image IS NOT NULL
    UNION ALL
    SELECT lower(trim(split_part(d.video, ',', 2))), 'dm', NULL, NULL, LEAST(d.from_id, d.to_id), GREATEST(d.from_id, d.to_id), d.sent_at
      FROM dms d WHERE d.video IS NOT NULL
    UNION ALL
    SELECT lower(trim(u)), CASE WHEN strpos(l.room, '/') > 0 THEN 'group' ELSE 'stream' END, l.room,
           CASE WHEN strpos(l.room, '/') > 0 THEN split_part(l.room, '/', 1) END, NULL, NULL, l.at
      FROM chat_lines l, unnest(string_to_array(l.image, ',')) AS u WHERE l.image IS NOT NULL
    UNION ALL
    SELECT lower(trim(split_part(l.video, ',', 2))), CASE WHEN strpos(l.room, '/') > 0 THEN 'group' ELSE 'stream' END, l.room,
           CASE WHEN strpos(l.room, '/') > 0 THEN split_part(l.room, '/', 1) END, NULL, NULL, l.at
      FROM chat_lines l WHERE l.video IS NOT NULL
), first AS (
    SELECT DISTINCT ON (id) * FROM uses ORDER BY id, at
)
UPDATE chat_images i
   SET posted_kind = f.kind, posted_room = f.room, posted_group = f.grp, posted_dm_a = f.a, posted_dm_b = f.b, posted_at = f.at
  FROM first f WHERE i.id::text = f.id;

WITH uses AS (
    SELECT lower(trim(split_part(d.video, ',', 1))) AS id, 'dm' AS kind, NULL::text AS room, NULL::text AS grp,
           LEAST(d.from_id, d.to_id) AS a, GREATEST(d.from_id, d.to_id) AS b, d.sent_at AS at
      FROM dms d WHERE d.video IS NOT NULL
    UNION ALL
    SELECT lower(trim(split_part(l.video, ',', 1))), CASE WHEN strpos(l.room, '/') > 0 THEN 'group' ELSE 'stream' END, l.room,
           CASE WHEN strpos(l.room, '/') > 0 THEN split_part(l.room, '/', 1) END, NULL, NULL, l.at
      FROM chat_lines l WHERE l.video IS NOT NULL
), first AS (
    SELECT DISTINCT ON (id) * FROM uses ORDER BY id, at
)
UPDATE chat_videos v
   SET posted_kind = f.kind, posted_room = f.room, posted_group = f.grp, posted_dm_a = f.a, posted_dm_b = f.b, posted_at = f.at
  FROM first f WHERE v.id::text = f.id;

UPDATE chat_images SET posted_kind = 'stream', posted_at = created_at WHERE posted_kind IS NULL;
UPDATE chat_videos SET posted_kind = 'stream', posted_at = created_at WHERE posted_kind IS NULL;
