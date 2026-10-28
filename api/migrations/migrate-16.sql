-- a group is public unless its maker says otherwise. a private one is left off the
-- lists. someone who has the name can still open the page and join.

ALTER TABLE groups ADD COLUMN public boolean NOT NULL DEFAULT true;
