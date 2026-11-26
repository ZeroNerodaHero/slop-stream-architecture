CREATE TABLE chat_audio (
    id uuid NOT NULL,
    mime text NOT NULL,
    bytes integer NOT NULL,
    duration_ms integer NOT NULL,
    created_by uuid,
    created_at timestamptz DEFAULT now() NOT NULL,
    sha256 text,
    uploader_ip text,
    posted_kind text CHECK (posted_kind IN ('stream', 'group', 'dm')),
    posted_room text,
    posted_group text,
    posted_dm_a uuid,
    posted_dm_b uuid,
    posted_at timestamptz,
    PRIMARY KEY (id),
    FOREIGN KEY (created_by) REFERENCES streamers(id) ON DELETE SET NULL
);

ALTER TABLE chat_lines ADD COLUMN audio text;

ALTER TABLE dms ADD COLUMN audio text;

ALTER TABLE media_removed DROP CONSTRAINT media_removed_kind_check;
ALTER TABLE media_removed ADD CONSTRAINT media_removed_kind_check CHECK (kind IN ('image', 'video', 'audio'));
