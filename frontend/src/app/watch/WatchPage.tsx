import { useAtomValue } from 'jotai';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import {
  avatarAtom,
  bioAtom,
  canHearAtom,
  canRetryAtom,
  clearChoice,
  followersAtom,
  joinedAtom,
  leaveWatchPage,
  markAutoplayBlocked,
  markPlaying,
  mutedAtom,
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
  socialsAtom,
  startPip,
  tilesAtom,
  watchLayersAtom,
  unmuteVideo,
  verifiedAtom,
  oauthVerifiedAtom,
  volumeAtom,
  watch,
  watchStatsAtom,
  watchMessageAtom,
  watchNameAtom,
  watchPhaseAtom,
  watchRenamedToAtom,
  watchToneAtom,
  watchViewersAtom
} from '@/infra/atoms/watch-atoms';
import { dmActiveAtom, dmOpenAtom, hideDms, openDm } from '@/infra/atoms/dm-atoms';
import { followingAtom, loadPeek, peeksAtom } from '@/infra/atoms/follow-atoms';
import { type Presence, presenceOfAtom } from '@/infra/atoms/presence-atoms';
import { myNameAtom } from '@/infra/atoms/profile-atoms';
import { publishPipAtom } from '@/infra/atoms/publish-atoms';
import { chatModalOpenAtom } from '@/infra/atoms/settings-atoms';
import { ChatOpenButton, ChatSlot, chatLayoutClass, useChatSide } from '@/shared-components/ChatSlot';
import { CHAT_MOBILE, keyboardStrip, useChatTyping, useIsMobile, useLockedDocument, useVisibleViewport } from '@/infra/mobile';
import { KbdDebug } from '@/shared-components/KbdDebug';
import { dummyPage } from '@/infra/about';
import { api } from '@/infra/api';
import { cleanName, isDummyName } from '@/infra/names';
import { store } from '@/infra/store';
import { About } from '@/shared-components/About';
import { Calendar } from '@/shared-components/Calendar';
import { FollowButton } from '@/shared-components/FollowButton';
import { Button } from '@/shared-components/Button';
import { ChatPanel } from '@/shared-components/ChatPanel';
import { Face } from '@/shared-components/Face';
import { PageFrame } from '@/shared-components/PageFrame';
import { PresenceSquare } from '@/shared-components/PersonRow';
import { SceneView } from '@/shared-components/SceneView';
import { Bone, Skeleton } from '@/shared-components/Skeleton';
import { SocialsTab } from '@/shared-components/SocialsEditor';
import { StatusLine } from '@/shared-components/StatusLine';
import { ViewerCount } from '@/shared-components/ViewerCount';
import { StreamStatsButton } from '@/shared-components/StreamStats';
import { OAuthMark } from '@/shared-components/OAuthMark';
import { StreamTile } from '@/shared-components/StreamTile';
import { TestBadge } from '@/shared-components/TestBadge';
import { IconButton, MailIcon, PipIcon, SoundControl, revealClassName } from '@/shared-components/VideoControls';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';
import { streamNumbers } from '@/utils/count';
import { roveTabs } from '@/utils/tabs';

/** The sentence at the top of the about tab while they are not live: why to wait, or not. */
const NOT_LIVE_WORDS: Record<Presence, string> = {
  offline: 'not streaming right now. the stream shows up here the moment they start.',
  online: 'around, not streaming. the stream shows up here the moment they start.',
  dnd: 'do not disturb, not streaming.',
  streaming: 'starting'
};

/** Under the player: their page (docs/about.md), when they stream (docs/calendar.md), and where else to find them (docs/socials.md). In this order. */
type WatchTab = 'about' | 'calendar' | 'socials';
const WATCH_TABS: readonly WatchTab[] = ['about', 'calendar', 'socials'];

/** A phone's tabs under the player: the same three, and the chat at the row's right end. Chat is where a phone's page opens, as on go live (LivePage.tsx). */
type PhoneTab = WatchTab | 'chat';
const PHONE_TABS: readonly PhoneTab[] = [...WATCH_TABS, 'chat'];

/**
 * The document itself was served for a stream's page: the api put its card inside `#root`, a
 * black 16:9 box standing where the player goes, before react booted (api/src/profile.rs). The
 * first watch page of this document keeps that box through its ask instead of collapsing it to
 * the profile and growing it back for the player. True once; a later page here came by a click.
 */
let servedWithCard = location.pathname.startsWith('/watch/');

/** The `state` a link to a stream's page may carry: `live`, the card or row that was clicked said they are streaming. */
function hintedLive(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as { live?: unknown }).live === true;
}

/**
 * Where the page's first ask is (see `WatchPage`): `before` it has begun, `asking` while it is
 * under way, `done` once it has answered, whatever it said. What is held through it (the
 * player's box, the status line under the name) is let go at `done`.
 */
type Ask = 'before' | 'asking' | 'done';

/**
 * In the title row, right of follow: a line to the streamer (docs/dms.md), a light 32px box
 * (44px on a phone). For a friend alone, someone this login follows who follows it back: a line
 * goes nowhere else, and the sidebar's list already says who that is. It opens the chat
 * window on their thread (or shows the one they have), lit while that thread is the one on
 * screen, and then it hides the window, the chat button's way. One on the page, desktop or phone.
 */
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
      <IconButton id="dm-open" tone="page" label={label} active={on} onClick={toggle}>
        <MailIcon />
      </IconButton>
    </Tooltip>
  );
}

export function WatchPage() {
  const [tab, setTab] = useState<WatchTab>('about');
  const mobile = useIsMobile();
  // a phone's page is the window (as go live's is): the visual viewport (mobile.ts) is its box, so the send row stays over the keyboard
  const view = useVisibleViewport(mobile, true);
  useLockedDocument(mobile);
  // a phone's player is a strip while the chat is typed in, so the chat has the room; the tabs hide
  const typing = useChatTyping(mobile, view?.keyboard ?? false);
  const strip = keyboardStrip(typing);
  const [phoneTab, setPhoneTab] = useState<PhoneTab>('chat');
  // a phone's tabs once opened stay mounted, hidden while another is open (the chat keeps its place and
  // the line being typed); the calendar and the socials wait for their first open
  const [opened, setOpened] = useState<ReadonlySet<PhoneTab>>(() => new Set<PhoneTab>(['chat', 'about']));
  const params = useParams<{ name: string }>();
  const navigate = useNavigate();
  const { state } = useLocation();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // the player's box is held through the first ask when there is reason to expect a stream
  // before the socket has said the word: the card or row that was clicked said they are
  // streaming (`state.live`), or the api's card already stood the box there (`servedWithCard`).
  // the ask decides: a grant that says not live drops the hold, and it never comes back for
  // a re-ask (the socket's word is what holds the box from then on)
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
  const stats = useAtomValue(watchStatsAtom);
  const verified = useAtomValue(verifiedAtom);
  const oauthVerified = useAtomValue(oauthVerifiedAtom);
  const avatar = useAtomValue(avatarAtom);
  const offline = useAtomValue(offlineAtom);
  const offlineNote = useAtomValue(offlineNoteAtom);
  const followers = useAtomValue(followersAtom);
  const socials = useAtomValue(socialsAtom);
  const joined = useAtomValue(joinedAtom);
  // my own page: the socials tab edits the links in place (SocialsEditor.tsx)
  const mine = useAtomValue(myNameAtom) === name;
  const phase = useAtomValue(watchPhaseAtom);
  const presence = useAtomValue(presenceOfAtom(name));
  const tiles = useAtomValue(tilesAtom);
  const layers = useAtomValue(watchLayersAtom);
  const primary = useAtomValue(primarySlotAtom);
  const sceneTile = useAtomValue(sceneTileAtom);
  const viewers = useAtomValue(watchViewersAtom);
  const renamedTo = useAtomValue(watchRenamedToAtom);
  // the layout setting: a column on the left, a column on the right, or a window over the page.
  // closed, a column slides out to that side and the video takes the row
  const chatSide = useChatSide();
  const chatOpen = useAtomValue(chatModalOpenAtom);
  // one corner player at a time: while your own stream is in it (left on air on the go live
  // page), this stream cannot go there too, and the button says so. the other way round, start
  // on the go live page ends a stream kept in the corner (publish-atoms' goLive)
  const cornerTaken = useAtomValue(publishPipAtom);
  // a fake stream gets a page from its name. anyone else's is read from the api.
  const about = useMemo(() => (isDummyName(name) ? dummyPage(name, { offline }) : null), [name, offline]);
  // the offline box where the player goes shows a thumbnail: their offline picture, else the first of
  // their home card's pictures (the profile read the person card keeps, follow-atoms' loadPeek), else black
  const thumbs = useAtomValue(peeksAtom)[name]?.card.thumbs;
  const [brokenThumb, setBrokenThumb] = useState<string | null>(null);
  useEffect(() => {
    if (name && !isDummyName(name)) void loadPeek(name);
  }, [name]);
  const offlineThumb = offline !== null ? api.offlineUrl(name, offline) : thumbs?.[0] !== undefined ? api.streamThumbUrl(name, thumbs[0]) : null;
  const shownThumb = offlineThumb !== brokenThumb ? offlineThumb : null;

  // Mount only: start watching the name in the url (or take back the stream picture in picture
  // kept alive), and on the way out stop, unless picture in picture keeps it going in the corner.
  // The tab is named after them (the api already did so in the html it served).
  useEffect(() => {
    const name = cleanName(params.name);
    document.title = name ? `${name} · streams` : 'streams';
    void watch(name);
    return () => {
      document.title = 'streams';
      leaveWatchPage();
    };
  }, []);

  // The name in the url was renamed (the grant or a push said so): this page is the new name's
  // now. The route is keyed on the name, so this remounts and starts over there. See docs/ids.md
  useEffect(() => {
    if (!renamedTo) return;
    store.set(watchRenamedToAtom, null);
    navigate(`/watch/${renamedTo}`, { replace: true });
  }, [renamedTo]);

  // The first ask follows the phase: the first `loading` is it beginning, the first phase after
  // that is its answer. Set during the render that sees the change (react runs it again before
  // painting), so no frame shows anything held past the answer.
  if (ask === 'before' && phase === 'loading') setAsk('asking');
  else if (ask === 'asking' && phase !== 'loading') setAsk('done');
  // the first ask is under way right now (not a re-ask, and not a page back on a stream the
  // corner kept, which never asks): what is held for it is held now
  const firstAsk = ask !== 'done' && phase === 'loading';

  // The stream is expected and not here yet: they are streaming, as the word says (or as the
  // hold assumes, until the ask has answered), and the page is asking or waiting to be told.
  // Then the player's box stands grey where the player will, so nothing moves when it does.
  const expecting = phase === 'loading' ? presence === 'streaming' || (expectLive && firstAsk) : phase === 'waiting' && presence === 'streaming';

  // The picture in picture button is a home click that keeps the stream: on, then away, and
  // the MiniPlayer has it in the corner by the time the home page shows.
  const toCorner = () => {
    startPip();
    navigate('/');
  };

  // the title row, desktop and phone alike (PageFrame's `person` row): their face with the presence square on
  // its corner (`#presence`, the word on hover and for screen readers), the name over how many follow and
  // watch, and at the right end follow and, for a friend, the line to them
  const face = name ? (
    <span className="relative shrink-0">
      <Face name={name} version={avatar} className={mobile ? 'h-8 w-8 text-sm' : 'h-10 w-10 text-lg'} />
      <PresenceSquare id="presence" labelled presence={presence} className="border-background" />
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
      {verified && (
        <Tooltip content="has an account: this really is them">
          <span role="img" aria-label="has an account" className="shrink-0 text-increase">
            ✓
          </span>
        </Tooltip>
      )}
      {oauthVerified && <OAuthMark id="watch-oauth-verified" size={16} className="shrink-0" />}
      {isDummyName(name) && <TestBadge />}
      {/* their status (`bio` on the wire) is hover only: not drawn under the name, it shows in a tooltip
          over the name. #bio stays, unseen, for screen readers and the tests that key on it (docs/spec.md) */}
      {bio && (
        <span id="bio" className="sr-only">
          {bio}
        </span>
      )}
    </span>
  );

  // the player, or the profile while they are not live, and the streamer's pictures beside it: the
  // desktop's video column, and a phone's pinned top. a phone has no chat button on it: the chat is
  // a tab there, never closed
  const player = (
    <>
      {/* the controls sit on the video, along its bottom edge. they stay up while the sound is off
          (a silent stream should show why) and otherwise come up on hover, while a control has
          keyboard focus (not the focus a mouse click leaves behind, or they would stick), and on a
          screen with no hover at all. "tap to play" is the exception: big, in the middle. */}
      {/* not live, and while the api is being asked: the player's own 16:9 box (`#profile`, a strip while a
          phone types, as the player is), so the tabs sit where they will when the stream starts. black, or
          their offline picture (else a thumbnail of their stream), and a small `offline` chip at its bottom
          left once the api has said so; the sentence and the line they wrote are at the top of the about
          tab. the player appears when they start (`live` pushed on the events socket, docs/status.md):
          never a <video> without a stream, not even for the ask.
          the one exception is a stream that is expected: they are streaming and the page is still
          asking (or video is a beat behind the word). then the player's box stands grey where the
          player goes, so the page has its shape and nothing moves down when the picture lands.
          never for a name that is not streaming: nothing flashes on an offline page. the chat's button
          sits on either box where the player's does (a phone's chat is a tab) */}
      {phase === 'waiting' || phase === 'loading' ? (
        expecting ? (
          <Skeleton id="player-loading" label="loading the stream" className="relative aspect-video w-full border border-primaryStroke bg-backgroundSecondary max-md:border-t-0">
            <Bone className="absolute inset-0" />
            {!mobile && (
              <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 p-3">
                <ChatOpenButton className="ml-auto" />
              </div>
            )}
          </Skeleton>
        ) : (
          <div id="profile" data-presence={presence} data-kbd-video={mobile || undefined} className={cn('relative', mobile && strip.box)} style={mobile ? strip.style : undefined}>
            <div className={cn('relative aspect-video w-full overflow-hidden border border-primaryStroke bg-black max-md:border-x-0 max-md:border-t-0', mobile && strip.frame)}>
              {shownThumb && (
                <img
                  id={offline !== null ? 'offline-picture' : undefined}
                  src={shownThumb}
                  alt=""
                  draggable={false}
                  className="absolute inset-0 h-full w-full object-cover"
                  onError={() => setBrokenThumb(shownThumb)}
                />
              )}
              {phase === 'waiting' && (
                <span className="absolute bottom-2 left-2 flex items-center gap-1.5 border border-white/10 bg-black/70 px-2 py-0.5 text-xs font-semibold text-white">
                  <span aria-hidden className="h-2 w-2 bg-textTertiary" />
                  offline
                </span>
              )}
              {!mobile && (
                <div className="absolute bottom-0 right-0 p-3">
                  <ChatOpenButton />
                </div>
              )}
            </div>
          </div>
        )
      ) : (
        <div data-kbd-video={mobile || undefined} className={cn('group relative', mobile && strip.box)} style={mobile ? strip.style : undefined}>
          {/* the streamer's frame as they laid it out (docs/screen.md): `#video`, the one with the sound,
              stands in for the bottom video layer; a video layer clicked is shown alone */}
          <SceneView
            id="scene"
            // a phone's player sits right on the row's own stroke: no second line between them. its middle third is the strip while typing
            className={cn('max-md:border-t-0', mobile && strip.frame)}
            layers={layers}
            streamFor={slotStreamAtom}
            imageUrl={(asset) => api.assetUrl(name, asset)}
            // their avatar, moving with the sound arriving on #video's stream: drawn here from the name, nothing of it on the wire
            avatar={{ name, version: avatar, streamAtom: remoteStreamAtom }}
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
          {/* the same grey over the frame until frames play (`playing` on #video, markPlaying): the box
              that was loading goes on loading, instead of turning black for the connection. inside the
              stroke, under the controls and tap to play, and no pointer of its own */}
          {(phase === 'connecting' || phase === 'connected') && <Bone className="pointer-events-none absolute inset-px" />}
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
          {/* top left, once frames play: how the picture is arriving. up on its own while it is in trouble */}
          {canHear && <StreamStatsButton id="stats" role="watch" stats={stats} playback={{ muted, level: volume }} />}
          {/* while the chat is closed the bar stays up, so the button that brings it back is on the picture */}
          {phase !== 'bad-name' && (
            <div className={cn('absolute inset-x-0 bottom-0 flex items-center gap-3 p-3', revealClassName(muted || (!mobile && !chatOpen)))}>
              {canHear && <SoundControl videoRef={videoRef} buttonId="unmute" dialId="volume" />}
              {mobile ? <span className="ml-auto" /> : <ChatOpenButton className="ml-auto" />}
              <IconButton id="pip" label={cornerTaken ? 'your stream is in the corner' : 'picture in picture'} disabled={cornerTaken} onClick={toCorner}>
                <PipIcon />
              </IconButton>
            </div>
          )}
        </div>
      )}
      {/* the streamer's pictures that are not in the frame (left beside it, or the frame set aside for one
          pulled out of it): click one and it is the big one; the sound stays put. `the stream` puts the
          streamer's frame back when no picture of theirs can */}
      {(tiles.length > 0 || sceneTile) && (
        <div id="tiles" className="mt-2 flex gap-2 overflow-x-auto">
          {sceneTile && (
            <button
              id="tile-scene"
              type="button"
              onClick={clearChoice}
              className="flex aspect-video w-40 shrink-0 items-center justify-center border border-dashed border-secondaryStroke text-sm text-textSecondary transition-colors duration-150 hover:border-primaryBlue hover:text-textPrimary"
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

  // follow in the title row (docs/follows.md; the count moves with the click, the api's number comes with
  // the next grant), and beside it for a friend the line to them. a fake stream has neither
  const followButton = (className?: string) => (
    <FollowButton id="follow" name={name} small={mobile} className={className} onChange={(now) => store.set(followersAtom, (followers ?? 0) + (now ? 1 : -1))} />
  );
  const rowEnd =
    name && !isDummyName(name) ? (
      <>
        {followButton(mobile ? 'min-h-11 min-w-11' : undefined)}
        <DmButton name={name} />
      </>
    ) : undefined;
  const followersCount = name && !isDummyName(name) && followers !== null && (
    <span id="followers">
      {followers} {followers === 1 ? 'follower' : 'followers'}
    </span>
  );

  // a phone's top of the about tab: what is up, who is watching, how many follow them. while the stream
  // plays the line would say `watching`, which the picture already says: then it is for screen readers
  // and the tests alone, and the count stands in its place, the corner player's way
  const status = (
    <div className="my-3 flex flex-wrap items-baseline gap-x-4">
      <StatusLine text={message} tone={tone} className={cn('my-0', phase === 'watching' && 'sr-only')} />
      <ViewerCount id="viewers" count={viewers} className="text-lg text-textSecondary" />
      {followersCount && <span className="ml-auto text-lg text-textSecondary">{followersCount}</span>}
    </div>
  );
  // the desktop's under the picture: only what the title row does not already say. the numbers are its
  // small line, and offline is the chip on the player, so `not live yet` and `watching` (and #viewers and
  // #followers) are for screen readers and the tests alone. connecting, ended, a lost connection show
  const quiet = phase === 'watching' || phase === 'waiting' || phase === 'loading';
  const deskStatus = (
    <div className={cn('relative', !quiet && 'my-3')}>
      <StatusLine text={message} tone={tone} className={cn('my-0', quiet && 'sr-only')} />
      <span className="sr-only">
        <ViewerCount id="viewers" count={viewers} />
        {followersCount}
      </span>
    </div>
  );

  // at the top of the about tab while they are not live: the line they wrote (if any), then the sentence
  const offlineWords = phase === 'waiting' && !expecting && (
    <div className="mb-4 text-sm text-textSecondary">
      {offlineNote && (
        <p id="offline-note" className="text-textPrimary [overflow-wrap:anywhere]">
          {offlineNote}
        </p>
      )}
      <p>{NOT_LIVE_WORDS[presence]}</p>
    </div>
  );

  // after a connection failed, under the picture on a phone too: it is what the picture is waiting on
  const retryRow = canRetry && (
    <div className="my-3">
      <button id="retry" type="button" className="text-base font-semibold text-primaryBlue" onClick={retry}>
        retry
      </button>
    </div>
  );

  if (mobile) {
    // a phone's page is the window and never scrolls (go live's way, LivePage.tsx): the row, the
    // player pinned under it, one row of tabs (about, calendar and socials at the left, the chat at
    // the right end), and the open tab in what is left. only a tab's own content scrolls. the box
    // follows the visual viewport, so the chat's send row stays over the keyboard. the chat is the
    // panel here, not ChatSlot: a phone has no column and no window to put it in
    const tabs: readonly PhoneTab[] = !name ? [] : phase === 'bad-name' ? ['chat'] : PHONE_TABS;
    const shown: PhoneTab = tabs.includes(phoneTab) ? phoneTab : 'chat';
    const openTab = (t: PhoneTab) => {
      setPhoneTab(t);
      setOpened((was) => (was.has(t) ? was : new Set(was).add(t)));
    };
    const content = (t: PhoneTab) =>
      t === 'chat' ? (
        <ChatPanel name={name} className={cn('h-full min-h-0 flex-1', CHAT_MOBILE)} />
      ) : t === 'about' ? (
        <>
          <div className="[&>div]:mt-0">{status}</div>
          {offlineWords}
          <About key={name} name={name} doc={about} edit={mine} />
        </>
      ) : t === 'calendar' ? (
        <Calendar name={name} />
      ) : (
        <SocialsTab name={name} doc={socials} joined={joined} mine={mine} />
      );
    return (
      <div
        data-keyboard={typing || (view?.keyboard ?? false)}
        className="group/phone fixed inset-x-0 top-0 flex h-[100dvh] flex-col overflow-hidden bg-background pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
        style={view ? { height: view.height, transform: view.top ? `translateY(${view.top}px)` : undefined } : undefined}
      >
        <PageFrame
          title={title}
          titleId="who"
          // the row: the menu, their face and its presence square, the name over how many follow and watch, home, then follow and the line to a friend
          mobileStart={face}
          mobileSub={streamNumbers(name && !isDummyName(name) ? followers : null, viewers)}
          mobileEnd={rowEnd}
          wide
          bleed
          fill
        >
          <div className="shrink-0">
            {player}
            {retryRow && <div className="px-4">{retryRow}</div>}
          </div>
          {tabs.length > 0 && (
            <div id="watch-tabs" className="flex min-h-0 flex-1 flex-col">
              <div role="tablist" aria-label="about them" onKeyDown={roveTabs} className={cn('flex shrink-0 border-b border-primaryStroke px-1', typing && 'hidden')}>
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
                        '-mb-px min-h-11 whitespace-nowrap border-b-2 px-3 text-sm font-semibold leading-tight transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primaryBlue',
                        t === 'chat' && 'ml-auto',
                        on ? 'border-primaryBlue text-textPrimary' : 'border-transparent text-textSecondary'
                      )}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
              {/* every tab opened stays mounted, hidden while another is open: the chat keeps its place
                  and the line being typed. the chat's own lines scroll inside it, its send row at the foot */}
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
                      t === 'chat' ? 'flex flex-col' : 'overflow-y-auto overscroll-contain px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4'
                    )}
                  >
                    {(opened.has(t) || shown === t) && content(t)}
                  </div>
                ))}
              </div>
            </div>
          )}
        </PageFrame>
        <KbdDebug typing={typing} />
      </div>
    );
  }

  return (
    <PageFrame
      title={title}
      titleId="who"
      // the phone's row at full width: their face and its square, the name over its numbers, follow and the line to a friend
      person
      mobileStart={face}
      mobileSub={streamNumbers(name && !isDummyName(name) ? followers : null, viewers)}
      mobileEnd={rowEnd}
      wide
    >
      {/* the video column, the chat, the tabs, in that order. left or right is a grid at lg+ (the
          chat across both rows, the tabs under the video) whose column eases shut when the chat
          closes; on a narrow screen the column sits under the picture. a window takes the chat
          out of the grid. the panel itself stays mounted either way: ChatSlot is one dialog, and
          a remount would be a reconnect. */}
      <div className={chatLayoutClass(chatSide, chatOpen)}>
        <div className={cn('min-w-0', chatSide === 'left' && 'lg:col-start-2 lg:row-start-1')}>
          {player}
          {deskStatus}

          {retryRow}
        </div>

        {name && (
          <ChatSlot>
            <ChatPanel name={name} className={cn('h-full min-h-0 flex-1', chatSide === 'modal' && 'border-0')} />
          </ChatSlot>
        )}

        {/* under the player: the about tab (the page of their own, docs/about.md), the calendar
            (when they stream, docs/calendar.md) and the socials (where else to find them, and
            since when they are here, docs/socials.md). the grant brought the links and the date,
            no request; on my own page the socials tab edits the links in place. a tab's content
            is only in the page while it is open */}
        {name && phase !== 'bad-name' && (
          <div
            id="watch-tabs"
            className={cn('mt-4 min-w-0', chatSide === 'right' && 'lg:col-start-1 lg:mt-0', chatSide === 'left' && 'lg:col-start-2 lg:row-start-2 lg:mt-0')}
          >
            <div role="tablist" aria-label="about them" onKeyDown={roveTabs} className="flex gap-1 border-b border-primaryStroke">
              {WATCH_TABS.map((t) => {
                const on = t === tab;
                return (
                  <button
                    key={t}
                    id={`tab-${t}`}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    aria-controls={on ? `panel-${t}` : undefined}
                    tabIndex={on ? 0 : -1}
                    onClick={() => setTab(t)}
                    className={cn(
                      '-mb-px border-b-2 px-3 py-1.5 font-semibold leading-tight transition-colors duration-150',
                      on
                        ? 'border-primaryBlue bg-backgroundTertiary text-textPrimary'
                        : 'border-transparent text-textSecondary hover:bg-backgroundTertiary/60 hover:text-textPrimary'
                    )}
                  >
                    {t}
                  </button>
                );
              })}
            </div>
            <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} className="pt-4">
              {tab === 'about' ? (
                <>
                  {offlineWords}
                  <About key={name} name={name} doc={about} edit={mine} />
                </>
              ) : tab === 'calendar' ? (
                <Calendar name={name} />
              ) : (
                <SocialsTab name={name} doc={socials} joined={joined} mine={mine} />
              )}
            </div>
          </div>
        )}
      </div>
    </PageFrame>
  );
}
