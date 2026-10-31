-- what the owner role is called (docs/groups.md): `owner` until an owner renames it. owning is the
-- memberships.owner bit, not a row of roles: this is the word on the roster's crown and the roles
-- tab's first row, which carries every power and is only renamed. a custom role cannot take it.
ALTER TABLE groups ADD COLUMN owner_role text NOT NULL DEFAULT 'owner';
