import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useAtomValue } from 'jotai';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { hoverPreview } from '@/app/home/hover';
import { stillPictures } from '@/app/home/stills';
import { api, messageOf, type LiveStream, type Person, type Recent, type Server } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { followingAtom, followingNamesAtom } from '@/infra/atoms/follow-atoms';
import { enterHome, homeErrorAtom, homeNowAtom, homeStreamsAtom, leaveHome } from '@/infra/atoms/home-atoms';
import { isDummyName } from '@/infra/names';
import { previewStreamsAtom, setHomePreviews } from '@/infra/preview';
import { Avatar } from '@/shared-components/Avatar';
import { GroupSquare } from '@/shared-components/GroupSquare';
import { buttonClassName } from '@/shared-components/Button';
import { FollowButton } from '@/shared-components/FollowButton';
import { PageFrame } from '@/shared-components/PageFrame';
import { PersonRow } from '@/shared-components/PersonRow';
import { Bone, Skeleton } from '@/shared-components/Skeleton';
import { TestBadge } from '@/shared-components/TestBadge';
import { ViewerCount } from '@/shared-components/ViewerCount';
import { cn } from '@/utils/cn';
import { ago, since } from '@/utils/since';

/** The people under the streams: who is here changes by the minute, not the second. */
const PEOPLE_POLL_MS = 10_000;
/** The first two cards, played live at the top: the streams that came first, until the home service ranks them. */
const FEATURED = 2;

/** One card per column, as many columns as fit: 1 on a phone, 2 on a tablet, 4 at full width. */
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-6';
/** The smaller grid of the people: a rectangle each, as many as fit. */
const PEOPLE_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3';
/** The recently offline: the same rectangle, the live cards' width, so "last live 12 min ago" has room beside the face and the button. */
const RECENT_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3';
/** The groups as squares, as many as fit. */
const GROUPS_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-3';
/** The two cards played live at the top, side by side at lg and up. */
const FEATURED_GRID = 'grid grid-cols-1 gap-6 lg:grid-cols-2';
/** How many grey squares and rectangles stand in for the groups and the people before they have answered. */
const GROUPS_GUESS = 6;
const PEOPLE_GUESS = 8;
/**
 * The words of a part's heading (`Part`): `active streams`, `recently offline`, `groups`,
 * `people`. The words and the count over a fat line as wide as they are, the line's colour saying
 * what the part holds: green under the live, grey under the rest. 33px tall in all, so in the title
 * row it stays inside go live's 38.
 */
const SECTION_TITLE = 'flex items-baseline gap-2 border-b-4 pb-1 text-xl font-semibold leading-tight';
const LIVE_LINE = 'border-increase';
const OFFLINE_LINE = 'border-textTertiary';
/** The number beside the words, a step quieter. */
const SECTION_COUNT = 'text-textSecondary';
/**
 * A card is the panel look without its offset shadow: in a grid, the offsets read as a second
 * box behind every stream. The stroke goes blue on hover and keyboard focus instead.
 */
const CARD = 'border border-primaryStroke bg-backgroundSecondary';
const CARD_LINK = cn(CARD, 'group transition-[border-color] duration-150 hover:border-primaryBlue focus-within:border-primaryBlue');

/** One per page load, so a refresh can land on a different picture and a sitting page never does. */
const stills = stillPictures({ custom: api.streamThumbUrl, camera: api.thumbUrl });

/**
 * One picture for the whole visit. The streamer's own when they put some, else one frame
 * of the camera. A 404 on that first frame (it takes ~6s, home lists the stream within 3s)
 * asks again, and then the url stays: the next bucket used to swap the picture under you.
 */
function Thumb({ name, thumbs }: { name: string; thumbs: number[] }) {
  const [src, setSrc] = useState(() => stills.src(name, thumbs));
  const [missing, setMissing] = useState(false);
  const wait = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (wait.current !== null) clearTimeout(wait.current);
    },
    []
  );

  return (
    <img
      src={src}
      alt=""
      draggable={false}
      data-thumb={name}
      className={cn('absolute inset-0 h-full w-full object-cover', missing && 'opacity-0')}
      onError={() => {
        if (wait.current !== null) return;
        const next = stills.missed(name);
        if (!next) {
          setMissing(true);
          return;
        }
        wait.current = window.setTimeout(() => {
          wait.current = null;
          setMissing(false);
          setSrc(next);
        }, 2000);
      }}
      onLoad={() => {
        stills.loaded(name);
        setMissing(false);
      }}
    />
  );
}

/**
 * The camera, once it is playing. Until then the still underneath shows, on the featured cards too:
 * a preview that video refused, or that is still connecting, is a picture and not a black box.
 */
function PreviewVideo({ name }: { name: string }) {
  const stream = useAtomValue(previewStreamsAtom)[name] ?? null;
  const ref = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    setPlaying(false);
    const el = ref.current;
    if (!el || el.srcObject === stream) return;
    el.srcObject = stream;
    if (stream) void el.play().catch(() => undefined);
  }, [stream]);

  return (
    <video
      ref={ref}
      data-preview={name}
      autoPlay
      playsInline
      muted
      aria-hidden
      onPlaying={() => setPlaying(true)}
      className={cn('absolute inset-0 h-full w-full object-cover', !playing && 'opacity-0')}
    />
  );
}

/** The streamer's picture, or their first letter when they have none, so every card lines up the same. */
function Face({ stream }: { stream: LiveStream }) {
  if (stream.avatar !== null) return <Avatar name={stream.name} version={stream.avatar} className="mr-0 h-11 w-11 shrink-0" />;
  return (
    <span
      aria-hidden
      className="flex h-11 w-11 shrink-0 items-center justify-center border border-primaryStroke bg-backgroundTertiary text-lg font-semibold uppercase text-textSecondary"
    >
      {stream.name[0]}
    </span>
  );
}

function Card({
  stream,
  now,
  featured,
  playing,
  onEnter,
  onLeave,
  idPrefix = ''
}: {
  stream: LiveStream;
  now: number;
  featured: boolean;
  playing: boolean;
  /** A mouse or keyboard arrival. Touch is passed through and ignored: a tap is the click. */
  onEnter: (pointer: string) => void;
  onLeave: () => void;
  /** Before the ids on the card (`viewers-<name>`), for a card that is on the page a second time (the following part). */
  idPrefix?: string;
}) {
  const age = since(stream.since, now);
  return (
    <article className={CARD_LINK} data-featured={featured ? stream.name : undefined} onPointerEnter={(event) => onEnter(event.pointerType)} onPointerLeave={onLeave}>
      <Link
        to={`/watch/${encodeURIComponent(stream.name)}`}
        // a card is a stream: the page holds the player's box from its first paint (WatchPage.tsx)
        state={{ live: true }}
        aria-label={`watch ${stream.name}`}
        className="block outline-none"
        onFocus={() => onEnter('keyboard')}
        onBlur={onLeave}
      >
        {/* one chip, top right: "live for 52 hr". the fake streams draw their name top-left and a clock bottom-left */}
        <div className="relative aspect-video overflow-hidden border-b border-primaryStroke bg-black">
          <div className="absolute inset-0 transition-transform duration-300 ease-out group-hover:scale-105">
            <Thumb name={stream.name} thumbs={stream.thumbs ?? []} />
            {playing && <PreviewVideo name={stream.name} />}
          </div>
          <span className="absolute right-3 top-3 z-10 flex items-center gap-1.5 border border-white/10 bg-black/70 px-2 py-0.5 text-sm font-semibold uppercase tracking-wide text-white backdrop-blur-sm">
            <span aria-hidden className="h-2 w-2 animate-pulse bg-increase" />
            {age || 'live'}
          </span>
          {/* bottom right, "3 watching": null when video did not answer (the list came from redis), absent on an older api. a chip only when there is a number to show */}
          {typeof stream.viewers === 'number' && (
            <span className="absolute bottom-3 right-3 z-10 border border-white/10 bg-black/70 px-2 py-0.5 text-sm font-semibold text-white backdrop-blur-sm">
              <ViewerCount id={`${idPrefix}viewers-${stream.name}`} count={stream.viewers} />
            </span>
          )}
        </div>
        <div className="flex items-start gap-3 p-4">
          <Face stream={stream} />
          <div className="min-w-0 flex-1">
            <h2 className="flex min-w-0 items-center text-xl font-semibold leading-tight">
              <span className="truncate">{stream.name}</span>
              {stream.verified && (
                <span className="ml-1.5 shrink-0 text-increase" title="has an account: this really is them">
                  ✓
                </span>
              )}
              {isDummyName(stream.name) && (
                <span className="shrink-0">
                  <TestBadge />
                </span>
              )}
            </h2>
            {stream.bio && <p className="mt-1 line-clamp-2 text-base leading-snug text-textSecondary [overflow-wrap:anywhere]">{stream.bio}</p>}
          </div>
        </div>
      </Link>
    </article>
  );
}

/**
 * One part of the page under its heading (`#<id>`, `#<id>-title`). The heading is sticky and as
 * tall as the title row (PageFrame.tsx, 4rem), whose left end it stands in: on home the row is only
 * the bell and go live, and the page starts at its top, so `active streams` sits in the row at the
 * top of the page, and once the live cards have scrolled away the next part's heading pushes it out
 * and takes its place (a login's following, then the recently offline, the groups, the people), the
 * way a phone's contact list does its letters. The room under a part is padding inside it rather than a margin before the
 * next, so the push comes exactly when the part ends and not a gap later. The same z as the row
 * and later in the document, so the heading paints over it; the sidebar open (z-40) covers both.
 */
function Part({ id, line, heading, children }: { id: string; line: string; heading: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="sticky top-0 z-30 flex h-16 w-fit items-center">
        <span className={cn(SECTION_TITLE, line)}>{heading}</span>
      </h2>
      <div className="pb-6">{children}</div>
    </section>
  );
}

/**
 * The streams of who you follow (docs/follows.md), under the active streams: their cards again,
 * so yours are found without reading the whole grid (a stream in both places is in both; that
 * is the point). For a login who follows someone; the count is how many of them are live, and
 * with none it says so. Who you follow is the sidebar's list, asked at login and on every open
 * of the panel; who is live is the page's own list, so a card here goes the moment the stream
 * ends, with its card above. A card plays on hover like the grid's; one whose stream is already
 * playing at the top plays here too, since that preview is up anyway.
 */
function Followed({
  streams,
  now,
  featuredNames,
  hover,
  onEnter,
  onLeave
}: {
  streams: LiveStream[];
  now: number;
  featuredNames: string[];
  hover: string | null;
  onEnter: (name: string, pointer: string) => void;
  onLeave: (name: string) => void;
}) {
  const me = useAtomValue(meAtom);
  const following = useAtomValue(followingAtom);
  const names = useAtomValue(followingNamesAtom);
  if (!me || !following || following.length === 0) return null;
  const list = streams.filter((stream) => names.has(stream.name));
  return (
    <Part
      id="followed"
      line={LIVE_LINE}
      heading={
        <>
          following
          <span id="followed-count" className={SECTION_COUNT}>
            {list.length}
          </span>
        </>
      }
    >
      {list.length === 0 && <p className="text-textSecondary">nobody you follow is live right now.</p>}
      {list.length > 0 && (
        <div id="followed-list" className={GRID}>
          {list.map((stream) => (
            <Card
              key={stream.name}
              stream={stream}
              now={now}
              featured={false}
              playing={featuredNames.includes(stream.name) || hover === stream.name}
              onEnter={(pointer) => onEnter(stream.name, pointer)}
              onLeave={() => onLeave(stream.name)}
              idPrefix="followed-"
            />
          ))}
        </div>
      )}
    </Part>
  );
}

/**
 * Everyone who is not live, under the streams (docs/follows.md): a rectangle each, the face, the
 * name with its marks, the word beside it, a line of the bio, and the follow button. Online
 * first, the api's order. The fake streams are people too when they are not on.
 */
function People() {
  const people = useQuery({ queryKey: ['people'], queryFn: api.people, refetchInterval: PEOPLE_POLL_MS, refetchOnWindowFocus: false });
  const list: Person[] = people.data ?? [];
  // before the first answer: the heading and a row of grey rectangles, the people's shape, so the part is
  // there from the first paint instead of arriving under the groups
  if (people.isPending) {
    return (
      <Part id="people" line={OFFLINE_LINE} heading="people">
        <Skeleton id="people-loading" className={PEOPLE_GRID}>
          {Array.from({ length: PEOPLE_GUESS }, (_, i) => (
            <div key={i} className={cn(CARD, 'flex items-center gap-3 p-3')}>
              <Bone className="h-12 w-12 shrink-0" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Bone className="h-4 w-1/2" />
                <Bone className="h-3 w-1/3" />
              </div>
            </div>
          ))}
        </Skeleton>
      </Part>
    );
  }
  if (!people.data || list.length === 0) return null;
  const here = list.filter((p) => p.presence !== 'offline').length;
  return (
    <Part
      id="people"
      line={OFFLINE_LINE}
      heading={
        <>
          people
          <span id="people-count" className={SECTION_COUNT}>
            {list.length}
          </span>
          {here > 0 && (
            <>
              <span aria-hidden>·</span>
              <span id="people-here" className="text-increase">
                {here} here
              </span>
            </>
          )}
        </>
      }
    >
      <div className={PEOPLE_GRID}>
        {list.map((p) => (
          <article key={p.name} id={`person-${p.name}`} data-presence={p.presence} className={cn(CARD_LINK, 'flex items-center gap-2 p-3')}>
            <PersonRow id={`person-link-${p.name}`} name={p.name} verified={p.verified} avatar={p.avatar} bio={p.bio} presence={p.presence} size="card" />
            <FollowButton id={`person-follow-${p.name}`} name={p.name} small className="self-start" />
          </article>
        ))}
      </div>
    </Part>
  );
}

/**
 * Who was live lately and is not now, under the live cards (docs/follows.md): the people's
 * rectangle, with a line saying when the last stream ended, "last live 3 hr ago", on the page's
 * clock. Newest end first, the api's order and cut. Asked again on the people's cadence, and the
 * moment the live set changes: a card that just left the grid above lands here without the wait.
 */
function RecentlyOffline({ liveKey, now }: { liveKey: string; now: number }) {
  const recent = useQuery({
    queryKey: ['recent', liveKey],
    queryFn: api.recent,
    placeholderData: keepPreviousData,
    refetchInterval: PEOPLE_POLL_MS,
    refetchOnWindowFocus: false
  });
  const list: Recent[] = recent.data ?? [];
  if (!recent.data || list.length === 0) return null;
  return (
    <Part
      id="recent"
      line={OFFLINE_LINE}
      heading={
        <>
          recently offline
          <span id="recent-count" className={SECTION_COUNT}>
            {list.length}
          </span>
        </>
      }
    >
      <div className={RECENT_GRID}>
        {list.map((p) => (
          <article key={p.name} id={`recent-${p.name}`} data-presence={p.presence} className={cn(CARD_LINK, 'flex items-center gap-2 p-3')}>
            <PersonRow
              id={`recent-link-${p.name}`}
              name={p.name}
              verified={p.verified}
              avatar={p.avatar}
              bio={p.bio}
              presence={p.presence}
              size="card"
              note={
                <span id={`recent-when-${p.name}`} title={new Date(p.ended_at).toLocaleString()}>
                  last live {ago(p.ended_at, now)}
                </span>
              }
            />
            <FollowButton id={`recent-follow-${p.name}`} name={p.name} small className="self-start" />
          </article>
        ))}
      </div>
    </Part>
  );
}

/** Every group but `bot`, under recently offline: yours and the public ones, as squares. The heading opens the list. */
function Groups() {
  const query = useQuery({ queryKey: ['explore'], queryFn: api.explore, refetchInterval: PEOPLE_POLL_MS, refetchOnWindowFocus: false });
  const groups: Server[] = query.data ? [...query.data.yours, ...query.data.discover].filter((group) => group.mine || group.public !== false) : [];
  const loading = !query.data && !query.error;
  return (
    <Part
      id="home-groups"
      line={OFFLINE_LINE}
      heading={
        <>
          <Link id="groups-home" to="/groups" className="hover:text-primaryBlue">
            groups
          </Link>
          {query.data && (
            <span id="groups-count" className={SECTION_COUNT}>
              {groups.length}
            </span>
          )}
        </>
      }
    >
      {/* before the first answer: a row of grey squares, the groups' shape. the part always shows once asked (`no groups yet.` for none), so the grey never comes to nothing */}
      {loading && (
        <Skeleton id="home-groups-loading" className={GROUPS_GRID}>
          {Array.from({ length: GROUPS_GUESS }, (_, i) => (
            <Bone key={i} className="aspect-square" />
          ))}
        </Skeleton>
      )}
      {query.error && <p className="text-textSecondary">{messageOf(query.error)}</p>}
      {query.data && groups.length === 0 && <p className="text-textSecondary">no groups yet.</p>}
      {groups.length > 0 && (
        <ul className={GROUPS_GRID}>
          {groups.map((group) => (
            <GroupSquare key={group.name} server={group} id={`home-group-${group.name}`} />
          ))}
        </ul>
      )}
    </Part>
  );
}

/**
 * The featured cards' worth of grey, in their grid, for the moment before the first answer: the
 * top of the page as it is on a day with streams, so the two that come land where the grey was.
 */
function StreamsSkeleton() {
  return (
    <Skeleton id="loading" className={FEATURED_GRID}>
      {Array.from({ length: FEATURED }, (_, i) => (
        <div key={i} className={CARD}>
          <div className="relative aspect-video border-b border-primaryStroke">
            <Bone className="absolute inset-0" />
          </div>
          <div className="flex items-start gap-3 p-4">
            <Bone className="h-11 w-11 shrink-0" />
            <div className="flex flex-1 flex-col gap-2 py-1">
              <Bone className="h-5 w-1/2" />
              <Bone className="h-4 w-5/6" />
            </div>
          </div>
        </div>
      ))}
    </Skeleton>
  );
}

export function HomePage() {
  // the list is one snapshot and then the facts over the events socket (home-atoms); nothing
  // polls. the clock is the module's 1s tick, so the render never reads the time itself. the
  // picture does not move with either: one still per visit
  const streams = useAtomValue(homeStreamsAtom);
  const error = useAtomValue(homeErrorAtom);
  const now = useAtomValue(homeNowAtom);
  const list = error ? undefined : streams;
  const featured = list?.slice(0, FEATURED) ?? [];
  const rest = list?.slice(FEATURED) ?? [];
  const namesKey = (list ?? []).map((stream) => stream.name).join(',');
  const [hover, setHover] = useState<string | null>(null);
  const [cardHover] = useState(() => hoverPreview(window, setHover));

  // mount only: the feed and the snapshot on, and off on the way out
  useEffect(() => {
    enterHome();
    return leaveHome;
  }, []);

  useEffect(() => {
    const liveNames = namesKey ? namesKey.split(',') : [];
    const names = liveNames.slice(0, FEATURED);
    // gone offline, or moved up into featured: those cards' handlers are noops, so nothing would ever hang it up
    if (hover && (!liveNames.includes(hover) || names.includes(hover))) setHover(null);
    else if (hover) names.push(hover);
    setHomePreviews(names);
  }, [namesKey, hover]);

  useEffect(
    () => () => {
      cardHover.dispose();
      setHomePreviews([]);
    },
    []
  );

  // no title: the row is the bell and go live, `active streams` with its count is the first part's
  // heading standing in it (Part), and the cards are the page. search is the sidebar's. the empty
  // state has go live again.
  return (
    <PageFrame wide>
      <Part
        id="live"
        line={LIVE_LINE}
        heading={
          <>
            active streams
            {list && (
              <span id="live-count" className={SECTION_COUNT}>
                {list.length}
              </span>
            )}
          </>
        }
      >
        {error && (
          <p className="border border-decrease/40 bg-decrease/10 px-5 py-4 text-textSecondary" aria-live="polite">
            api is down: {error}
          </p>
        )}
        {!error && !streams && <StreamsSkeleton />}
        {list?.length === 0 && (
          <div id="empty" className="border border-dashed border-secondaryStroke px-6 py-16 text-center" aria-live="polite">
            <p className="text-textSecondary">nobody is live. you could be.</p>
            <Link to="/live" className={buttonClassName('primary', 'mt-5')}>
              go live
            </Link>
          </div>
        )}
        <div id="list" className={cn(!list?.length && 'hidden')}>
          {featured.length > 0 && (
            <div id="featured" className={cn(FEATURED_GRID, rest.length > 0 && 'mb-6')}>
              {featured.map((stream) => (
                <Card key={stream.name} stream={stream} now={now} featured playing onEnter={() => undefined} onLeave={() => undefined} />
              ))}
            </div>
          )}
          {rest.length > 0 && (
            <div className={GRID}>
              {rest.map((stream) => (
                <Card
                  key={stream.name}
                  stream={stream}
                  now={now}
                  featured={false}
                  playing={hover === stream.name}
                  onEnter={(pointer) => cardHover.enter(stream.name, pointer, hover)}
                  onLeave={() => cardHover.leave(stream.name)}
                />
              ))}
            </div>
          )}
        </div>
      </Part>
      {list && (
        <Followed
          streams={list}
          now={now}
          featuredNames={featured.map((stream) => stream.name)}
          hover={hover}
          onEnter={(name, pointer) => cardHover.enter(name, pointer, hover)}
          onLeave={(name) => cardHover.leave(name)}
        />
      )}
      {!error && <RecentlyOffline liveKey={namesKey} now={now} />}
      {!error && <Groups />}
      {!error && <People />}
    </PageFrame>
  );
}
