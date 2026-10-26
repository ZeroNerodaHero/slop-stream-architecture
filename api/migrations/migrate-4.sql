-- who follows whom. both sides are the account id, so a rename keeps them.

CREATE TABLE follows (
    follower_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    followed_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    followed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (follower_id, followed_id),
    CHECK (follower_id <> followed_id)
);

CREATE INDEX follows_followed_idx ON follows (followed_id, followed_at DESC);
