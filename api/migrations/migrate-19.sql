-- how the member list is ordered after the owners. name, newest, or oldest.
ALTER TABLE groups ADD COLUMN member_order text NOT NULL DEFAULT 'name';
