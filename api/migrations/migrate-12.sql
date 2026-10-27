-- about me (docs/about.md): the words first on the about tab under the player, a few
-- paragraphs at most, edited on the tab itself by the owner. the status (`bio`) is the one
-- line beside the name; this is the longer piece. a name nobody wrote one for has ''.

ALTER TABLE streamers ADD COLUMN about text NOT NULL DEFAULT '';
