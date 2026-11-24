use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::ApiError;

pub(crate) const PUBLIC_CACHE: &str = "public, max-age=86400";
pub(crate) const PRIVATE_CACHE: &str = "private, no-store";
pub(crate) const VERSIONED_CACHE: &str = "public, max-age=31536000, immutable";

pub(crate) fn is_versioned(query: Option<&str>) -> bool {
    query.is_some_and(|q| q.split('&').any(|pair| pair.strip_prefix("v=").is_some_and(|v| !v.is_empty())))
}

pub(crate) fn versioned_cache(res: Result<Response, ApiError>, query: Option<&str>) -> Result<Response, ApiError> {
    let mut res = res?;
    if is_versioned(query) {
        res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(VERSIONED_CACHE));
    }
    Ok(res)
}

pub(crate) const SESSIONS_CACHE: &str = "public, max-age=30, s-maxage=60";
pub(crate) const ABOUT_PAGE_CACHE: &str = "public, max-age=0, s-maxage=30";
pub(crate) const PROVIDERS_CACHE: &str = "public, max-age=300";
pub(crate) const EMOTE_LOOKUP_CACHE: &str = "public, max-age=60";

pub(crate) fn public_cache(value: &'static str) -> impl FnMut(Response) -> std::future::Ready<Response> + Clone + Send + 'static {
    move |mut res: Response| {
        if res.status().is_success() {
            res.headers_mut().entry(header::CACHE_CONTROL).or_insert(HeaderValue::from_static(value));
        }
        std::future::ready(res)
    }
}

pub(crate) async fn no_store_by_default(mut res: Response) -> Response {
    res.headers_mut().entry(header::CACHE_CONTROL).or_insert(HeaderValue::from_static(PRIVATE_CACHE));
    res
}

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

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Place {
    Stream { room: String },
    Group { room: String, group: String },
    Dm { a: Uuid, b: Uuid },
}

impl Place {
    pub(crate) fn room(room: &str, server: Option<&str>) -> Place {
        match server {
            Some(group) => Place::Group { room: room.to_owned(), group: group.to_owned() },
            None => Place::Stream { room: room.to_owned() },
        }
    }

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

#[derive(Debug, PartialEq)]
pub(crate) enum Refusal {
    Missing,
    NotYours,
}

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

#[derive(Debug, PartialEq)]
pub(crate) enum Access {
    Public,
    Private,
    LogIn,
    Refused,
}

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

pub(crate) async fn missing(db: &PgPool, kind: Kind, id: Uuid) -> ApiError {
    let removed: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM media_removed WHERE id = $1)").bind(id).fetch_one(db).await.unwrap_or(false);
    if removed {
        ApiError::new(StatusCode::GONE, "removed")
    } else {
        ApiError::new(StatusCode::NOT_FOUND, if kind == Kind::Image { "no such picture" } else { "no such video" })
    }
}

pub(crate) fn refused(access: &Access) -> Option<ApiError> {
    match access {
        Access::LogIn => Some(ApiError::new(StatusCode::UNAUTHORIZED, "log in to see this")),
        Access::Refused => Some(ApiError::new(StatusCode::FORBIDDEN, "not yours to see")),
        Access::Public | Access::Private => None,
    }
}

pub(crate) fn headers(out: &mut HeaderMap, public: bool) {
    out.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    out.insert(header::CACHE_CONTROL, HeaderValue::from_static(if public { PUBLIC_CACHE } else { PRIVATE_CACHE }));
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

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
    use axum::response::IntoResponse;

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

            mark_posted(&pool, kind, &[&sid], &Place::dm(bob, alice)).await.unwrap();
            mark_posted(&pool, kind, &[&sid], &Place::Stream { room: "somewhere".into() }).await.unwrap();
            let sql = format!("SELECT posted_kind, posted_dm_a, posted_dm_b FROM {} WHERE id = $1", kind.table());
            let (posted, a, b): (Option<String>, Option<Uuid>, Option<Uuid>) = sqlx::query_as(&sql).bind(id).fetch_one(&pool).await.unwrap();
            assert_eq!(posted.as_deref(), Some("dm"));
            assert_eq!((a, b), (Some(alice.min(bob)), Some(alice.max(bob))));
        }
    }

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
            let id = upload(&pool, kind, alice).await;
            assert_eq!(access(&pool, kind, id, Some(alice)).await.unwrap(), Some(Access::Private));
            assert_eq!(access(&pool, kind, id, Some(bob)).await.unwrap(), Some(Access::Refused));
            assert_eq!(access(&pool, kind, id, None).await.unwrap(), Some(Access::LogIn));

            mark_posted(&pool, kind, &[&id.to_string()], &Place::room(&format!("{group}/general"), Some(&group))).await.unwrap();
            assert_eq!(access(&pool, kind, id, Some(bob)).await.unwrap(), Some(Access::Private));
            assert_eq!(access(&pool, kind, id, Some(carol)).await.unwrap(), Some(Access::Refused));
            assert_eq!(access(&pool, kind, id, None).await.unwrap(), Some(Access::LogIn));
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

            let id = upload(&pool, kind, carol).await;
            mark_posted(&pool, kind, &[&id.to_string()], &Place::dm(carol, alice)).await.unwrap();
            assert_eq!(access(&pool, kind, id, Some(alice)).await.unwrap(), Some(Access::Private));
            assert_eq!(access(&pool, kind, id, Some(carol)).await.unwrap(), Some(Access::Private));
            assert_eq!(access(&pool, kind, id, Some(bob)).await.unwrap(), Some(Access::Refused));
            assert_eq!(access(&pool, kind, id, None).await.unwrap(), Some(Access::LogIn));

            let id = upload(&pool, kind, bob).await;
            mark_posted(&pool, kind, &[&id.to_string()], &Place::room("somestream", None)).await.unwrap();
            assert_eq!(access(&pool, kind, id, None).await.unwrap(), Some(Access::Public));
            assert_eq!(access(&pool, kind, id, Some(carol)).await.unwrap(), Some(Access::Public));

            assert_eq!(access(&pool, kind, Uuid::from_u128(rand::random()), Some(alice)).await.unwrap(), None);
        }

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
    #[test]
    fn only_a_nonempty_v_is_a_version() {
        assert!(is_versioned(Some("v=1795128838")));
        assert!(is_versioned(Some("x=1&v=7")));
        assert!(!is_versioned(Some("v=")));
        assert!(!is_versioned(Some("vv=1")));
        assert!(!is_versioned(None));
    }

    #[test]
    fn a_versioned_picture_is_immutable_and_an_unversioned_one_keeps_a_day() {
        let picture = || Ok(([(header::CACHE_CONTROL, PUBLIC_CACHE)], "jpeg").into_response());
        assert_eq!(versioned_cache(picture(), Some("v=3")).unwrap().headers()[header::CACHE_CONTROL], VERSIONED_CACHE);
        assert_eq!(versioned_cache(picture(), None).unwrap().headers()[header::CACHE_CONTROL], PUBLIC_CACHE);
        let missing = versioned_cache(Err(ApiError::new(StatusCode::NOT_FOUND, "no picture")), Some("v=3")).unwrap_err().into_response();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        assert!(missing.headers().get(header::CACHE_CONTROL).is_none());
    }

    #[tokio::test]
    async fn private_is_the_default_and_public_is_said_by_the_route() {
        use axum::middleware::map_response;
        use axum::routing::get;
        let app = axum::Router::new()
            .route("/private", get(|| async { "mine" }))
            .route("/public", get(|| async { "everyone's" }).layer(map_response(public_cache(SESSIONS_CACHE))))
            .route("/public-fails", get(|| async { StatusCode::BAD_REQUEST }).layer(map_response(public_cache(SESSIONS_CACHE))))
            .route("/picture", get(|| async { ([(header::CACHE_CONTROL, PUBLIC_CACHE)], "jpeg") }))
            .fallback(|| async { StatusCode::NOT_FOUND })
            .layer(map_response(no_store_by_default));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let http = reqwest::Client::new();
        for (path, want) in [
            ("/private", PRIVATE_CACHE),
            ("/public", SESSIONS_CACHE),
            ("/public-fails", PRIVATE_CACHE),
            ("/picture", PUBLIC_CACHE),
            ("/nowhere", PRIVATE_CACHE),
        ] {
            let res = http.get(format!("http://{addr}{path}")).send().await.unwrap();
            assert_eq!(res.headers()[header::CACHE_CONTROL], want, "{path}");
        }
        let posted = http.post(format!("http://{addr}/private")).send().await.unwrap();
        assert_eq!(posted.headers()[header::CACHE_CONTROL], PRIVATE_CACHE);
    }
}
