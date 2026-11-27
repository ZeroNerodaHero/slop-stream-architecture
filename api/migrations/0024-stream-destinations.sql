CREATE TABLE stream_destinations (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    platform text NOT NULL CHECK (platform IN ('twitch', 'kick', 'custom')),
    external_id text,
    external_name text,
    access_token bytea,
    refresh_token bytea,
    token_expires_at timestamptz,
    scopes text,
    stream_url bytea,
    stream_key bytea,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((platform = 'custom') = (external_id IS NULL))
);

CREATE UNIQUE INDEX stream_destinations_account ON stream_destinations (user_id, platform, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX stream_destinations_user ON stream_destinations (user_id, created_at);
