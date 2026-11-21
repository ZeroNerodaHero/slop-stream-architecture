-- A group timeout's reason (docs/groups.md): the moderator's optional words, as a ban keeps its
-- own. Additive: one column with a default, nothing rewritten.
ALTER TABLE timeouts ADD COLUMN reason text DEFAULT '' NOT NULL;
