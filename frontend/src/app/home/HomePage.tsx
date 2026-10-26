import { useQuery } from '@tanstack/react-query';
import { useAtomValue } from 'jotai';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { hoverPreview } from '@/app/home/hover';
import { stillPictures } from '@/app/home/stills';
import { api, messageOf, type LiveStream, type Person } from '@/infra/api';
import { isDummyName } from '@/infra/names';
import { previewStreamsAtom, setHomePreviews } from '@/infra/preview';
import { Avatar } from '@/shared-components/Avatar';
import { buttonClassName } from '@/shared-components/Button';
import { FollowButton } from '@/shared-components/FollowButton';
import { PageFrame } from '@/shared-components/PageFrame';
import { PersonRow } from '@/shared-components/PersonRow';
import { SearchBox } from '@/shared-components/SearchBox';
import { TestBadge } from '@/shared-components/TestBadge';
import { ViewerCount } from '@/shared-components/ViewerCount';
import { cn } from '@/utils/cn';
import { since } from '@/utils/since';

const POLL_MS = 3000;
/** The people under the streams: who is here changes by the minute, not the second. */
const PEOPLE_POLL_MS = 10_000;
/** The newest streams, played live at the top. There is no viewer count to rank by. */
const FEATURED = 2;

/** One card per column, as many columns as fit: 1 on a phone, 2 on a tablet, 4 at full width. */
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-6';
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
  onLeave
}: {
  stream: LiveStream;
  now: number;
  featured: boolean;
  playing: boolean;
  /** A mouse or keyboard arrival. Touch is passed through and ignored: a tap is the click. */
  onEnter: (pointer: string) => void;
  onLeave: () => void;
}) {
  const age = since(stream.since, now);
  return (
    <article
      className={CARD_LINK}
      data-featured={featured ? stream.name : undefined}
      onPointerEnter={(event) => onEnter(event.pointerType)}
      onPointerLeave={onLeave}
    >
      <Link
        to={`/watch/${encodeURIComponent(stream.name)}`}
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
          {/* /api/streams does not send `viewers` yet, so it arrives undefined: a chip only when there is a number to show */}
          {typeof stream.viewers === 'number' && (
            <span className="absolute bottom-3 right-3 z-10 border border-white/10 bg-black/70 px-2 py-0.5 text-sm font-semibold text-white backdrop-blur-sm">
              <ViewerCount count={stream.viewers} />
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
 * Everyone who is not live, under the streams (docs/follows.md): a rectangle each, the face, the
 * name with its marks, the word beside it, a line of the bio, and the follow button. Online
 * first, the api's order. The fake streams are people too when they are not on.
 */
function People() {
  const people = useQuery({ queryKey: ['people'], queryFn: api.people, refetchInterval: PEOPLE_POLL_MS, refetchOnWindowFocus: false });
  const list: Person[] = people.data ?? [];
  if (!people.data || list.length === 0) return null;
  const here = list.filter((p) => p.presence !== 'offline').length;
  return (
    <section id="people" aria-labelledby="people-title" className="mt-10">
      <h2 id="people-title" className="mb-4 flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wider text-textTertiary">
        people
        <span id="people-count">{list.length}</span>
        {here > 0 && (
          <>
            <span aria-hidden>·</span>
            <span id="people-here" className="text-increase">
              {here} here
            </span>
          </>
        )}
      </h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
        {list.map((p) => (
          <article key={p.name} id={`person-${p.name}`} data-presence={p.presence} className={cn(CARD_LINK, 'flex items-center gap-2 p-3')}>
            <PersonRow id={`person-link-${p.name}`} name={p.name} verified={p.verified} avatar={p.avatar} bio={p.bio} presence={p.presence} size="card" />
            <FollowButton id={`person-follow-${p.name}`} name={p.name} small className="self-start" />
          </article>
        ))}
      </div>
    </section>
  );
}

/** Three cards' worth of grey, for the moment before the first answer. */
function Skeleton() {
  return (
    <div id="loading" className={GRID} aria-busy="true" aria-label="loading">
      {[0, 1, 2].map((i) => (
        <div key={i} className={cn(CARD, 'animate-pulse')}>
          <div className="aspect-video border-b border-primaryStroke bg-backgroundTertiary" />
          <div className="flex items-start gap-3 p-4">
            <span className="h-11 w-11 shrink-0 bg-backgroundTertiary" />
            <div className="flex-1 space-y-2 py-1">
              <div className="h-4 w-1/2 bg-backgroundTertiary" />
              <div className="h-3 w-5/6 bg-backgroundTertiary" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function HomePage() {
  // the poll is also the page's clock: `since` moves with each answer (every 3s), so the render
  // never reads the time itself. the picture does not: one still per visit. no retries on focus.
  const streams = useQuery({ queryKey: ['streams'], queryFn: api.streams, refetchInterval: POLL_MS, refetchOnWindowFocus: false });
  const now = streams.dataUpdatedAt;
  const list = streams.error ? undefined : streams.data;
  const featured = list?.slice(0, FEATURED) ?? [];
  const rest = list?.slice(FEATURED) ?? [];
  const namesKey = (list ?? []).map((stream) => stream.name).join(',');
  const [hover, setHover] = useState<string | null>(null);
  const [cardHover] = useState(() => hoverPreview(window, setHover));

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

  // no title row: the cards are the page. "go live" is in the corner panel (UserPanel), and once more in the empty state.
  // the one thing above the cards is the search box, in the middle: a few letters find anyone (docs/follows.md)
  return (
    <PageFrame wide>
      <div className="mx-auto mb-8 flex w-full max-w-xl flex-col items-center gap-3">
        <SearchBox className="w-full" />
        <Link id="explore-link" to="/explore" className="text-sm font-semibold text-primaryBlue">
          servers
        </Link>
      </div>
      {streams.error && (
        <p className="border border-decrease/40 bg-decrease/10 px-5 py-4 text-textSecondary" aria-live="polite">
          api is down: {messageOf(streams.error)}
        </p>
      )}
      {!streams.error && !streams.data && <Skeleton />}
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
          <div id="featured" className={cn('grid grid-cols-1 gap-6 lg:grid-cols-2', rest.length > 0 && 'mb-6')}>
            {featured.map((stream) => (
              <Card
                key={stream.name}
                stream={stream}
                now={now}
                featured
                playing
                onEnter={() => undefined}
                onLeave={() => undefined}
              />
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
      {!streams.error && <People />}
    </PageFrame>
  );
}
