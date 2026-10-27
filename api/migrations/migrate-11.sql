-- where else to find them (docs/socials.md): the links under the player, as one document the
-- owner replaces whole, like the bio. `{ layout: row | grid, size: small | medium | large,
-- links: [{ kind, url, label? }] }`. the api checks every field at the door, so a row never
-- holds a link that is not http(s). a name nobody saved links for has the empty document.

ALTER TABLE streamers ADD COLUMN socials jsonb NOT NULL DEFAULT '{"layout":"row","size":"medium","links":[]}'::jsonb;
