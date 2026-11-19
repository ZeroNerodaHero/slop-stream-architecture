# api

one rust binary, several modes. axum 0.8, sqlx, redis, argon2id.

```
api              # json api on PORT (4000). applies schema.sql to an empty database at boot
api chat         # text chat on PORT (4100)
api events       # /events gateway on PORT (4100)
api home         # GET /api/streams on PORT (4100)
api monitor      # watch other boxes; no postgres or redis
api models <dir> # demo vrms into the bucket (scripts/models.sh)
api passwd <name>
api release <version> [commit]
```

compose starts four containers from this image: `api`, `chat`, `events`, `home`. `monitor/` starts `api monitor` on its own box.

routes are registered in `src/main.rs` (`fn router`) and in each module's `routes()`. the contract is `docs/spec.md`. health: `GET /api/health`. errors: `POST|GET /api/errors` (get needs `ADMIN_NAMES` or `OPS_TOKEN`).

schema: `schema.sql`, the whole database in one file. `src/schema.rs` applies it at boot, in one transaction, when the database has no `streamers` table, and otherwise does nothing. it is the baseline, frozen as of 2026-11-19: to change the tables from here, add `migrations/NNNN-what.sql` and its line in `MIGRATIONS` (`src/schema.rs`). at boot the api applies the ones `schema_migrations` lacks, in order, so an existing database picks a change up with no reset (`migrations/README.md`).

the watch page html (`GET /watch/<name>`) is served here so a shared link gets a preview card (`src/profile.rs`).
