-- the pictures a streamer lays onto the scene on the go live page (docs/screen.md): png, jpeg,
-- gif, webp, kept exactly as uploaded so transparency and animation survive. the bytes are in
-- the bucket at assets/<row id>/<id>.<ext>; mime is what the sniff said, and what the read
-- serves back. keyed by name like stream_thumbs, so a rename updates it in the same
-- transaction. newer than ids, so there is no name key to lift.

CREATE TABLE stream_assets (
    name text NOT NULL,
    id bigint NOT NULL,
    mime text NOT NULL,
    bytes integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (name, id)
);
