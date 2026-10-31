import { useAtomValue } from 'jotai';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import {
  avatarAtom,
  bioAtom,
  canHearAtom,
  canRetryAtom,
  clearChoice,
  followersAtom,
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
import { followingAtom } from '@/infra/atoms/follow-atoms';
import { type Presence, PRESENCE_SQUARE, PRESENCE_TEXT, PRESENCE_WORD, presenceOfAtom } from '@/infra/atoms/presence-atoms';
import { myNameAtom } from '@/infra/atoms/profile-atoms';
import { publishPipAtom } from '@/infra/atoms/publish-atoms';
import { chatModalOpenAtom, chatSideAtom } from '@/infra/atoms/settings-atoms';
import { ChatOpenButton, ChatSlot, chatLayoutClass } from '@/shared-components/ChatSlot';
import { demoAbout, dummyPage } from '@/infra/about';
import { api } from '@/infra/api';
import { cleanName, isDummyName } from '@/infra/names';
import { store } from '@/infra/store';
import { About } from '@/shared-components/About';
import { Calendar } from '@/shared-components/Calendar';
import { FollowButton } from '@/shared-components/FollowButton';
import { Button } from '@/shared-components/Button';
import { ChatPanel } from '@/shared-components/ChatPanel';
import { Face } from '@/shared-components/Face';
import { panelClassName } from '@/shared-components/Panel';
import { PageFrame } from '@/shared-components/PageFrame';
import { SceneView } from '@/shared-components/SceneView';
import { Bone, Skeleton } from '@/shared-components/Skeleton';
import { SocialsTab } from '@/shared-components/SocialsEditor';
import { StatusLine } from '@/shared-components/StatusLine';
import { ViewerCount } from '@/shared-components/ViewerCount';
import { StreamStatsButton } from '@/shared-components/StreamStats';
import { StreamTile } from '@/shared-components/StreamTile';
import { TestBadge } from '@/shared-components/TestBadge';
import { IconButton, MailIcon, PipIcon, SoundControl, revealClassName } from '@/shared-components/VideoControls';
import { cn } from '@/utils/cn';

/** The sentence under the word while they are not live: why to wait, or not. */
const NOT_LIVE_WORDS: Record<Presence, string> = {
  offline: 'not streaming right now. the stream shows up here the moment they start.',
  online: 'around, not streaming. the stream shows up here the moment they start.',
  dnd: 'do not disturb, not streaming.',
  streaming: 'starting'
};

/** Under the player: their page (docs/about.md), when they stream (docs/calendar.md), and where else to find them (docs/socials.md). In this order. */
type WatchTab = 'about' | 'calendar' | 'socials';
const WATCH_TABS: readonly WatchTab[] = ['about', 'calendar', 'socials'];
const TAB_STEP: Record<string, number | undefined> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

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

/** Arrows move the focus along the tabs and open the one landed on; Home and End go to the ends. The user modal's tabs do the same. */
function roveTabs(e: KeyboardEvent<HTMLDivElement>) {
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const i = tabs.indexOf(e.target as HTMLButtonElement);
  if (i < 0) return;
  const step = TAB_STEP[e.key];
  const next = step !== undefined ? (i + step + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
  const button = tabs[next];
  if (next < 0 || !button) return;
  e.preventDefault();
  button.click();
  button.focus();
}

/**
 * Beside the chat's button, wherever that is on the page: a line to the streamer (docs/dms.md),
 * the same chip. For a friend alone, someone this login follows who follows it back: a line
 * goes nowhere else, and the sidebar's list already says who that is. It opens the chat
 * window on their thread (or shows the one they have), lit while that thread is the one on
 * screen, and then it hides the window, the chat button's way.
 */
function DmButton({ name, className }: { name: string; className?: string }) {
  const friend = useAtomValue(followingAtom)?.find((f) => f.name === name && f.mutual);
  const open = useAtomValue(dmOpenAtom);
  const active = useAtomValue(dmActiveAtom);
  if (!friend) return null;
  const on = open && active === name;
  return (
    <IconButton
      id="dm-open"
      label={on ? `hide the chat with ${name}` : `message ${name}`}
      active={on}
      className={className}
      onClick={() => (on ? hideDms() : openDm({ id: '', name, avatar: friend.avatar, verified: friend.verified, bio: friend.bio, presence: friend.presence }))}
    >
      <MailIcon />
    </IconButton>
  );
}

export function WatchPage() {
  const [tab, setTab] = useState<WatchTab>('about');
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
  const avatar = useAtomValue(avatarAtom);
  const offline = useAtomValue(offlineAtom);
  const offlineNote = useAtomValue(offlineNoteAtom);
  const followers = useAtomValue(followersAtom);
  const socials = useAtomValue(socialsAtom);
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
  const chatSide = useAtomValue(chatSideAtom);
  const chatOpen = useAtomValue(chatModalOpenAtom);
  // one corner player at a time: while your own stream is in it (left on air on the go live
  // page), this stream cannot go there too, and the button says so. the other way round, start
  // on the go live page ends a stream kept in the corner (publish-atoms' goLive)
  const cornerTaken = useAtomValue(publishPipAtom);
  // a fake stream gets a page from its name. anyone else gets the sample, until they build their own.
  const about = useMemo(() => (isDummyName(name) ? dummyPage(name, { offline }) : demoAbout(name, { offline, thumbs: [] })), [name, offline]);

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

  return (
    <PageFrame
      title={
        <>
          {/* their picture, or the letter their name makes when they have none: a face left of the name either way */}
          {name && <Face name={name} version={avatar} className="mr-3 inline-flex align-middle" />}
          {name}
          {verified && (
            <span className="ml-2 text-increase" title="has an account: this really is them">
              ✓
            </span>
          )}
          {isDummyName(name) && <TestBadge />}
          {/* the word beside the name (docs/status.md): the square and the word, from the events socket.
              not live, `online` is the reason to wait and `do not disturb` the reason not to */}
          {name && (
            <span
              id="presence"
              data-presence={presence}
              className={cn('ml-3 inline-flex items-center gap-1.5 align-middle text-base font-normal', PRESENCE_TEXT[presence])}
            >
              <span aria-hidden className={cn('inline-block h-3 w-3', PRESENCE_SQUARE[presence])} />
              {PRESENCE_WORD[presence]}
            </span>
          )}
          {/* their status: the one line about them, under the name (the profile tab sets it; `bio` on the wire).
              one line here too, the whole of it on hover. it comes with the grant: until then a line of grey
              its height stands under the name, so the title row (and the whole page under it) does not grow
              by a line when the grant lands */}
          {bio ? (
            <span id="bio" title={bio} className="mt-1 block truncate text-base font-normal text-textSecondary">
              {bio}
            </span>
          ) : (
            firstAsk && <Bone className="mt-1 h-6 w-72 max-w-full" />
          )}
        </>
      }
      titleId="who"
      wide
    >
      {/* the video column, the chat, the tabs, in that order. left or right is a grid at lg+ (the
          chat across both rows, the tabs under the video) whose column eases shut when the chat
          closes; on a narrow screen the column sits under the picture. a window takes the chat
          out of the grid. the panel itself stays mounted either way: ChatSlot is one dialog, and
          a remount would be a reconnect. */}
      <div className={chatLayoutClass(chatSide, chatOpen)}>
        <div className={cn('min-w-0', chatSide === 'left' && 'lg:col-start-2 lg:row-start-1')}>
          {/* the controls sit on the video, along its bottom edge. they stay up while the sound is off
              (a silent stream should show why) and otherwise come up on hover, while a control has
              keyboard focus (not the focus a mouse click leaves behind, or they would stick), and on a
              screen with no hover at all. "tap to play" is the exception: big, in the middle. */}
          {/* not live, and while the api is being asked: the profile where the picture would be
              (docs/follows.md). the face, the word and a sentence; the tabs sit below and the chat stays.
              the player appears when they start (`live` pushed on the events socket, docs/status.md), so
              there is nothing to press and no black box, not even for the ask: a player with no stream
              would be one. a streamer who put an offline picture gets it where the player goes, the
              profile under it, and the line they wrote (if any) above the sentence.
              the one exception is a stream that is expected: they are streaming and the page is still
              asking (or video is a beat behind the word). then the player's box stands grey where the
              player goes, so the page has its shape and nothing moves down when the picture lands.
              never a <video>, never for a name that is not streaming: nothing flashes on an offline
              profile. the chat's button sits on it where the player's does */}
          {phase === 'waiting' || phase === 'loading' ? (
            expecting ? (
              <Skeleton id="player-loading" label="loading the stream" className="relative aspect-video w-full border border-primaryStroke bg-backgroundSecondary">
                <Bone className="absolute inset-0" />
                <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 p-3">
                  <ChatOpenButton className="ml-auto" />
                  <DmButton name={name} />
                </div>
              </Skeleton>
            ) : (
              <>
                {offline !== null && (
                  <img
                    id="offline-picture"
                    src={api.offlineUrl(name, offline)}
                    alt=""
                    draggable={false}
                    className="mb-3 aspect-video w-full border border-primaryStroke bg-black object-cover"
                  />
                )}
                <div id="profile" className={cn(panelClassName('flex flex-wrap items-center gap-6 p-6'))} data-presence={presence}>
                  <Face name={name} version={avatar} className="h-28 w-28 text-5xl" />
                  <div className="min-w-0 flex-1">
                    <p className={cn('flex items-center gap-2 text-lg font-semibold', PRESENCE_TEXT[presence])}>
                      <span aria-hidden className={cn('inline-block h-3 w-3', PRESENCE_SQUARE[presence])} />
                      {PRESENCE_WORD[presence]}
                    </p>
                    {offlineNote && (
                      <p id="offline-note" className="mt-1 [overflow-wrap:anywhere]">
                        {offlineNote}
                      </p>
                    )}
                    <p className="mt-1 text-textSecondary">{phase === 'loading' ? 'loading' : NOT_LIVE_WORDS[presence]}</p>
                  </div>
                  {/* the chat's button lives on the player; without a player it lives here, and a friend's line button with it */}
                  <span className="flex items-center gap-3 self-start">
                    <ChatOpenButton />
                    <DmButton name={name} />
                  </span>
                </div>
              </>
            )
          ) : (
            <div className="group relative">
              {/* the streamer's frame as they laid it out (docs/screen.md): `#video`, the one with the sound,
                  stands in for the bottom video layer; a video layer clicked is shown alone */}
              <SceneView
                id="scene"
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
              {/* while the chat is closed the bar stays up, so the button that brings it back is on the picture.
                  beside it, for a friend, the line to them (docs/dms.md) */}
              {phase !== 'bad-name' && (
                <div className={cn('absolute inset-x-0 bottom-0 flex items-center gap-3 p-3', revealClassName(muted || !chatOpen))}>
                  {canHear && <SoundControl videoRef={videoRef} buttonId="unmute" dialId="volume" />}
                  <ChatOpenButton className="ml-auto" />
                  <DmButton name={name} />
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
          {/* under the picture: what is up, who is watching, and at the right end how many follow them and the
              button to (docs/follows.md; the count moves with the click, the api's number comes with the next
              grant). while the stream plays the line would say `watching`, which the picture and the word beside
              the name already say: then it is for screen readers and the tests alone, and the count stands in its
              place, the corner player's way. the line comes back for anything else: not live, connecting, ended */}
          <div className="my-3 flex flex-wrap items-baseline gap-x-4">
            <StatusLine text={message} tone={tone} className={cn('my-0', phase === 'watching' && 'sr-only')} />
            <ViewerCount id="viewers" count={viewers} className="text-lg text-textSecondary" />
            {name && !isDummyName(name) && (
              <span className="ml-auto inline-flex items-center gap-3">
                {followers !== null && (
                  <span id="followers" className="text-lg text-textSecondary">
                    {followers} {followers === 1 ? 'follower' : 'followers'}
                  </span>
                )}
                <FollowButton id="follow" name={name} onChange={(now) => store.set(followersAtom, (followers ?? 0) + (now ? 1 : -1))} />
              </span>
            )}
          </div>

          {canRetry && (
            <div className="my-3">
              <button id="retry" type="button" className="text-base font-semibold text-primaryBlue" onClick={retry}>
                retry
              </button>
            </div>
          )}
        </div>

        {name && (
          <ChatSlot>
            <ChatPanel name={name} className={cn('h-full min-h-0 flex-1', chatSide === 'modal' && 'border-0')} />
          </ChatSlot>
        )}

        {/* under the player: the about tab (the page of their own, docs/about.md), the calendar
            (when they stream, docs/calendar.md) and the socials (where else to find them,
            docs/socials.md). the grant brought the links, no request; on my own page the socials
            tab edits them in place. a tab's content is only in the page while it is open */}
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
                <About name={name} doc={about} edit={mine} sample={!isDummyName(name)} />
              ) : tab === 'calendar' ? (
                <Calendar name={name} />
              ) : (
                <SocialsTab name={name} doc={socials} mine={mine} />
              )}
            </div>
          </div>
        )}
      </div>
    </PageFrame>
  );
}
