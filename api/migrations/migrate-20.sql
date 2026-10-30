-- the about tab's page (docs/about.md): where each block sits, not the bytes.
-- a block is { type, id, x, y, z }. the picture, the clip, the track and the text
-- (html, 10000 characters) are objects in the bucket at about/<row uuid>/<id>.<ext>.

ALTER TABLE streamers ADD COLUMN about_page jsonb NOT NULL DEFAULT '{"blocks":[]}'::jsonb;

CREATE TABLE about_files (
    name text NOT NULL,
    id bigint NOT NULL,
    kind text NOT NULL,
    mime text NOT NULL,
    bytes integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (name, id)
);
