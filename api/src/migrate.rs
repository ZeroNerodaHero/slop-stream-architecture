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
    Migration {
        version: 8,
        name: "migrate-8.sql",
        sql: include_str!("../migrations/migrate-8.sql"),
        present: "SELECT EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'last_beat_at')",
    },
    Migration {
        version: 9,
        name: "migrate-9.sql",
        sql: include_str!("../migrations/migrate-9.sql"),
        present: "SELECT to_regclass('public.stream_assets') IS NOT NULL",
    },
    Migration {
        version: 10,
        name: "migrate-10.sql",
        sql: include_str!("../migrations/migrate-10.sql"),
        present: "SELECT to_regclass('public.dms') IS NOT NULL AND to_regclass('public.dm_reads') IS NOT NULL",
    },
    Migration {
        version: 11,
        name: "migrate-11.sql",
        sql: include_str!("../migrations/migrate-11.sql"),
        present: "SELECT EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'streamers' AND column_name = 'socials')",
    },
    Migration {
        version: 12,
        name: "migrate-12.sql",
        sql: include_str!("../migrations/migrate-12.sql"),
        present: "SELECT EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'streamers' AND column_name = 'about')",
    },
    Migration {
        version: 13,
        name: "migrate-13.sql",
        sql: include_str!("../migrations/migrate-13.sql"),
        present: "SELECT to_regclass('public.deploys') IS NOT NULL",
    },
    Migration {
        version: 14,
        name: "migrate-14.sql",
        sql: include_str!("../migrations/migrate-14.sql"),
        present: "SELECT to_regclass('public.notifications') IS NOT NULL",
    },
    Migration {
        version: 15,
        name: "migrate-15.sql",
        sql: include_str!("../migrations/migrate-15.sql"),
        present: "SELECT to_regclass('public.roles') IS NOT NULL
            AND to_regclass('public.bans') IS NOT NULL
            AND EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'memberships' AND column_name = 'owner')",
    },
    Migration {
        version: 16,
        name: "migrate-16.sql",
        sql: include_str!("../migrations/migrate-16.sql"),
        present: "SELECT EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'groups' AND column_name = 'public')",
    },
    Migration {
        version: 17,
        name: "migrate-17.sql",
        sql: include_str!("../migrations/migrate-17.sql"),
        present: "SELECT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'groups' AND column_name = 'title')
            AND EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'groups' AND column_name = 'tag')",
    },
    Migration {
        version: 18,
        name: "migrate-18.sql",
        sql: include_str!("../migrations/migrate-18.sql"),
        present: "SELECT to_regclass('public.chat_images') IS NOT NULL
            AND EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'chat_lines' AND column_name = 'image')",
    },
    Migration {
        version: 19,
        name: "migrate-19.sql",
        sql: include_str!("../migrations/migrate-19.sql"),
        present: "SELECT EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'groups' AND column_name = 'member_order')",
    },
    Migration {
        version: 20,
        name: "migrate-20.sql",
        sql: include_str!("../migrations/migrate-20.sql"),
        present: "SELECT to_regclass('public.about_files') IS NOT NULL
            AND EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'streamers' AND column_name = 'about_page')",
    },
    Migration {
        version: 21,
        name: "migrate-21.sql",
        sql: include_str!("../migrations/migrate-21.sql"),
        present: "SELECT to_regclass('public.channel_mutes') IS NOT NULL
            AND EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'room')",
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
