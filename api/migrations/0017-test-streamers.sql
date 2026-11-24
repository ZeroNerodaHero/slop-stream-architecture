ALTER TABLE streamers ADD COLUMN is_test boolean NOT NULL DEFAULT false;
UPDATE streamers SET is_test = true WHERE name LIKE 'dummy-%';
