//! What chat pictures (chat_images.rs) and chat videos (chat_videos.rs) share: who may put one on
//! a line, who is served one, and the headers it goes out with. See docs/chat.md "who sees a
//! picture or a video" and "takedown".
//!
//! An upload is its uploader's alone until a line names it: only the uploader may put it on a
//! line, and the first line that does (`mark_posted`) says where it lives, kept on its row
//! (`posted_kind` and the rest, migration 0013). A stream's chat is public. A group's channel is
//! for the group's members, and a direct message for its two; anyone else is refused, and those
//! answers are `private, no-store`. Its uploader is always served it (the box's preview of an
//! upload not posted yet, and a member who has since left).

use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::ApiError;

/// A stream's chat picture, as it is served now.
pub(crate) const PUBLIC_CACHE: &str = "public, max-age=86400";
/// A group channel's or a direct message's: no cache but the viewer's own page keeps it.
pub(crate) const PRIVATE_CACHE: &str = "private, no-store";

/// The two tables of uploads a line names.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Kind {
    Image,
    Video,
}

impl Kind {
    fn table(self) -> &'static str {
        match self {
            Kind::Image => "chat_images",
            Kind::Video => "chat_videos",
        }
    }

    fn word(self) -> &'static str {
        match self {
            Kind::Image => "image",
            Kind::Video => "video",
        }
    }
}

/// Where a line goes.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Place {
    /// A stream's chat, by its room: public.
    Stream { room: String },
    /// A group's channel: `room` is `server/channel`, `group` the server.
    Group { room: String, group: String },
    /// A direct message between two accounts.
    Dm { a: Uuid, b: Uuid },
}

impl Place {
    /// A room's place: a server's channel (`server` given) or a stream's chat.
    pub(crate) fn room(room: &str, server: Option<&str>) -> Place {
        match server {
            Some(group) => Place::Group { room: room.to_owned(), group: group.to_owned() },
            None => Place::Stream { room: room.to_owned() },
        }
    }

    /// A direct message's, the two kept least first so either way round is the same thread.
    pub(crate) fn dm(x: Uuid, y: Uuid) -> Place {
        Place::Dm { a: x.min(y), b: x.max(y) }
    }

    fn columns(&self) -> (&'static str, Option<&str>, Option<&str>, Option<Uuid>, Option<Uuid>) {
        match self {
            Place::Stream { room } => ("stream", Some(room), None, None, None),
            Place::Group { room, group } => ("group", Some(room), Some(group), None, None),
            Place::Dm { a, b } => ("dm", None, None, Some(*a), Some(*b)),
        }
    }
}

/// Why an id may not go on a line.
#[derive(Debug, PartialEq)]
pub(crate) enum Refusal {
    /// No upload by that id (never, or taken down).
    Missing,
    /// Somebody else's upload: only its uploader may post it.
    NotYours,
}

/// May `who` put the upload `id` on a line: it is there, and it is theirs. Nothing is written;
/// `mark_posted` does that once the line is going out.
pub(crate) async fn check(db: &PgPool, kind: Kind, id: &str, who: Option<Uuid>) -> Result<Result<(), Refusal>, sqlx::Error> {
    let Ok(id) = Uuid::parse_str(id) else { return Ok(Err(Refusal::Missing)) };
    let sql = format!("SELECT created_by FROM {} WHERE id = $1", kind.table());
    let row: Option<(Option<Uuid>,)> = sqlx::query_as(&sql).bind(id).fetch_optional(db).await?;
    Ok(match row {
        None => Err(Refusal::Missing),
        Some((by,)) if by.is_some() && by == who => Ok(()),
        Some(_) => Err(Refusal::NotYours),
    })
}

/// The first line that names an upload says where it lives; a later one changes nothing.
pub(crate) async fn mark_posted(db: &PgPool, kind: Kind, ids: &[&str], place: &Place) -> Result<(), sqlx::Error> {
    let ids: Vec<Uuid> = ids.iter().filter_map(|id| Uuid::parse_str(id).ok()).collect();
    if ids.is_empty() {
        return Ok(());
    }
    let (posted, room, group, a, b) = place.columns();
    let sql = format!(
        "UPDATE {} SET posted_kind = $2, posted_room = $3, posted_group = $4, posted_dm_a = $5, posted_dm_b = $6, posted_at = now()
         WHERE id = ANY($1) AND posted_kind IS NULL",
        kind.table()
    );
    sqlx::query(&sql).bind(&ids).bind(posted).bind(room).bind(group).bind(a).bind(b).execute(db).await?;
    Ok(())
}

/// How an upload may be served to one viewer.
#[derive(Debug, PartialEq)]
pub(crate) enum Access {
    /// A stream's: anyone, cached as before.
    Public,
    /// A group's, a direct message's, or not posted yet: this viewer may, and nothing caches it.
    Private,
    /// Nobody logged in, for a private one.
    LogIn,
    /// Logged in, and not one of those it is for.
    Refused,
}

/// Who `viewer` is to the upload `id`. None: there is no such upload.
pub(crate) async fn access(db: &PgPool, kind: Kind, id: Uuid, viewer: Option<Uuid>) -> Result<Option<Access>, sqlx::Error> {
    let sql = format!(
        "SELECT x.posted_kind, x.created_by,
                (x.posted_kind = 'dm' AND $2::uuid IN (x.posted_dm_a, x.posted_dm_b))
                 OR (x.posted_kind = 'group' AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = $2 AND m.group_name = x.posted_group))
         FROM {} x WHERE x.id = $1",
        kind.table()
    );
    let row: Option<(Option<String>, Option<Uuid>, Option<bool>)> = sqlx::query_as(&sql).bind(id).bind(viewer).fetch_optional(db).await?;
    let Some((posted, by, belongs)) = row else { return Ok(None) };
    if posted.as_deref() == Some("stream") {
        return Ok(Some(Access::Public));
    }
    let Some(viewer) = viewer else { return Ok(Some(Access::LogIn)) };
    Ok(Some(if by == Some(viewer) || belongs == Some(true) { Access::Private } else { Access::Refused }))
}

/// The answer for an id with no row: 410 `removed` when an admin took it down, 404 otherwise.
pub(crate) async fn missing(db: &PgPool, kind: Kind, id: Uuid) -> ApiError {
    let removed: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM media_removed WHERE id = $1)").bind(id).fetch_one(db).await.unwrap_or(false);
    if removed {
        ApiError::new(StatusCode::GONE, "removed")
    } else {
        ApiError::new(StatusCode::NOT_FOUND, if kind == Kind::Image { "no such picture" } else { "no such video" })
    }
}

/// The refusal for a viewer `access` turned away.
pub(crate) fn refused(access: &Access) -> Option<ApiError> {
    match access {
        Access::LogIn => Some(ApiError::new(StatusCode::UNAUTHORIZED, "log in to see this")),
        Access::Refused => Some(ApiError::new(StatusCode::FORBIDDEN, "not yours to see")),
        Access::Public | Access::Private => None,
    }
}

/// Every chat picture, video and emote goes out with these: never sniffed as anything but what
/// it says it is, and cached only when it is public.
pub(crate) fn headers(out: &mut HeaderMap, public: bool) {
    out.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    out.insert(header::CACHE_CONTROL, HeaderValue::from_static(if public { PUBLIC_CACHE } else { PRIVATE_CACHE }));
}

/// The bytes' sha256 in hex, kept with each upload.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// An admin's takedown: the row out, and a note that it was, so its lines say "removed".
pub(crate) async fn remember_removed(db: &PgPool, kind: Kind, id: Uuid, by: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO media_removed (id, kind, removed_by) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING")
        .bind(id)
        .bind(kind.word())
        .bind(by)
        .execute(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_thread_is_the_same_either_way_round() {
        let (x, y) = (Uuid::from_u128(rand::random()), Uuid::from_u128(rand::random()));
        assert_eq!(Place::dm(x, y), Place::dm(y, x));
    }

    #[test]
    fn the_hash_is_hex() {
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn media_headers() {
        let mut h = HeaderMap::new();
        headers(&mut h, false);
        assert_eq!(h[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(h[header::CACHE_CONTROL], PRIVATE_CACHE);
        headers(&mut h, true);
        assert_eq!(h[header::CACHE_CONTROL], PUBLIC_CACHE);
    }

    async fn upload(pool: &PgPool, kind: Kind, by: Uuid) -> Uuid {
        let sql = match kind {
            Kind::Image => "INSERT INTO chat_images (id, mime, created_by) VALUES (gen_random_uuid(), 'image/webp', $1) RETURNING id",
            Kind::Video => {
                "WITH p AS (INSERT INTO chat_images (id, mime, created_by) VALUES (gen_random_uuid(), 'image/jpeg', $1) RETURNING id)
                 INSERT INTO chat_videos (id, mime, bytes, duration_ms, poster, created_by)
                 SELECT gen_random_uuid(), 'video/mp4', 1, 1000, p.id, $1 FROM p RETURNING id"
            }
        };
        sqlx::query_scalar(sql).bind(by).fetch_one(pool).await.expect("an upload")
    }

    /// Only the uploader may put an upload on a line, and the first line says where it lives.
    /// `TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55434/t cargo test -p api -- --ignored only_the_uploader`
    /// against a throwaway postgres (see auth.rs's `test_db`).
    #[tokio::test]
    #[ignore]
    async fn only_the_uploader_attaches_and_the_first_place_sticks() {
        use crate::auth::tests::{row, test_db};

        let pool = test_db().await;
        let run = std::process::id();
        let alice = row(&pool, &format!("alice-m{run}"), Some("h")).await;
        let bob = row(&pool, &format!("bob-m{run}"), Some("h")).await;
        for kind in [Kind::Image, Kind::Video] {
            let id = upload(&pool, kind, alice).await;
            let sid = id.to_string();
            assert_eq!(check(&pool, kind, &sid, Some(alice)).await.unwrap(), Ok(()));
            assert_eq!(check(&pool, kind, &sid, Some(bob)).await.unwrap(), Err(Refusal::NotYours), "bob may not post alice's {kind:?}");
            assert_eq!(check(&pool, kind, &sid, None).await.unwrap(), Err(Refusal::NotYours), "nor may a nick");
            let other = Uuid::from_u128(rand::random()).to_string();
            assert_eq!(check(&pool, kind, &other, Some(alice)).await.unwrap(), Err(Refusal::Missing));
            assert_eq!(check(&pool, kind, "not-an-id", Some(alice)).await.unwrap(), Err(Refusal::Missing));

            // posted in a direct message first; a later line in a stream changes nothing
            mark_posted(&pool, kind, &[&sid], &Place::dm(bob, alice)).await.unwrap();
            mark_posted(&pool, kind, &[&sid], &Place::Stream { room: "somewhere".into() }).await.unwrap();
            let sql = format!("SELECT posted_kind, posted_dm_a, posted_dm_b FROM {} WHERE id = $1", kind.table());
            let (posted, a, b): (Option<String>, Option<Uuid>, Option<Uuid>) = sqlx::query_as(&sql).bind(id).fetch_one(&pool).await.unwrap();
            assert_eq!(posted.as_deref(), Some("dm"));
            assert_eq!((a, b), (Some(alice.min(bob)), Some(alice.max(bob))));
        }
    }

    /// A group channel's upload is for the group's members, a direct message's for its two, a
    /// stream's for anyone, one not posted yet for its uploader. `TEST_DATABASE_URL=… cargo test
    /// -p api -- --ignored private_media` against a throwaway postgres (see auth.rs's `test_db`).
    #[tokio::test]
    #[ignore]
    async fn private_media_is_for_members_and_participants() {
        use crate::auth::tests::{row, test_db};

        let pool = test_db().await;
        let run = std::process::id();
        let group = format!("med{run}");
        let alice = row(&pool, &format!("alice-p{run}"), Some("h")).await;
        let bob = row(&pool, &format!("bob-p{run}"), Some("h")).await;
        let carol = row(&pool, &format!("carol-p{run}"), Some("h")).await;
        sqlx::query("INSERT INTO groups (name, badge, color) VALUES ($1, 'MED', '#5865f2')").bind(&group).execute(&pool).await.unwrap();
        for who in [alice, bob] {
            sqlx::query("INSERT INTO memberships (name, group_name, user_id) SELECT name, $1, id FROM streamers WHERE id = $2")
                .bind(&group)
                .bind(who)
                .execute(&pool)
                .await
                .unwrap();
        }
        for kind in [Kind::Image, Kind::Video] {
            // not posted yet: its uploader alone
            let id = upload(&pool, kind, alice).await;
            assert_eq!(access(&pool, kind, id, Some(alice)).await.unwrap(), Some(Access::Private));
            assert_eq!(access(&pool, kind, id, Some(bob)).await.unwrap(), Some(Access::Refused));
            assert_eq!(access(&pool, kind, id, None).await.unwrap(), Some(Access::LogIn));

            // a group's channel: its members, not carol, not nobody
            mark_posted(&pool, kind, &[&id.to_string()], &Place::room(&format!("{group}/general"), Some(&group))).await.unwrap();
            assert_eq!(access(&pool, kind, id, Some(bob)).await.unwrap(), Some(Access::Private));
            assert_eq!(access(&pool, kind, id, Some(carol)).await.unwrap(), Some(Access::Refused));
            assert_eq!(access(&pool, kind, id, None).await.unwrap(), Some(Access::LogIn));
            // bob leaves: no more; alice, the uploader, still
            sqlx::query("DELETE FROM memberships WHERE user_id = $1 AND group_name = $2").bind(bob).bind(&group).execute(&pool).await.unwrap();
            assert_eq!(access(&pool, kind, id, Some(bob)).await.unwrap(), Some(Access::Refused));
            sqlx::query("DELETE FROM memberships WHERE user_id = $1 AND group_name = $2").bind(alice).bind(&group).execute(&pool).await.unwrap();
            assert_eq!(access(&pool, kind, id, Some(alice)).await.unwrap(), Some(Access::Private));
            for who in [alice, bob] {
                sqlx::query("INSERT INTO memberships (name, group_name, user_id) SELECT name, $1, id FROM streamers WHERE id = $2")
                    .bind(&group)
                    .bind(who)
                    .execute(&pool)
                    .await
                    .unwrap();
            }

            // a direct message between alice and carol: the two of them
            let id = upload(&pool, kind, carol).await;
            mark_posted(&pool, kind, &[&id.to_string()], &Place::dm(carol, alice)).await.unwrap();
            assert_eq!(access(&pool, kind, id, Some(alice)).await.unwrap(), Some(Access::Private));
            assert_eq!(access(&pool, kind, id, Some(carol)).await.unwrap(), Some(Access::Private));
            assert_eq!(access(&pool, kind, id, Some(bob)).await.unwrap(), Some(Access::Refused));
            assert_eq!(access(&pool, kind, id, None).await.unwrap(), Some(Access::LogIn));

            // a stream's chat: anyone, logged in or not
            let id = upload(&pool, kind, bob).await;
            mark_posted(&pool, kind, &[&id.to_string()], &Place::room("somestream", None)).await.unwrap();
            assert_eq!(access(&pool, kind, id, None).await.unwrap(), Some(Access::Public));
            assert_eq!(access(&pool, kind, id, Some(carol)).await.unwrap(), Some(Access::Public));

            assert_eq!(access(&pool, kind, Uuid::from_u128(rand::random()), Some(alice)).await.unwrap(), None);
        }

        // a takedown: the poster's row may go while its video stays (ON DELETE SET NULL), and a
        // removed id answers 410
        let video = upload(&pool, Kind::Video, alice).await;
        let poster: Uuid = sqlx::query_scalar("SELECT poster FROM chat_videos WHERE id = $1").bind(video).fetch_one(&pool).await.unwrap();
        remember_removed(&pool, Kind::Image, poster, alice).await.unwrap();
        sqlx::query("DELETE FROM chat_images WHERE id = $1").bind(poster).execute(&pool).await.unwrap();
        let left: Option<Uuid> = sqlx::query_scalar("SELECT poster FROM chat_videos WHERE id = $1").bind(video).fetch_one(&pool).await.unwrap();
        assert_eq!(left, None);
        assert_eq!(missing(&pool, Kind::Image, poster).await.0, StatusCode::GONE);
        assert_eq!(missing(&pool, Kind::Image, Uuid::from_u128(rand::random())).await.0, StatusCode::NOT_FOUND);
        assert_eq!(crate::chat_videos::poster_of(&pool, &video.to_string()).await.unwrap(), None, "a video with no poster cannot go on a line");
    }
}
