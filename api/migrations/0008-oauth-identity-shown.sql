-- What the provider shows for a linked login: its display name and its picture, for the
-- security tab's linked logins. Additive: two nullable columns.
--
-- Rows linked before this have neither until their next login or link with that provider, which
-- writes both (oauth.rs). Only a capped name and an https picture on the provider's own image
-- host are kept; never shown to anybody but the account itself.

ALTER TABLE oauth_identities ADD COLUMN display_name text;

ALTER TABLE oauth_identities ADD COLUMN avatar_url text;
