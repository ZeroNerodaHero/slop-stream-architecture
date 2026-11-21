-- A short video on a chat line (docs/chat.md "videos"): the bytes in the bucket
-- (`chat-videos/<id>.mp4` or `.webm`), the row says what they are, how many, how long, and the
-- poster, a picture the page grabbed from a frame and kept through `POST /api/chat-images` like
-- any other. A line names the video and its poster as `<video>,<poster>` in `video`, beside
-- `image`. Additive: one table, two columns, one partial index for `has:video`.
CREATE TABLE chat_videos (
    id uuid NOT NULL,
    mime text NOT NULL,
    bytes integer NOT NULL,
    duration_ms integer NOT NULL,
    poster uuid NOT NULL,
    created_by uuid,
    created_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (id),
    FOREIGN KEY (poster) REFERENCES chat_images(id),
    FOREIGN KEY (created_by) REFERENCES streamers(id) ON DELETE SET NULL
);

ALTER TABLE chat_lines ADD COLUMN video text;
CREATE INDEX chat_lines_video_idx ON chat_lines (room, at, seq) WHERE (video IS NOT NULL);

ALTER TABLE dms ADD COLUMN video text;
