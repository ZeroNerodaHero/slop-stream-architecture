CREATE TABLE uploads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text,
    kind text NOT NULL,
    uploader_id uuid,
    uploader_name text,
    uploader_ip text,
    sha256 text NOT NULL,
    bytes integer NOT NULL,
    mime text NOT NULL,
    nsfw boolean NOT NULL DEFAULT false,
    graphic boolean NOT NULL DEFAULT false,
    categories jsonb,
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
ALTER TABLE chat_images ADD COLUMN moderated boolean NOT NULL DEFAULT false;

ALTER TABLE groups ADD COLUMN adult_content boolean NOT NULL DEFAULT false;
ALTER TABLE groups ADD COLUMN adult_locked_by uuid;
