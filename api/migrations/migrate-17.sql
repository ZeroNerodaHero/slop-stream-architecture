-- the words they typed, and four digits so two groups can share those words.
-- the address stays `name` (the words, cut to fit, plus `-` and the digits).
-- a group made before this has neither, and its name is the words.
ALTER TABLE groups ADD COLUMN title text;
ALTER TABLE groups ADD COLUMN tag integer;
