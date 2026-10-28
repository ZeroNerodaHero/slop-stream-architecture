-- a picture on a chat line. the bytes live in the bucket; the line keeps the id.
CREATE TABLE chat_images (
    id uuid PRIMARY KEY,
    mime text NOT NULL,
    created_by uuid REFERENCES streamers (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE chat_lines ADD COLUMN image text;
