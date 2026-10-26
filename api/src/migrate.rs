//! The database, as files in `api/migrations`. `migrate-1.sql`, then `migrate-2.sql`,
//! and so on. Each file runs once, in a transaction, and its number is written to
//! `schema_migrations`. A change after that is the next file, not an edit of one
//! that has already run.
//!
//! A database this process used to build on its own, before these files existed, has
//! no `schema_migrations` and already has the tables. The first boot records every
//! file whose tables are already there, and runs only the ones that are not.

use std::collections::HashSet;

use sqlx::postgres::PgPool;
use sqlx::{Connection, Executor, PgConnection, Row};

struct Migration {
    version: i32,
    name: &'static str,
    sql: &'static str,
    /// True when a database built the old way already has what this file would make.
    present: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "migrate-1.sql",
        sql: include_str!("../migrations/migrate-1.sql"),
        present: "SELECT to_regclass('public.logins') IS NOT NULL
            AND EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'streamers' AND column_name = 'password_hash')
            AND EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'token')",
    },
    Migration {
        version: 2,
        name: "migrate-2.sql",
        sql: include_str!("../migrations/migrate-2.sql"),
        present: "SELECT to_regclass('public.groups') IS NOT NULL
            AND to_regclass('public.memberships') IS NOT NULL
            AND to_regclass('public.stream_thumbs') IS NOT NULL",
    },
    Migration {
        version: 3,
        name: "migrate-3.sql",
        sql: include_str!("../migrations/migrate-3.sql"),
        present: "SELECT to_regclass('public.held_names') IS NOT NULL
            AND EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'streamers' AND column_name = 'id')
            AND EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'logins' AND column_name = 'user_id')",
    },
    Migration {
        version: 4,
        name: "migrate-4.sql",
        sql: include_str!("../migrations/migrate-4.sql"),
        present: "SELECT to_regclass('public.follows') IS NOT NULL",
    },
    Migration {
        version: 5,
        name: "migrate-5.sql",
        sql: include_str!("../migrations/migrate-5.sql"),
        present: "SELECT to_regclass('public.chat_lines') IS NOT NULL",
    },
    Migration {
        version: 6,
        name: "migrate-6.sql",
        sql: include_str!("../migrations/migrate-6.sql"),
        present: "SELECT to_regclass('public.channels') IS NOT NULL",
    },
    Migration {
        version: 7,
        name: "migrate-7.sql",
        sql: include_str!("../migrations/migrate-7.sql"),
        present: "SELECT EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'streamers' AND column_name = 'offline_at')",
    },
];

/// Apply every migration that has not run. The chat process does not call this.
pub(crate) async fn run(db: &PgPool) -> anyhow::Result<()> {
    let mut conn = db.acquire().await?;
    // held on this connection across the transactions below, released when it closes
    conn.execute("SELECT pg_advisory_lock(839201)").await?;
    let applied = apply(&mut conn).await;
    let unlocked = conn.execute("SELECT pg_advisory_unlock(839201)").await;
    applied?;
    unlocked?;
    Ok(())
}

async fn apply(conn: &mut PgConnection) -> anyhow::Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version integer PRIMARY KEY,
            name text NOT NULL,
            applied_at timestamptz NOT NULL DEFAULT now()
        )",
    )
    .await?;

    // the old boot left a finished database and no record of it. write the record,
    // and leave a file that is not there yet to run below.
    if recorded(conn).await?.is_empty() {
        let mut tx = conn.begin().await?;
        for migration in MIGRATIONS {
            let there: bool = sqlx::query_scalar(migration.present).fetch_one(&mut *tx).await?;
            if !there {
                continue;
            }
            sqlx::query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)")
                .bind(migration.version)
                .bind(migration.name)
                .execute(&mut *tx)
                .await?;
            log::info!("{} is already in the database, recorded", migration.name);
        }
        tx.commit().await?;
    }

    let have = recorded(conn).await?;
    for migration in MIGRATIONS {
        if have.contains(&migration.version) {
            continue;
        }
        let mut tx = conn.begin().await?;
        tx.execute(migration.sql).await.map_err(|e| anyhow::anyhow!("{}: {e}", migration.name))?;
        sqlx::query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)")
            .bind(migration.version)
            .bind(migration.name)
            .execute(&mut *tx)
            .await?;
        tx.commit().await.map_err(|e| anyhow::anyhow!("{}: {e}", migration.name))?;
        log::info!("{} applied", migration.name);
    }
    Ok(())
}

async fn recorded(conn: &mut PgConnection) -> Result<HashSet<i32>, sqlx::Error> {
    let rows = sqlx::query("SELECT version FROM schema_migrations").fetch_all(&mut *conn).await?;
    Ok(rows.into_iter().map(|row| row.get("version")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_files_go_one_then_two() {
        for (i, migration) in MIGRATIONS.iter().enumerate() {
            let n = (i as i32) + 1;
            assert_eq!(migration.version, n);
            assert_eq!(migration.name, format!("migrate-{n}.sql"));
            assert!(!migration.sql.trim().is_empty());
        }
    }
}
