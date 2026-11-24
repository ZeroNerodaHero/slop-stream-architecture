-- Image moderation (docs/image-moderation.md). Additive: one table, one column.
--
-- `uploads` is one row per picture the moderation check saw (moderate.rs): what it was for
-- (`kind`), who sent it and from where, the sha256 and size of the exact bytes checked (the bytes
-- kept, after any redraw), the check's `category_scores` as OpenAI sent them, and whether it was
-- kept. `key` is the bucket key of one kept; a refused one was never stored and has none. Written
-- best effort: a failed insert is logged, and a refusal stays a refusal.
--
-- `chat_images.nsfw` and `chat_images.graphic`: the check's `sexual` and `violence/graphic` for a
-- chat picture (or a video's poster), kept because where it goes is only known when a line names
-- it. A stream's chat refuses either; a direct message and a group channel keep both (`nsfw` is
-- blurred by the page), and refuse `nsfw` only while moderate.rs `DM_GROUP_IMAGE_BLOCK_SEXUAL` says so.
CREATE TABLE uploads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text,
    kind text NOT NULL,
    uploader_id uuid,
    uploader_ip text,
    sha256 text NOT NULL,
    bytes integer NOT NULL,
    mime text NOT NULL,
    nsfw boolean NOT NULL DEFAULT false,
    scores jsonb,
    status text NOT NULL CHECK (status IN ('accepted', 'rejected')),
    created_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (id),
    FOREIGN KEY (uploader_id) REFERENCES streamers(id) ON DELETE SET NULL
);
CREATE INDEX uploads_sha256_idx ON uploads (sha256);
CREATE INDEX uploads_uploader_idx ON uploads (uploader_id, created_at);

ALTER TABLE chat_images ADD COLUMN nsfw boolean NOT NULL DEFAULT false;
ALTER TABLE chat_images ADD COLUMN graphic boolean NOT NULL DEFAULT false;
