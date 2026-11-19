-- the primary group (docs/groups.md): the one group whose badge a login's name wears, picked in
-- the groups tab. a bit on the membership, not a column on streamers, so leaving the group (or the
-- group going, or a kick or a ban) takes the choice with the row and nothing has to clear it.
-- none set: every group's badge, in the order joined, as before.
ALTER TABLE memberships ADD COLUMN is_primary boolean NOT NULL DEFAULT false;
-- one each. also the index for "this login's primary" (groups.rs `badges_of`, `badge_of`)
CREATE UNIQUE INDEX memberships_one_primary_idx ON memberships (user_id) WHERE is_primary;
