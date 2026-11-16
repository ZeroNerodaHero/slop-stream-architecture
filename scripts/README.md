# scripts

run these from the repo root.

| script | what it does |
|---|---|
| `deploy.sh` | bring the lab up, or redeploy part of it. the main entry. `./scripts/deploy.sh --help` |
| `ship.sh` | build images here and send them to a box (`--to gcloud:test-machine` or `--to user@host`) or to a registry |
| `test.sh` | playwright tests. optional url, `--all`, `HEADED=1` |
| `seed.sh` | fake accounts. names and passwords appended to `.seeded-users` (gitignored) |
| `dummy-groups.sh` | fake groups; credentials in `.seeded-groups` |
| `migrate.sh` | data migrations in `migrate-scripts/`. recorded in `.migrated`. deploy.sh runs this |
| `models.sh` | demo vrms in `random-media/vrms` into the bucket. `.models` remembers the folder |
| `manage.sh` | read-only terminal ui for postgres and redis (`--db`, `--redis`, `--to`). runs `manage.py` |

`manage.py` is not invoked on its own. it writes nothing: every sql query is in a transaction that is rolled back.

there is no reset script. to wipe dev data, see the restart runbook in the project context doc, or: `docker compose down -v`, delete `.migrated` `.seeded-users` `.seeded-groups` `.models` `.deployed`, then `./scripts/deploy.sh`.
