import { RiChat3Line, RiPencilLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import {
  avatarAtom,
  bioAtom,
  canHearAtom,
  canModerateAtom,
  canRetryAtom,
  clearChoice,
  followersAtom,
  joinedAtom,
  leaveWatchPage,
  markAutoplayBlocked,
  markPlaying,
  mutedAtom,
  NOT_LIVE_MESSAGE,
  needsTapAtom,
  offlineAtom,
  offlineNoteAtom,
  pickSlot,
  primarySlotAtom,
  remoteStreamAtom,
  retry,
  sceneTileAtom,
  slotLabel,
  slotStreamAtom,
  startPip,
  tilesAtom,
  watchBlankAtom,
  watchLayersAtom,
  unmuteVideo,
  verifiedAtom,
  oauthVerifiedAtom,
  volumeAtom,
  watch,
  watchBadgeAtom,
  watchStatsAtom,
  watchMessageAtom,
  watchRenamedToAtom,
  watchToneAtom,
  watchViewersAtom
} from '@/infra/atoms/watch-atoms';
import { socialsAtom, watchNameAtom, watchPhaseAtom, watchWelcomeAtom } from '@/infra/atoms/watch-state';
import { dmActiveAtom, dmOpenAtom, hideDms, openDm } from '@/infra/atoms/dm-atoms';
import { followingAtom, loadPeek, peeksAtom } from '@/infra/atoms/follow-atoms';
import { type Presence, presenceOfAtom } from '@/infra/atoms/presence-atoms';
import { meAtom } from '@/infra/atoms/auth-atoms';
import type { ChatLine } from '@/infra/atoms/chat-atoms';
import { myNameAtom } from '@/infra/atoms/profile-atoms';
import { publishPipAtom } from '@/infra/atoms/publish-state';
import { chatModalOpenAtom } from '@/infra/atoms/settings-atoms';
import { ChatOpenButton, ChatSlot, chatLayoutClass, useChatSide } from '@/shared-components/ChatSlot';
import { usePinnedPage, useKeyboard, useTypingIn } from '@/infra/keyboard';
import { CHAT_MOBILE, keyboardStrip, useIsMobile } from '@/infra/mobile';
import { KbdDebug } from '@/shared-components/KbdDebug';
import { api } from '@/infra/api';
import { cleanName } from '@/infra/names';
import { usePrefetchOnPointerDown } from '@/infra/prefetch';
import { useShowsWatch } from '@/infra/watch-view';
import { store } from '@/infra/store';
import { About } from '@/shared-components/About';
import { Calendar } from '@/shared-components/Calendar';
import { FollowButton } from '@/shared-components/FollowButton';
import { Badge } from '@/shared-components/Badge';
import { Button } from '@/shared-components/Button';
import { ChatModActions } from '@/shared-components/ChatMod';
import { ChatPanel } from '@/shared-components/ChatPanel';
import { Face } from '@/shared-components/Face';
import { ModTab } from '@/shared-components/ModTab';
import { PageFrame } from '@/shared-components/PageFrame';
import { PresenceSquare } from '@/shared-components/PresenceSquare';
import { SceneView } from '@/shared-components/SceneView';
import { BlurredPicture } from '@/shared-components/BlurredPicture';
import { Bone, Skeleton } from '@/shared-components/Skeleton';
import { SocialsTab } from '@/shared-components/SocialsEditor';
import { StatusLine } from '@/shared-components/StatusLine';
import { ViewerCount } from '@/shared-components/ViewerCount';
import { StreamStatsButton } from '@/shared-components/StreamStats';
import { OAuthMark } from '@/shared-components/OAuthMark';
import { StreamTile } from '@/shared-components/StreamTile';
import { IconButton, PipIcon, SoundControl, revealClassName } from '@/shared-components/VideoControls';
import { Tooltip } from '@/shared-components/Tooltip';
import { useFitWidth } from '@/shared-components/useFitWidth';
import { cn } from '@/utils/cn';
import { streamNumbers } from '@/utils/count';
import { roveTabs, TAB, TAB_OFF, TAB_ON } from '@/utils/tabs';

const NOT_LIVE_WORDS: Partial<Record<Presence, string>> = {
  dnd: 'do not disturb, not streaming.',
  streaming: 'starting'
};

type WatchTab = 'about' | 'calendar' | 'socials' | 'mod';
const WATCH_TABS: readonly WatchTab[] = ['about', 'calendar', 'socials'];
const MY_TABS: readonly WatchTab[] = [...WATCH_TABS, 'mod'];

type PhoneTab = WatchTab | 'chat';
const PHONE_TABS: readonly PhoneTab[] = [...WATCH_TABS, 'chat'];
const MY_PHONE_TABS: readonly PhoneTab[] = [...MY_TABS, 'chat'];

const BESIDE_MIN = 928;

function useNarrowBody(on: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || !el) return;
    setNarrow(el.getBoundingClientRect().width < BESIDE_MIN);
    const watcher = new ResizeObserver(() => setNarrow(el.getBoundingClientRect().width < BESIDE_MIN));
    watcher.observe(el);
    return () => watcher.disconnect();
  }, [on]);
  return [ref, narrow] as const;
}

let servedWithCard = location.pathname.startsWith('/watch/');

function hintedLive(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as { live?: unknown }).live === true;
}

type Ask = 'before' | 'asking' | 'done';

function DmButton({ name }: { name: string }) {
  const friend = useAtomValue(followingAtom)?.find((f) => f.name === name && f.mutual);
  const open = useAtomValue(dmOpenAtom);
  const active = useAtomValue(dmActiveAtom);
  if (!friend) return null;
  const on = open && active === name;
  const label = on ? `hide the chat with ${name}` : `message ${name}`;
  const toggle = () => (on ? hideDms() : openDm({ id: '', name, avatar: friend.avatar, verified: friend.verified, bio: friend.bio, presence: friend.presence }));
  return (
    <Tooltip content={label}>
      <IconButton id="dm-open" tone="page" label={label} active={on} onClick={toggle} className="md:h-[34px] md:w-[34px]">
        <RiChat3Line aria-hidden size={20} />
      </IconButton>
    </Tooltip>
  );
}

function WatchStats({ muted, volume, className }: { muted: boolean; volume: number; className?: string }) {
  const stats = useAtomValue(watchStatsAtom);
  return <StreamStatsButton id="stats" role="watch" stats={stats} playback={{ muted, level: volume }} className={className} />;
}

function WatchViewers({ id, className }: { id?: string; className?: string }) {
  const viewers = useAtomValue(watchViewersAtom);
  return <ViewerCount id={id} count={viewers} className={className} />;
}

function StripViewers({ headline }: { headline: string | null }) {
  const viewers = useAtomValue(watchViewersAtom);
  return (
    <>
      {headline && viewers !== null && (
        <span aria-hidden className="text-textTertiary">
          ·
        </span>
      )}
      <ViewerCount id="viewers" count={viewers} className="shrink-0 text-textSecondary" />
    </>
  );
}

function WatchHeaderSub({ followers }: { followers: number | null }) {
  const viewers = useAtomValue(watchViewersAtom);
  return <>{streamNumbers(followers, viewers)}</>;
}

export function WatchPage() {
  const [tab, setTab] = useState<PhoneTab>('about');
  const [aboutEditing, setAboutEditing] = useState(false);
  const mobile = useIsMobile();
  const [body, narrow] = useNarrowBody(!mobile);
  usePinnedPage(mobile);
  const keyboard = useKeyboard().keyboard;
  const typing = useTypingIn('chat-text') && mobile;
  const strip = keyboardStrip(typing);
  const [phoneTab, setPhoneTab] = useState<PhoneTab>('chat');
  const [opened, setOpened] = useState<ReadonlySet<PhoneTab>>(() => new Set<PhoneTab>(['chat', 'about']));
  const params = useParams<{ name: string }>();
  const navigate = useNavigate();
  const { state } = useLocation();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<HTMLDivElement | null>(null);
  const [expectLive] = useState(() => {
    const reason = hintedLive(state) || servedWithCard;
    servedWithCard = false;
    return reason;
  });
  const [ask, setAsk] = useState<Ask>('before');
  const name = useAtomValue(watchNameAtom);
  const message = useAtomValue(watchMessageAtom);
  const tone = useAtomValue(watchToneAtom);
  const bio = useAtomValue(bioAtom);
  const canRetry = useAtomValue(canRetryAtom);
  const canHear = useAtomValue(canHearAtom);
  const needsTap = useAtomValue(needsTapAtom);
  const muted = useAtomValue(mutedAtom);
  const volume = useAtomValue(volumeAtom);
  const verified = useAtomValue(verifiedAtom);
  const oauthVerified = useAtomValue(oauthVerifiedAtom);
  const avatar = useAtomValue(avatarAtom);
  const offline = useAtomValue(offlineAtom);
  const offlineNote = useAtomValue(offlineNoteAtom);
  const welcome = useAtomValue(watchWelcomeAtom);
  const followers = useAtomValue(followersAtom);
  const socials = useAtomValue(socialsAtom);
  const joined = useAtomValue(joinedAtom);
  const badge = useAtomValue(watchBadgeAtom);
  const mine = useAtomValue(myNameAtom) === name;
  const me = useAtomValue(meAtom) ?? null;
  const myPage = me !== null && me === name;
  const watchTabs = myPage ? MY_TABS : WATCH_TABS;
  const phoneTabs = myPage ? MY_PHONE_TABS : PHONE_TABS;
  const canModerate = useAtomValue(canModerateAtom) || myPage;
  const modActions = canModerate && name ? (line: ChatLine) => <ChatModActions name={name} line={line} me={me} /> : undefined;
  const embedMod = canModerate ? () => true : undefined;
  const phase = useAtomValue(watchPhaseAtom);
  useShowsWatch(playerRef, phase !== 'waiting' && phase !== 'loading', { small: false, fixed: false });
  const presence = useAtomValue(presenceOfAtom(name));
  const tiles = useAtomValue(tilesAtom);
  const layers = useAtomValue(watchLayersAtom);
  const blank = useAtomValue(watchBlankAtom);
  const primary = useAtomValue(primarySlotAtom);
  const sceneTile = useAtomValue(sceneTileAtom);
  const renamedTo = useAtomValue(watchRenamedToAtom);
  const chatSide = useChatSide();
  const chatOpen = useAtomValue(chatModalOpenAtom);
  const chatTab = !mobile && narrow && chatSide !== 'modal';
  const theater = !mobile && !chatTab;
  const [fitCell, fitTail, fitWidth] = useFitWidth(theater && !!name);
  const cornerTaken = useAtomValue(publishPipAtom);
  const thumbs = useAtomValue(peeksAtom)[name]?.card.thumbs;
  const [brokenThumb, setBrokenThumb] = useState<string | null>(null);
  useEffect(() => {
    if (name) void loadPeek(name);
  }, [name]);
  const offlineThumb = offline !== null ? api.offlineUrl(name, offline) : thumbs?.[0] !== undefined ? api.streamThumbUrl(name, thumbs[0]) : null;
  const shownThumb = offlineThumb !== brokenThumb ? offlineThumb : null;
  const streamThumb = thumbs?.[0] !== undefined ? api.streamThumbUrl(name, thumbs[0]) : null;
  const backdrop = name && (streamThumb !== null || avatar !== null) ? <BlurredPicture name={name} version={avatar} src={streamThumb} /> : null;

  useEffect(() => {
    const name = cleanName(params.name);
    document.title = name ? `${name} · streams` : 'streams';
    void watch(name);
    return () => {
      document.title = 'streams';
      leaveWatchPage();
    };
  }, []);

  useEffect(() => {
    if (!renamedTo) return;
    store.set(watchRenamedToAtom, null);
    navigate(`/watch/${renamedTo}`, { replace: true });
  }, [renamedTo]);

  if (ask === 'before' && phase === 'loading') setAsk('asking');
  else if (ask === 'asking' && phase !== 'loading') setAsk('done');
  const firstAsk = ask !== 'done' && phase === 'loading';

  const expecting = phase === 'loading' ? presence === 'streaming' || (expectLive && firstAsk) : phase === 'waiting' && presence === 'streaming';

  const toCorner = () => {
    startPip();
    navigate('/');
  };
  const homePress = usePrefetchOnPointerDown('/');

  const face = name ? (
    <span className="relative flex shrink-0">
      <Face name={name} version={avatar} className={mobile ? 'h-8 w-8 text-sm' : 'h-10 w-10 text-lg'} />
      <PresenceSquare id="presence" labelled status={presence} className="border-background" />
    </span>
  ) : undefined;
  const title = (
    <span className="relative flex min-w-0 items-center gap-1.5">
      {bio ? (
        <Tooltip content={bio}>
          <span className="truncate">{name}</span>
        </Tooltip>
      ) : (
        <span className="truncate">{name}</span>
      )}
      {badge && <Badge id="watch-badge" group={badge} card className="shrink-0" />}
      {verified && (
        <Tooltip content="verified">
          <span role="img" aria-label="has an account" className="shrink-0 text-increase">
            ✓
          </span>
        </Tooltip>
      )}
      {oauthVerified && <OAuthMark id="watch-oauth-verified" size={16} className="shrink-0" />}
      {bio && (
        <span id="bio" className="sr-only">
          {bio}
        </span>
      )}
    </span>
  );

  const deskTabs: readonly PhoneTab[] = !name ? [] : phase === 'bad-name' ? (chatTab ? ['chat'] : []) : chatTab ? phoneTabs : watchTabs;
  const deskTab: PhoneTab | undefined = deskTabs.includes(tab) ? tab : deskTabs[0];
  const videoCap = chatTab
    ? deskTab === 'chat' && 'mx-auto max-w-[max(320px,calc((100dvh_-_var(--page-top,4rem)_-_var(--banner-h,0px)_-_4.25rem_-_260px_-_2.5rem)_*_16_/_9))]'
    : theater && 'mx-auto';
  const fitStyle = fitWidth !== null ? { maxWidth: fitWidth } : undefined;

  const chipDots = phase === 'connecting' || phase === 'connected';
  const chipWords = chipDots
    ? 'connecting'
    : phase === 'watching' || phase === 'loading' || (phase === 'waiting' && message === NOT_LIVE_MESSAGE)
      ? null
      : message;
  const playerChip = chipWords !== null && (
    <div className={cn('pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2', mobile && strip.overlay)}>
      <span
        aria-hidden
        className={cn(
          'rounded-control border border-white/10 bg-black/70 px-3 py-1 text-sm font-semibold uppercase tracking-wide backdrop-blur-sm',
          tone === 'bad' ? 'text-decrease' : 'text-white'
        )}
      >
        {chipWords}
        {chipDots &&
          ['[animation-delay:0s]', '[animation-delay:0.2s]', '[animation-delay:0.4s]'].map((delay) => (
            <span key={delay} aria-hidden className={cn('animate-dot motion-reduce:animate-none motion-reduce:opacity-100', delay)}>
              {' .'}
            </span>
          ))}
      </span>
      {canRetry && (
        <Button id="retry" size="sm" className="pointer-events-auto" onClick={retry}>
          retry
        </Button>
      )}
    </div>
  );

  const player = (
    <>
      {phase === 'waiting' || phase === 'loading' ? (
        expecting ? (
          <Skeleton
            id="player-loading"
            label="loading the stream"
            className={cn(mobile ? strip.box : 'aspect-video', 'relative w-full overflow-hidden rounded-panel border border-primaryStroke bg-backgroundSecondary bubble:border-transparent max-md:rounded-none max-md:border-t-0', videoCap)}
            style={mobile ? strip.style : fitStyle}
          >
            {backdrop ?? <Bone className="absolute inset-0 rounded-none" />}
            {playerChip}
            {!mobile && !chatTab && (
              <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 p-3">
                <ChatOpenButton className="ml-auto" />
              </div>
            )}
          </Skeleton>
        ) : (
          <div id="profile" data-presence={presence} data-kbd-video={mobile || undefined} className={cn('relative', mobile && strip.box, videoCap)} style={mobile ? strip.style : fitStyle}>
            <div className={cn('relative aspect-video w-full overflow-hidden rounded-panel border border-primaryStroke bg-black bubble:border-transparent max-md:rounded-none max-md:border-x-0 max-md:border-t-0', mobile && strip.frame)}>
              {shownThumb ? (
                <img
                  id={offline !== null ? 'offline-picture' : undefined}
                  src={shownThumb}
                  alt=""
                  draggable={false}
                  className="absolute inset-0 h-full w-full object-cover"
                  onError={() => setBrokenThumb(shownThumb)}
                />
              ) : (
                name && avatar !== null && <BlurredPicture name={name} version={avatar} />
              )}
              {phase === 'waiting' && (
                <span
                  title={offlineNote || undefined}
                  className={cn(
                    'absolute bottom-2 left-2 flex max-w-[calc(100%-5rem)] items-center gap-1.5 rounded-control border border-white/10 bg-black/70 px-2 py-0.5 text-xs font-semibold text-white',
                    mobile && strip.overlay
                  )}
                >
                  <PresenceSquare status="offline" size="chip" />
                  <span className="min-w-0 truncate">
                    offline
                    {offlineNote && (
                      <>
                        : <span id="offline-note">{offlineNote}</span>
                      </>
                    )}
                  </span>
                </span>
              )}
              {playerChip}
              {!mobile && !chatTab && (
                <div className="absolute bottom-0 right-0 p-3">
                  <ChatOpenButton />
                </div>
              )}
            </div>
          </div>
        )
      ) : (
        <div ref={playerRef} data-kbd-video={mobile || undefined} className={cn('group relative', mobile && strip.box, videoCap)} style={mobile ? strip.style : fitStyle}>
          <SceneView
            id="scene"
            className={cn('max-md:rounded-none max-md:border-t-0', mobile && strip.frame)}
            layers={layers}
            blank={blank}
            streamFor={slotStreamAtom}
            imageUrl={(asset) => api.assetUrl(name, asset)}
            avatar={{ name, version: avatar, streamAtom: remoteStreamAtom, pulse: true }}
            main={{
              id: 'video',
              streamAtom: remoteStreamAtom,
              videoRef,
              slot: primary,
              muted,
              volume,
              onPlaying: markPlaying,
              onAutoplayBlocked: markAutoplayBlocked
            }}
            onPick={pickSlot}
          />
          {(phase === 'connecting' || phase === 'connected') &&
            (backdrop ? <span className="pointer-events-none absolute inset-px">{backdrop}</span> : <Bone className="pointer-events-none absolute inset-px rounded-panel max-md:rounded-none" />)}
          {playerChip}
          {needsTap && (
            <Button
              id="tap-to-play"
              variant="primary"
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
              onClick={() => unmuteVideo(videoRef.current)}
            >
              tap to play
            </Button>
          )}
          {canHear && <WatchStats muted={muted} volume={volume} className={cn('left-3 top-3', mobile && strip.overlay)} />}
          {phase !== 'bad-name' && (
            <div className={cn('absolute inset-x-0 bottom-0 flex items-center gap-3 p-3', revealClassName(muted || (!mobile && !chatTab && !chatOpen)), mobile && strip.overlay)}>
              {canHear && <SoundControl videoRef={videoRef} buttonId="unmute" dialId="volume" />}
              {mobile || chatTab ? <span className="ml-auto" /> : <ChatOpenButton className="ml-auto" />}
              <IconButton id="pip" label={cornerTaken ? 'your stream is in the corner' : 'pic in pic'} disabled={cornerTaken} {...homePress} onClick={toCorner}>
                <PipIcon />
              </IconButton>
            </div>
          )}
        </div>
      )}
      {(tiles.length > 0 || sceneTile) && (
        <div id="tiles" className="mt-2 flex gap-2 overflow-x-auto">
          {sceneTile && (
            <button
              id="tile-scene"
              type="button"
              onClick={clearChoice}
              className="flex aspect-video w-40 shrink-0 items-center justify-center rounded-card border border-dashed border-secondaryStroke text-sm text-textSecondary transition-colors duration-150 hover:border-primaryBlue hover:text-textPrimary"
            >
              back to the stream
            </button>
          )}
          {tiles.map((tile) => (
            <StreamTile key={tile.slot} id={`tile-${tile.slot}`} streamAtom={slotStreamAtom(tile.slot)} label={slotLabel(tile)} onPick={() => pickSlot(tile.slot)} />
          ))}
        </div>
      )}
    </>
  );

  const followButton = (className?: string) => (
    <FollowButton id="follow" name={name} small={mobile} className={className} onChange={(now) => store.set(followersAtom, (followers ?? 0) + (now ? 1 : -1))} />
  );
  const rowEnd =
    name ? (
      <>
        {followButton(mobile ? 'min-h-11 min-w-11' : undefined)}
        <DmButton name={name} />
      </>
    ) : undefined;
  const followersCount = name && followers !== null && (
    <span id="followers">
      {followers} {followers === 1 ? 'follower' : 'followers'}
    </span>
  );

  const status = (
    <div className="relative my-3 flex flex-wrap items-baseline gap-x-4">
      <StatusLine text={message} tone={tone} className={cn('my-0', (phase === 'watching' || chipWords !== null) && 'sr-only')} />
      <WatchViewers id="viewers" className="text-lg text-textSecondary" />
      {followersCount && <span className="ml-auto text-lg text-textSecondary">{followersCount}</span>}
    </div>
  );
  const deskStatus = (
    <div className="relative">
      <StatusLine text={message} tone={tone} className="my-0 sr-only" />
      {!theater && (
        <span className="sr-only">
          <WatchViewers id="viewers" />
          {followersCount}
        </span>
      )}
    </div>
  );
  const onAir = phase === 'watching' || phase === 'connecting' || phase === 'connected' || phase === 'reconnecting';
  const headline = !name || phase === 'loading' || phase === 'bad-name' ? null : onAir ? 'live' : (NOT_LIVE_WORDS[presence] ?? 'offline');
  const stripInfo = (
    <div className="relative flex min-w-0 flex-1 items-baseline gap-2 whitespace-nowrap pb-1.5 text-sm bubble:pb-0">
      {headline && <span className={cn('min-w-0 truncate font-semibold', onAir ? 'text-increase' : 'text-textPrimary')}>{headline}</span>}
      <StripViewers headline={headline} />
      {followersCount && <span className="sr-only">{followersCount}</span>}
    </div>
  );

  const editAbout = (on: boolean) =>
    mine &&
    on &&
    !aboutEditing && (
      <Tooltip content="edit about">
        <Button
          id="about-edit"
          size="sm"
          aria-label="edit about"
          className="-mb-px self-stretch px-2 py-0"
          onClick={() => setAboutEditing(true)}
        >
          <RiPencilLine size={16} aria-hidden />
        </Button>
      </Tooltip>
    );
  const notLive = NOT_LIVE_WORDS[presence];
  const offlineWords = phase === 'waiting' && !expecting && notLive && <p className="mb-4 text-sm text-textSecondary">{notLive}</p>;

  if (mobile) {
    const tabs: readonly PhoneTab[] = !name ? [] : phase === 'bad-name' ? ['chat'] : phoneTabs;
    const shown: PhoneTab = tabs.includes(phoneTab) ? phoneTab : 'chat';
    const openTab = (t: PhoneTab) => {
      setPhoneTab(t);
      setOpened((was) => (was.has(t) ? was : new Set(was).add(t)));
    };
    const content = (t: PhoneTab) =>
      t === 'chat' ? (
        <ChatPanel name={name} lineActions={modActions} embedMod={embedMod} welcome={welcome} className={cn('h-full min-h-0 flex-1', CHAT_MOBILE)} />
      ) : t === 'about' ? (
        <>
          <div className="[&>div]:mt-0">{status}</div>
          {offlineWords}
          <About key={name} name={name} edit={mine} editing={mine && aboutEditing} onEditing={setAboutEditing} />
        </>
      ) : t === 'calendar' ? (
        <Calendar name={name} />
      ) : t === 'mod' ? (
        <ModTab name={name} />
      ) : (
        <SocialsTab name={name} doc={socials} joined={joined} mine={mine} />
      );
    return (
      <div
        data-keyboard={typing || keyboard}
        className="group/phone fixed inset-x-0 [--sticky-top:0px] top-[calc(var(--vvt,0px)+var(--banner-h,0px))] flex h-[calc(var(--vvh,100dvh)-var(--banner-h,0px))] flex-col overflow-hidden bg-background pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
      >
        <PageFrame
          title={title}
          titleId="who"
          mobileStart={face}
          mobileSub={<WatchHeaderSub followers={name ? followers : null} />}
          mobileEnd={rowEnd}
          wide
          bleed
          fill
        >
          <div className="shrink-0">{player}</div>
          {tabs.length > 0 && (
            <div id="watch-tabs" className="flex min-h-0 flex-1 flex-col">
              <div role="tablist" aria-label="about them" onKeyDown={roveTabs} className={cn('flex shrink-0 border-b border-primaryStroke px-1 bubble:gap-1 bubble:border-transparent bubble:px-2 bubble:py-1', typing && 'hidden')}>
                {tabs.map((t) => {
                  const on = t === shown;
                  return (
                    <button
                      key={t}
                      id={`tab-${t}`}
                      type="button"
                      role="tab"
                      aria-selected={on}
                      aria-controls={`panel-${t}`}
                      tabIndex={on ? 0 : -1}
                      onClick={() => openTab(t)}
                      className={cn(
                        '-mb-px min-h-11 whitespace-nowrap border-b-2 px-3 text-sm font-semibold leading-tight transition-colors duration-150 bubble:mb-0 bubble:min-h-10 bubble:rounded-control bubble:border-b-0 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primaryBlue',
                        t === 'chat' && 'ml-auto',
                        on ? 'border-primaryBlue text-textPrimary bubble:bg-backgroundTertiary' : 'border-transparent text-textSecondary'
                      )}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
              <div className="relative min-h-0 flex-1">
                {tabs.map((t) => (
                  <div
                    key={t}
                    id={`panel-${t}`}
                    role="tabpanel"
                    aria-labelledby={`tab-${t}`}
                    inert={shown !== t ? true : undefined}
                    className={cn(
                      'absolute inset-0',
                      shown !== t && 'invisible',
                      t === 'chat' ? 'flex flex-col' : 'overflow-y-auto overscroll-contain px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4',
                      t === 'about' && mine && 'pb-[calc(4.5rem+env(safe-area-inset-bottom))]'
                    )}
                  >
                    {(opened.has(t) || shown === t) && content(t)}
                  </div>
                ))}
              </div>
            </div>
          )}
        </PageFrame>
        {mine && shown === 'about' && !aboutEditing && !typing && !keyboard && (
          <Tooltip content="edit about">
            <Button
              id="about-edit"
              size="sm"
              aria-label="edit about"
              className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-[calc(1rem+env(safe-area-inset-right))] z-30 h-11 gap-1.5 rounded-control border-secondaryStroke bg-backgroundTertiary px-4 py-0 text-textPrimary"
              onClick={() => {
                openTab('about');
                setAboutEditing(true);
              }}
            >
              <RiPencilLine size={16} aria-hidden />
              edit
            </Button>
          </Tooltip>
        )}
        <KbdDebug typing={typing} />
      </div>
    );
  }

  return (
    <PageFrame
      title={title}
      titleId="who"
      person
      mobileStart={face}
      mobileSub={<WatchHeaderSub followers={name ? followers : null} />}
      mobileEnd={rowEnd}
      wide
      fluid
    >
      <div ref={body} data-chat={chatSide === 'modal' ? undefined : chatTab ? 'tabbed' : 'beside'} className={chatLayoutClass(chatSide, chatOpen, theater, !mobile)}>
        <div ref={fitCell} className={cn('min-w-0', chatSide === 'left' && 'beside:col-start-2 beside:row-start-1')}>
          {player}
          {deskStatus}
        </div>

        {deskTabs.length > 0 && (
          <div
            id="watch-tabs"
            style={fitStyle}
            className={cn(
              'min-w-0',
              theater ? 'mx-auto mt-2 w-full justify-self-center' : 'mt-4',
              chatSide === 'right' && 'beside:col-start-1 beside:mt-0',
              chatSide === 'left' && 'beside:col-start-2 beside:row-start-2 beside:mt-0',
              theater && 'beside:mt-2',
              'pb-4 bubble:mt-2 bubble:rounded-panel bubble:bg-backgroundSecondary bubble:px-3 bubble:pt-2',
              theater && 'bubble:pt-0'
            )}
          >
            <div ref={theater ? fitTail : undefined} id={theater ? 'watch-strip' : undefined} className={cn('flex border-b border-primaryStroke bubble:border-transparent', theater && 'min-h-12 items-end gap-4 bubble:items-center')}>
              {theater && stripInfo}
              <div role="tablist" aria-label="about them" onKeyDown={roveTabs} className={cn('flex gap-1', theater ? 'shrink-0' : 'flex-1')}>
                {deskTabs.map((t) => {
                  const on = t === deskTab;
                  return (
                    <Fragment key={t}>
                      {t === 'about' && editAbout(on)}
                      <button
                        id={`tab-${t}`}
                        type="button"
                        role="tab"
                        aria-selected={on}
                        aria-controls={on || t === 'chat' ? `panel-${t}` : undefined}
                        tabIndex={on ? 0 : -1}
                        onClick={() => setTab(t)}
                        className={cn(TAB, theater && 'text-sm', t === 'chat' && 'ml-auto', on ? TAB_ON : TAB_OFF)}
                      >
                        {t}
                      </button>
                    </Fragment>
                  );
                })}
              </div>
            </div>
            {deskTab !== 'chat' && (
              <div id={`panel-${deskTab}`} role="tabpanel" aria-labelledby={`tab-${deskTab}`} className={cn('pt-4', theater && 'bubble:pt-px')}>
                {deskTab === 'about' ? (
                  <>
                    {offlineWords}
                    <About key={name} name={name} edit={mine} editing={mine && aboutEditing} onEditing={setAboutEditing} />
                  </>
                ) : deskTab === 'calendar' ? (
                  <Calendar name={name} />
                ) : deskTab === 'mod' ? (
                  <ModTab name={name} />
                ) : (
                  <SocialsTab name={name} doc={socials} joined={joined} mine={mine} />
                )}
              </div>
            )}
          </div>
        )}

        {name && (
          <div
            id={chatTab ? 'panel-chat' : undefined}
            role={chatTab ? 'tabpanel' : undefined}
            aria-labelledby={chatTab ? 'tab-chat' : undefined}
            inert={chatTab && deskTab !== 'chat' ? true : undefined}
            className={cn(!chatTab ? 'contents' : deskTab !== 'chat' && 'invisible h-0 overflow-hidden')}
          >
            <ChatSlot tabbed={chatTab} fluid={theater} resizable>
              <ChatPanel name={name} lineActions={modActions} embedMod={embedMod} welcome={welcome} className={cn('h-full min-h-0 flex-1', chatSide === 'modal' && 'border-0')} />
            </ChatSlot>
          </div>
        )}
      </div>
    </PageFrame>
  );
}
