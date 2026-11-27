CREATE TABLE chat_embeds (
    room text NOT NULL,
    line_id text NOT NULL,
    embed jsonb,
    hidden boolean NOT NULL DEFAULT false,
    created_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (room, line_id)
);

ALTER TABLE dms ADD COLUMN embed jsonb;
ALTER TABLE dms ADD COLUMN embed_hidden boolean NOT NULL DEFAULT false;
