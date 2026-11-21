//! Reactions: an emoji from a short list on a line, discord's (docs/chat.md "reactions", docs/dms.md),
//! or a group's custom emote (emotes.rs) by its id, for a reactor in that group.
//!
//! The same everywhere a line is drawn: a stream's chat and a group's channel (chat.rs, a `react`
//! frame on the room's socket) and a direct message thread (dms.rs, `PUT /api/dm/:name/react`).
//! One row is one login's one emoji on one line (`chat_reactions`, `dm_reactions`): the key is
//! the "once per emoji per person" rule, so a second `on` is no change. A line holds
//! `MAX_KINDS` different emoji at most; a new one past that is `too many reactions`, and one
//! already there may still be added to. Only a login reacts: the row is an account, read back
//! under the name it has now, so a rename keeps every reaction.
//!
//! The reactions are never kept with a line: every read of lines asks for them (`with_reactions`
//! for a room's, the join in dms.rs `LINE_SELECT` for a thread's), and a change goes out as a
//! frame of its own (`react`, `dm_react`) that the pages apply to the line they hold.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::chat::Line;

/// The emoji a line may wear: a curated grid, no free text, so a reaction is never a way to say
/// what the box would refuse. The pages draw the same list in this order (frontend
/// `shared-components/reaction-list.ts`), the first six as the picker's quick row.
pub(crate) const EMOJIS: [&str; 32] = [
    "👍", "❤️", "😂", "😮", "😢", "🔥", "🎉", "👏", //
    "👎", "😡", "🙏", "💯", "👀", "🤔", "😍", "😎", //
    "🤣", "😭", "😅", "🙌", "💀", "🤯", "🥳", "🤝", //
    "✅", "❌", "⭐", "🚀", "💜", "👋", "😆", "🫶",
];

/// Different emoji on one line, at most.
pub(crate) const MAX_KINDS: i64 = 20;
/// The names a reaction carries, the first to react first: the chip's tooltip lists them, and says
/// how many more past these.
pub(crate) const NAMES_SHOWN: i32 = 25;

/// The words for an emoji not on the list.
pub(crate) const NOT_A_REACTION: &str = "not a reaction";
/// The words for a new emoji on a line that has `MAX_KINDS` already.
pub(crate) const TOO_MANY: &str = "too many reactions";
/// The words for a socket with no login behind it.
pub(crate) const LOG_IN: &str = "log in to react";

/// One emoji on a line: how many reacted with it and the first of them by name (`NAMES_SHOWN`),
/// in the order they reacted. A line's reactions are in the order each emoji first came.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct Reaction {
    pub(crate) emoji: String,
    pub(crate) count: i64,
    pub(crate) who: Vec<String>,
    /// the viewer is one of the `count`, named in `who` or not: past the first `NAMES_SHOWN` the
    /// names cannot say so, and their chip must still be lit and take theirs off. absent for no
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) me: bool,
}

pub(crate) fn allowed(emoji: &str) -> bool {
    EMOJIS.contains(&emoji)
}

/// The words for a custom emote the reactor is not in the group of.
pub(crate) const NOT_YOURS: &str = "you can't use that emote";

/// A custom emote's id, when the reaction is one: the id as the api writes it (lowercase, with its
/// dashes), so one emote is one reaction however it was typed.
pub(crate) fn emote_of(emoji: &str) -> Option<Uuid> {
    if emoji.len() != 36 {
        return None;
    }
    Uuid::try_parse(emoji).ok()
}

/// A reaction as it is kept: one off the list as it is, an emote by its id written the api's
/// way. None for anything else (`NOT_A_REACTION`). The shape alone: whether the reactor may use
/// the emote is `may_put`'s.
pub(crate) fn shaped(emoji: &str) -> Option<String> {
    if allowed(emoji) {
        return Some(emoji.to_owned());
    }
    emote_of(emoji).map(|id| id.to_string())
}

/// Whether `user` may put `emoji` (already `shaped`) on a line: anyone may, one off the list; a
/// custom emote only a member of its group (emotes.rs `usable`). Taking one off asks nothing: an
/// emote's group left, or the emote deleted, a reaction still comes off.
pub(crate) async fn may_put(db: &PgPool, user: Uuid, emoji: &str) -> Result<bool, sqlx::Error> {
    match emote_of(emoji) {
        Some(id) => crate::emotes::usable(db, user, id).await,
        None => Ok(true),
    }
}

/// An emote deleted (emotes.rs `remove`): its reactions go with it, everywhere.
pub(crate) async fn drop_emote(db: &PgPool, id: Uuid) -> Result<(), sqlx::Error> {
    let id = id.to_string();
    sqlx::query("DELETE FROM chat_reactions WHERE emoji = $1").bind(&id).execute(db).await?;
    sqlx::query("DELETE FROM dm_reactions WHERE emoji = $1").bind(&id).execute(db).await?;
    Ok(())
}

/// What a reaction asked for came to.
#[derive(Debug, PartialEq)]
pub(crate) enum Set {
    /// A row went in or out: the change goes out to everyone on the line.
    Changed,
    /// It was so already (an `on` twice, an `off` of nothing): nothing to say.
    Same,
    /// A new emoji on a line with `MAX_KINDS` already.
    TooMany,
}

/// The class of the advisory locks a line's new reactions take (`lock_line`): a number of its own,
/// apart from the schema's lock.
const LOCK_CLASS: i32 = 7_310;

/// Holds the line until the transaction ends, so two new emoji at once read the cap one after the
/// other and the line never passes `MAX_KINDS`. `line` is a key of its own per line: the room and
/// the id, or the thread's line id.
async fn lock_line(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, line: &str) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT pg_advisory_xact_lock($1, hashtext($2))").bind(LOCK_CLASS).bind(line).execute(&mut **tx).await?;
    Ok(())
}

/// One login's `emoji` on a room's line on or off. The line is the caller's to have found in the
/// room. The cap is read in the insert itself, under the line's lock (`lock_line`).
pub(crate) async fn set_line(db: &PgPool, room: &str, line: &str, user: Uuid, emoji: &str, on: bool) -> Result<Set, sqlx::Error> {
    if !on {
        let gone = sqlx::query("DELETE FROM chat_reactions WHERE room = $1 AND line_id = $2 AND emoji = $3 AND user_id = $4")
            .bind(room)
            .bind(line)
            .bind(emoji)
            .bind(user)
            .execute(db)
            .await?;
        return Ok(if gone.rows_affected() > 0 { Set::Changed } else { Set::Same });
    }
    let mut tx = db.begin().await?;
    lock_line(&mut tx, &format!("{room} {line}")).await?;
    let added = sqlx::query(
        "INSERT INTO chat_reactions (room, line_id, emoji, user_id)
         SELECT $1, $2, $3, $4
          WHERE EXISTS (SELECT 1 FROM chat_reactions WHERE room = $1 AND line_id = $2 AND emoji = $3)
             OR (SELECT count(DISTINCT emoji) FROM chat_reactions WHERE room = $1 AND line_id = $2) < $5
         ON CONFLICT DO NOTHING",
    )
    .bind(room)
    .bind(line)
    .bind(emoji)
    .bind(user)
    .bind(MAX_KINDS)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    if added.rows_affected() > 0 {
        return Ok(Set::Changed);
    }
    let mine: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM chat_reactions WHERE room = $1 AND line_id = $2 AND emoji = $3 AND user_id = $4)")
        .bind(room)
        .bind(line)
        .bind(emoji)
        .bind(user)
        .fetch_one(db)
        .await?;
    Ok(if mine { Set::Same } else { Set::TooMany })
}

/// `set_line` for a direct message: the line is the caller's to have found in the thread. The same
/// lock, keyed `dm <id>`, which no room's `<room> <id>` is (a room's name has no space).
pub(crate) async fn set_dm(db: &PgPool, dm: i64, user: Uuid, emoji: &str, on: bool) -> Result<Set, sqlx::Error> {
    if !on {
        let gone = sqlx::query("DELETE FROM dm_reactions WHERE dm_id = $1 AND emoji = $2 AND user_id = $3")
            .bind(dm)
            .bind(emoji)
            .bind(user)
            .execute(db)
            .await?;
        return Ok(if gone.rows_affected() > 0 { Set::Changed } else { Set::Same });
    }
    let mut tx = db.begin().await?;
    lock_line(&mut tx, &format!("dm {dm}")).await?;
    let added = sqlx::query(
        "INSERT INTO dm_reactions (dm_id, emoji, user_id)
         SELECT $1, $2, $3
          WHERE EXISTS (SELECT 1 FROM dm_reactions WHERE dm_id = $1 AND emoji = $2)
             OR (SELECT count(DISTINCT emoji) FROM dm_reactions WHERE dm_id = $1) < $4
         ON CONFLICT DO NOTHING",
    )
    .bind(dm)
    .bind(emoji)
    .bind(user)
    .bind(MAX_KINDS)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    if added.rows_affected() > 0 {
        return Ok(Set::Changed);
    }
    let mine: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM dm_reactions WHERE dm_id = $1 AND emoji = $2 AND user_id = $3)")
        .bind(dm)
        .bind(emoji)
        .bind(user)
        .fetch_one(db)
        .await?;
    Ok(if mine { Set::Same } else { Set::TooMany })
}

/// room, line id, emoji, how many, the first names, whether the viewer is one
type ReactionRow = (String, String, String, i64, Vec<String>, bool);

/// The reactions on room lines, each line with its room (a server's search spans channels): one
/// query for the batch. Like the faces (chat.rs `with_faces`), a database that does not answer,
/// or not in 2 s, leaves the lines without: they still go out, a little behind. `viewer` is who
/// the lines go to (`Reaction::me`); none for a nick.
pub(crate) async fn with_reactions<'a>(db: &PgPool, viewer: Option<Uuid>, lines: impl IntoIterator<Item = (&'a str, &'a mut Line)>) {
    let mut lines: Vec<(&str, &mut Line)> = lines.into_iter().collect();
    if lines.is_empty() {
        return;
    }
    let rooms: Vec<String> = lines.iter().map(|(room, _)| (*room).to_owned()).collect();
    let ids: Vec<String> = lines.iter().map(|(_, line)| line.id.clone()).collect();
    let rows: Vec<ReactionRow> = match tokio::time::timeout(
        Duration::from_secs(2),
        sqlx::query_as(
            "SELECT r.room, r.line_id, r.emoji, count(*), ((array_agg(s.name ORDER BY r.at, s.name))[1:$3])::text[],
                    COALESCE(bool_or(r.user_id = $4), false)
             FROM chat_reactions r JOIN streamers s ON s.id = r.user_id
             WHERE (r.room, r.line_id) IN (SELECT * FROM unnest($1::text[], $2::text[]))
             GROUP BY r.room, r.line_id, r.emoji
             ORDER BY min(r.at), r.emoji",
        )
        .bind(&rooms)
        .bind(&ids)
        .bind(NAMES_SHOWN)
        .bind(viewer)
        .fetch_all(db),
    )
    .await
    {
        Ok(Ok(rows)) => rows,
        Ok(Err(e)) => {
            log::warn!("cannot read the reactions on {} lines: {e}", lines.len());
            return;
        }
        Err(_) => {
            log::warn!("reading the reactions on {} lines timed out", lines.len());
            return;
        }
    };
    for (room, line_id, emoji, count, who, me) in rows {
        if let Some((_, line)) = lines.iter_mut().find(|(r, l)| *r == room && l.id == line_id) {
            line.reactions.push(Reaction { emoji, count, who, me });
        }
    }
}

/// A thread's line's reactions, as dms.rs `LINE_SELECT` selects them for line `d`: json, the
/// `Reaction` shape, `[]` for none. A macro, so the select stays one literal (oauth.rs `linked_sql!`).
macro_rules! dm_reactions_sql {
    () => {
        "(SELECT COALESCE(json_agg(json_build_object('emoji', x.emoji, 'count', x.n, 'who', x.who) ORDER BY x.first, x.emoji), '[]'::json)
            FROM (SELECT r.emoji, count(*) AS n, (array_agg(rs.name ORDER BY r.at, rs.name))[1:25] AS who, min(r.at) AS first
                    FROM dm_reactions r JOIN streamers rs ON rs.id = r.user_id
                   WHERE r.dm_id = d.id GROUP BY r.emoji) x)"
    };
}
pub(crate) use dm_reactions_sql;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_list_is_short_and_has_no_twins() {
        assert_eq!(EMOJIS.len(), 32);
        for (i, e) in EMOJIS.iter().enumerate() {
            assert!(!EMOJIS[..i].contains(e), "{e} twice");
        }
        assert!(allowed("👍") && allowed("❤️"));
        // the bare heart without its emoji selector is not the one on the list, nor is free text
        assert!(!allowed("❤") && !allowed("lol") && !allowed(""));
    }

    #[test]
    fn an_emote_reacts_by_its_id() {
        let id = "0B7C6C1E-4F0A-4C1E-9D55-6A1F5D3E2B10";
        assert_eq!(shaped(id).as_deref(), Some("0b7c6c1e-4f0a-4c1e-9d55-6a1f5d3e2b10"));
        assert_eq!(shaped("🔥").as_deref(), Some("🔥"));
        assert!(shaped("lol").is_none());
        // the simple form of a uuid is not a reaction: one emote, one way to write it
        assert!(shaped("0b7c6c1e4f0a4c1e9d556a1f5d3e2b10").is_none());
        assert!(emote_of("👍").is_none());
    }

    #[test]
    fn the_pages_draw_the_same_list() {
        let pages = include_str!("../../frontend/src/shared-components/reaction-list.ts");
        let start = pages.find("EMOJIS = [").expect("the pages' list");
        let list = &pages[start..start + pages[start..].find(']').expect("its end")];
        let theirs: Vec<&str> = list.split('\'').skip(1).step_by(2).collect();
        assert_eq!(theirs, EMOJIS.to_vec());
    }

    /// The rules in the database: once per emoji per person, off of nothing is no change, the cap
    /// on different emoji, and the lines read back with theirs, under the name each reactor has.
    /// `TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55434/t cargo test -p api -- --ignored reactions_keep` against a throwaway postgres (see auth.rs's `test_db`).
    #[tokio::test]
    #[ignore]
    async fn reactions_keep_their_rules() {
        use crate::auth::tests::{row, test_db};

        let pool = test_db().await;
        let run = std::process::id();
        let room = format!("react-{run}");
        let alice_name = format!("alice9-{run}");
        let bob_name = format!("bob9-{run}");
        let alice = row(&pool, &alice_name, Some("alice-hash")).await;
        let bob = row(&pool, &bob_name, Some("bob-hash")).await;
        let line = "1729000000000-0";
        assert_eq!(set_line(&pool, &room, line, alice, "👍", true).await.unwrap(), Set::Changed);
        assert_eq!(set_line(&pool, &room, line, alice, "👍", true).await.unwrap(), Set::Same, "once per emoji per person");
        assert_eq!(set_line(&pool, &room, line, bob, "👍", true).await.unwrap(), Set::Changed);
        assert_eq!(set_line(&pool, &room, line, bob, "🔥", false).await.unwrap(), Set::Same, "off of nothing");
        for emoji in &EMOJIS[1..MAX_KINDS as usize] {
            assert_eq!(set_line(&pool, &room, line, alice, emoji, true).await.unwrap(), Set::Changed);
        }
        let past = EMOJIS[MAX_KINDS as usize];
        assert_eq!(set_line(&pool, &room, line, bob, past, true).await.unwrap(), Set::TooMany);
        assert_eq!(set_line(&pool, &room, line, bob, EMOJIS[3], true).await.unwrap(), Set::Changed, "one already there is still open");

        let mut lines = vec![crate::chat::Line {
            id: line.into(),
            from: alice_name.clone(),
            text: "hi".into(),
            streamer: false,
            verified: true,
            groups: Vec::new(),
            avatar: None,
            oauth_verified: false,
            user_id: Some(alice),
            at: 1729000000000,
            image: None,
            images: Vec::new(),
            reply: None,
            reactions: Vec::new(),
        }];
        with_reactions(&pool, Some(bob), lines.iter_mut().map(|l| (room.as_str(), l))).await;
        let first = &lines[0].reactions[0];
        assert_eq!((first.emoji.as_str(), first.count), ("👍", 2));
        assert!(first.me, "bob is one of the thumbs");
        assert!(!lines[0].reactions[1].me, "the heart is alice's alone");
        assert_eq!(first.who, vec![alice_name.clone(), bob_name.clone()]);
        assert_eq!(lines[0].reactions.len(), MAX_KINDS as usize);
        assert_eq!(set_line(&pool, &room, line, bob, "👍", false).await.unwrap(), Set::Changed);
    }

    #[test]
    fn the_names_shown_agree_with_the_threads_sql() {
        assert!(dm_reactions_sql!().contains(&format!("[1:{NAMES_SHOWN}]")));
    }
}
