import { RiTimeLine, RiUserLine } from '@remixicon/react';
import { useQuery } from '@tanstack/react-query';
import { atom, useAtomValue } from 'jotai';
import { selectAtom } from 'jotai/utils';
import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { hoverPreview } from '@/app/home/hover';
import { stillPictures } from '@/app/home/stills';
import { api, mayMakeGroup, messageOf, type LiveStream, type Person, type Recent, type Server } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { followingAtom, followingNamesAtom } from '@/infra/atoms/follow-atoms';
import { enterHome, homeErrorAtom, homeGroups, homeNowAtom, homePeople, homeStreamsAtom, leaveHome } from '@/infra/atoms/home-atoms';
import { previewStreamsAtom, setHomePreviews } from '@/infra/preview';
import { store } from '@/infra/store';
import { Avatar } from '@/shared-components/Avatar';
import { Face as PersonFace } from '@/shared-components/Face';
import { Badge } from '@/shared-components/Badge';
import { BlurredPicture } from '@/shared-components/BlurredPicture';
import { GroupSquare } from '@/shared-components/GroupSquare';
import { Button, buttonClassName } from '@/shared-components/Button';
import { FollowButton } from '@/shared-components/FollowButton';
import { MakeGroupDialog } from '@/shared-components/MakeGroupDialog';
import { PageFrame } from '@/shared-components/PageFrame';
import { usePeek } from '@/shared-components/peek';
import { PersonRow, Who } from '@/shared-components/PersonRow';
import { ProfileLink, useShowProfile } from '@/shared-components/ProfileLink';
import { PresenceSquare } from '@/shared-components/PresenceSquare';
import { Bone, Skeleton } from '@/shared-components/Skeleton';
import { ViewerCount } from '@/shared-components/ViewerCount';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';
import { compactCount } from '@/utils/count';
import { ago, since } from '@/utils/since';

const PEOPLE_POLL_MS = 10_000;
const FEATURED = 2;
const PEEK_MS = 200;

const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4';
const PEOPLE_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3';
const RECENT_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3';
const GROUPS_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-3';
const FEATURED_GRID = 'grid grid-cols-1 gap-4 lg:grid-cols-2';
const GROUPS_GUESS = 6;
const PEOPLE_GUESS = 8;

const homeHoverAtom = atom<string | null>(null);

function useHovered(name: string): boolean {
  const selector = useMemo(() => selectAtom(homeHoverAtom, (hover) => hover === name), [name]);
  return useAtomValue(selector);
}

function setHomeHover(next: string | null | ((current: string | null) => string | null)): void {
  const current = store.get(homeHoverAtom);
  store.set(homeHoverAtom, typeof next === 'function' ? next(current) : next);
}

function HomePreviews({ namesKey }: { namesKey: string }) {
  const hover = useAtomValue(homeHoverAtom);
  useEffect(() => {
    const liveNames = namesKey ? namesKey.split(',') : [];
    const names = liveNames.slice(0, FEATURED);
    if (hover && (!liveNames.includes(hover) || names.includes(hover))) store.set(homeHoverAtom, null);
    else if (hover) names.push(hover);
    setHomePreviews(names);
  }, [namesKey, hover]);
  return null;
}
const SECTION_TITLE = 'flex items-baseline gap-2 border-b-4 pb-1 text-xl font-semibold leading-tight';
const LIVE_LINE = 'border-increase';
const OFFLINE_LINE = 'border-textTertiary';
const SECTION_COUNT = 'text-textSecondary';
const CARD = 'overflow-hidden rounded-card border border-primaryStroke bg-backgroundSecondary bubble:border-transparent';
const CARD_LINK = cn(
  CARD,
  'group transition-[border-color] duration-150 hover:border-primaryBlue focus-within:border-primaryBlue bubble:hover:bg-backgroundTertiary bubble:focus-within:border-primaryBlue'
);

const PersonCard = lazy(() => import('@/shared-components/PersonCard').then((m) => ({ default: m.PersonCard })));

const stills = stillPictures({ custom: api.streamThumbUrl, camera: api.thumbUrl });

function LiveSince({ since: at }: { since: string | null }) {
  const now = useAtomValue(homeNowAtom);
  return <>{since(at, now) || 'live'}</>;
}

function TimeAgo({ at }: { at: string }) {
  const now = useAtomValue(homeNowAtom);
  return <>{ago(at, now)}</>;
}

function Thumb({ name, eager }: { name: string; eager: boolean }) {
  const [src, setSrc] = useState(() => stills.src(name, []));
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
      loading={eager ? 'eager' : 'lazy'}
      fetchPriority={eager ? 'high' : 'auto'}
      decoding={eager ? 'auto' : 'async'}
      className={cn('absolute inset-0 h-full w-full object-cover', missing && 'opacity-0')}
      onError={() => {
        if (wait.current !== null) return;
        setMissing(true);
        const next = stills.missed(name, src);
        if (!next) return;
        wait.current = window.setTimeout(() => {
          wait.current = null;
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

function Face({ stream }: { stream: LiveStream }) {
  if (stream.avatar !== null) return <Avatar name={stream.name} version={stream.avatar} className="mr-0 h-9 w-9 shrink-0" />;
  return (
    <span
      aria-hidden
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-avatar border border-primaryStroke bg-backgroundTertiary text-base font-semibold uppercase text-textSecondary"
    >
      {stream.name[0]}
    </span>
  );
}

function Card({
  stream,
  featured,
  forcePlaying = false,
  onEnter,
  onLeave,
  idPrefix = '',
  eager = false
}: {
  stream: LiveStream;
  featured: boolean;
  eager?: boolean;
  forcePlaying?: boolean;
  onEnter: (pointer: string) => void;
  onLeave: () => void;
  idPrefix?: string;
}) {
  const thumbs = stream.thumbs ?? [];
  const hovered = useHovered(stream.name);
  const playing = forcePlaying || hovered;
  return (
    <article className={CARD_LINK} data-featured={featured ? stream.name : undefined} onPointerEnter={(event) => onEnter(event.pointerType)} onPointerLeave={onLeave}>
      <Link
        to={`/watch/${encodeURIComponent(stream.name)}`}
        state={{ live: true }}
        aria-label={`watch ${stream.name}`}
        className="block outline-none"
        onFocus={() => onEnter('keyboard')}
        onBlur={onLeave}
      >
        <div className="relative aspect-video overflow-hidden border-b border-primaryStroke bg-black bubble:m-1.5 bubble:mb-0 bubble:rounded-card bubble:border-b-0">
          <div className="absolute inset-0 transition-transform duration-300 ease-out group-hover:scale-105">
            {thumbs.length > 0 ? (
              <BlurredPicture
                name={stream.name}
                version={stream.avatar}
                src={stills.src(stream.name, thumbs)}
                loading={eager ? 'eager' : 'lazy'}
                fetchPriority={eager ? 'high' : 'auto'}
              />
            ) : (
              <>
                {stream.avatar !== null && <BlurredPicture name={stream.name} version={stream.avatar} />}
                <Thumb name={stream.name} eager={eager} />
              </>
            )}
            {playing && <PreviewVideo name={stream.name} />}
          </div>
          <span className="absolute right-3 top-3 z-10 flex items-center gap-1.5 rounded-control border border-white/10 bg-black/70 px-2 py-0.5 text-sm font-semibold uppercase tracking-wide text-white backdrop-blur-sm">
            <span aria-hidden className="h-2 w-2 animate-pulse bg-increase bubble:rounded-avatar" />
            <LiveSince since={stream.since} />
          </span>
          {typeof stream.viewers === 'number' && (
            <span className="absolute bottom-3 right-3 z-10 rounded-control border border-white/10 bg-black/70 px-2 py-0.5 text-sm font-semibold text-white backdrop-blur-sm">
              <ViewerCount id={`${idPrefix}viewers-${stream.name}`} count={stream.viewers} />
            </span>
          )}
        </div>
        <div className="flex items-start gap-2.5 px-3 py-2.5">
          <Face stream={stream} />
          <div className="min-w-0 flex-1">
            <h2 className="flex min-w-0 items-center text-base font-semibold leading-5">
              <span className="truncate">{stream.name}</span>
              {stream.verified && (
                <Tooltip content="verified">
                  <span role="img" aria-label="has an account" className="ml-1.5 shrink-0 text-increase">
                    ✓
                  </span>
                </Tooltip>
              )}
              {stream.badge && <Badge group={stream.badge} className="ml-1.5 shrink-0" />}
            </h2>
            {stream.bio && <p className="mt-0.5 line-clamp-2 text-sm leading-snug text-textSecondary [overflow-wrap:anywhere]">{stream.bio}</p>}
          </div>
        </div>
      </Link>
    </article>
  );
}

function Part({ id, title, line, heading, aside, children }: { id: string; title: string; line: string; heading: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} data-title={title}>
      <h2 className="sticky top-0 z-30 flex h-16 w-fit items-center gap-4 max-md:static">
        <span id={`${id}-title`} className={cn(SECTION_TITLE, line)}>
          {heading}
        </span>
        {aside}
      </h2>
      <div className="pb-6">{children}</div>
    </section>
  );
}

function Followed({
  streams,
  featuredNames,
  onEnter,
  onLeave
}: {
  streams: LiveStream[];
  featuredNames: string[];
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
      title="following"
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
              featured={false}
              forcePlaying={featuredNames.includes(stream.name)}
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

const PersonTile = memo(function PersonTile({
  name,
  verified,
  oauthVerified,
  avatar,
  bio,
  presence
}: {
  name: string;
  verified: boolean;
  oauthVerified: boolean | undefined;
  avatar: number | null;
  bio: string;
  presence: Person['presence'];
}) {
  return (
    <article id={`person-${name}`} data-presence={presence} className={cn(CARD_LINK, 'flex items-center gap-2 p-3')}>
      <PersonRow
        id={`person-link-${name}`}
        name={name}
        verified={verified}
        oauthVerified={oauthVerified}
        avatar={avatar}
        bio={bio}
        presence={presence}
        size="card"
      />
      <FollowButton id={`person-follow-${name}`} name={name} small className="self-start" />
    </article>
  );
});

function People() {
  const people = useQuery({ queryKey: ['people'], queryFn: homePeople, refetchInterval: PEOPLE_POLL_MS });
  const list: Person[] = people.data ?? [];
  if (people.isPending) {
    return (
      <Part id="people" title="people" line={OFFLINE_LINE} heading="people">
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
      title="people"
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
          <PersonTile
            key={p.name}
            name={p.name}
            verified={p.verified}
            oauthVerified={p.oauth_verified}
            avatar={p.avatar}
            bio={p.bio}
            presence={p.presence}
          />
        ))}
      </div>
    </Part>
  );
}

function RecentCard({ person: p }: { person: Recent }) {
  const peek = usePeek(PEEK_MS);
  const { show } = useShowProfile();
  const target = { name: p.name, verified: p.verified, oauth_verified: p.oauth_verified, avatar: p.avatar };
  const open = () => {
    peek.close();
    show(target);
  };
  return (
    <article
      id={`recent-${p.name}`}
      data-presence={p.presence}
      className={cn(CARD_LINK, 'relative flex cursor-pointer items-center gap-2 p-2.5')}
      onPointerEnter={(e) => peek.show(e, e.currentTarget)}
      onPointerLeave={(e) => peek.leave(e.currentTarget)}
      onPointerDown={(e) => {
        if (e.target instanceof Element && e.target.closest('button, a') && !e.target.closest('[data-peek-hold]')) peek.close();
      }}
      onFocus={(e) => {
        if (!e.target.closest('button')) peek.focus(e, e.currentTarget);
      }}
      onBlur={peek.blur}
      onKeyDown={peek.keyDown}
    >
      <div className="relative flex shrink-0">
        <PersonFace name={p.name} version={p.avatar} className="h-10 w-10 text-base" />
        <PresenceSquare status={p.presence} className="border-backgroundSecondary" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <ProfileLink
          id={`recent-link-${p.name}`}
          person={target}
          className="flex min-w-0 border border-transparent outline-none after:absolute after:inset-0 focus-visible:border-primaryBlue"
        >
          <Who name={p.name} verified={p.verified} oauthVerified={p.oauth_verified} className="text-base" />
        </ProfileLink>
        <div className="flex items-center gap-1.5 text-xs text-textTertiary">
          <RiTimeLine aria-hidden size={12} className="shrink-0" />
          <Tooltip content={new Date(p.ended_at).toLocaleString()}>
            <span id={`recent-when-${p.name}`} className="relative z-10 whitespace-nowrap" onClick={open}>
              <TimeAgo at={p.ended_at} />
            </span>
          </Tooltip>
          <span aria-hidden>·</span>
          <Tooltip content={`${p.followers} ${p.followers === 1 ? 'follower' : 'followers'}`}>
            <span
              id={`recent-followers-${p.name}`}
              role="img"
              aria-label={`${p.followers} ${p.followers === 1 ? 'follower' : 'followers'}`}
              className="relative z-10 flex items-center gap-1 tabular-nums"
              onClick={open}
            >
              <RiUserLine aria-hidden size={12} />
              {compactCount(p.followers)}
            </span>
          </Tooltip>
        </div>
      </div>
      <FollowButton id={`recent-follow-${p.name}`} name={p.name} compact className="relative z-10 shrink-0 self-center" />
      {peek.at && (
        <Suspense fallback={null}>
          <PersonCard id={`recent-peek-${p.name}`} person={p} at={peek.at} follow hold={peek.hold} />
        </Suspense>
      )}
    </article>
  );
}

function RecentlyOffline({ liveKey }: { liveKey: string | null }) {
  const recent = useQuery({
    queryKey: ['recent'],
    queryFn: api.recent,
    refetchInterval: PEOPLE_POLL_MS
  });
  const seenKey = useRef<string | null>(null);
  const { refetch } = recent;

  useEffect(() => {
    if (liveKey === null) return;
    if (seenKey.current !== null && seenKey.current !== liveKey) void refetch();
    seenKey.current = liveKey;
  }, [liveKey, refetch]);

  const list: Recent[] = recent.data ?? [];
  if (!recent.data || list.length === 0) return null;
  return (
    <Part
      id="recent"
      title="recently offline"
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
          <RecentCard key={p.name} person={p} />
        ))}
      </div>
    </Part>
  );
}

function Groups() {
  const me = useAtomValue(meAtom);
  const [making, setMaking] = useState(false);
  const query = useQuery({ queryKey: ['explore'], queryFn: homeGroups, refetchInterval: PEOPLE_POLL_MS });
  const groups: Server[] = query.data ? [...query.data.yours, ...query.data.discover].filter((group) => group.mine || group.public !== false) : [];
  const loading = !query.data && !query.error;
  const canMake = !!me && !!query.data && mayMakeGroup(query.data);
  return (
    <Part
      id="home-groups"
      title="groups"
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
      aside={
        canMake && (
          <Button id="home-groups-create" variant="primary" className="px-3 py-1.5 text-sm" onClick={() => setMaking(true)}>
            create group
          </Button>
        )
      }
    >
      {making && <MakeGroupDialog onClose={() => setMaking(false)} />}
      {loading && (
        <Skeleton id="home-groups-loading" className={GROUPS_GRID}>
          {Array.from({ length: GROUPS_GUESS }, (_, i) => (
            <Bone key={i} className="aspect-square rounded-card" />
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
  const streams = useAtomValue(homeStreamsAtom);
  const error = useAtomValue(homeErrorAtom);
  const list = error ? undefined : streams;
  const featured = list?.slice(0, FEATURED) ?? [];
  const rest = list?.slice(FEATURED) ?? [];
  const namesKey = (list ?? []).map((stream) => stream.name).join(',');
  const [cardHover] = useState(() => hoverPreview(window, setHomeHover));

  useEffect(() => {
    enterHome();
    return leaveHome;
  }, []);

  useEffect(
    () => () => {
      cardHover.dispose();
      setHomePreviews([]);
    },
    []
  );

  return (
    <PageFrame wide>
      <Part
        id="live"
        title="active streams"
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
            <p className="text-textSecondary">nobody is live</p>
            <Link to="/live" className={buttonClassName('primary', 'mt-5')}>
              go live
            </Link>
          </div>
        )}
        <div id="list" className={cn(!list?.length && 'hidden')}>
          {featured.length > 0 && (
            <div id="featured" className={cn(FEATURED_GRID, rest.length > 0 && 'mb-6')}>
              {featured.map((stream) => (
                <Card key={stream.name} stream={stream} featured eager forcePlaying onEnter={() => undefined} onLeave={() => undefined} />
              ))}
            </div>
          )}
          {rest.length > 0 && (
            <div className={GRID}>
              {rest.map((stream) => (
                <Card
                  key={stream.name}
                  stream={stream}
                  featured={false}
                  onEnter={(pointer) => cardHover.enter(stream.name, pointer, store.get(homeHoverAtom))}
                  onLeave={() => cardHover.leave(stream.name)}
                />
              ))}
            </div>
          )}
        </div>
      </Part>
      <HomePreviews namesKey={namesKey} />
      {list && (
        <Followed
          streams={list}
          featuredNames={featured.map((stream) => stream.name)}
          onEnter={(name, pointer) => cardHover.enter(name, pointer, store.get(homeHoverAtom))}
          onLeave={(name) => cardHover.leave(name)}
        />
      )}
      {!error && <RecentlyOffline liveKey={list ? namesKey : null} />}
      {!error && <Groups />}
      {!error && <People />}
    </PageFrame>
  );
}
