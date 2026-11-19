# migrations, from the baseline on

`api/schema.sql` is the baseline: the whole database as of 2026-11-19, applied once to an empty
database. Leave it alone from now on. A change to the tables is a new file here, and a line in
`MIGRATIONS` in `api/src/schema.rs`:

- name it `NNNN-what.sql`, the next number (`0001-...`, `0002-...`), and never edit or rename one
  that has shipped.
- at boot the api applies each listed migration that `schema_migrations` does not have yet, in
  order, each in its own transaction with its row, under the same advisory lock as the baseline.
  a fresh database gets the baseline and then every migration; prod gets only the new ones.
- no reset needed, and no step in `deploy.sh`: the api does it when it starts.
