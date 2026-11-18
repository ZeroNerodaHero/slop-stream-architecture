-- logging in with google, twitch or discord (docs/accounts.md). one row per outside account
-- linked to one of ours. keyed on the provider's own stable user id, never on an email or a
-- display name: those change, and an email match is not proof it is the same person.
-- `email` is what the provider said, kept for later (resets, otp). never shown to anyone else.
CREATE TABLE oauth_identities (
    user_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    provider text NOT NULL CHECK (provider IN ('google', 'twitch', 'discord')),
    provider_user_id text NOT NULL,
    email text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_user_id),
    -- one of each provider per account; also the index for "this account's logins"
    UNIQUE (user_id, provider)
);

-- ADMIN_NAMES, pinned to the account that had the name when the api first saw it there
-- (debug.rs `admins_with_accounts`). an admin who renames stays one; whoever later takes the
-- released name does not become one. to move a pin: DELETE FROM admin_pins WHERE name = '...'
CREATE TABLE admin_pins (
    name text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    pinned_at timestamptz NOT NULL DEFAULT now()
);
