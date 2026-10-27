import { useAtomValue } from 'jotai';
import { useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import {
  avatarAtom,
  bioAtom,
  cameraOverlaidAtom,
  canHearAtom,
  canRetryAtom,
  followersAtom,
  layoutAtom,
  leaveWatchPage,
  markAutoplayBlocked,
  markPlaying,
  mutedAtom,
  needsTapAtom,
  offlineAtom,
  offlineNoteAtom,
  pickSlot,
  remoteStreamAtom,
  retry,
  slotLabel,
  slotStreamAtom,
  startPip,
  tilesAtom,
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
import { type Presence, PRESENCE_SQUARE, PRESENCE_TEXT, PRESENCE_WORD, presenceOfAtom } from '@/infra/atoms/presence-atoms';
import { publishPipAtom } from '@/infra/atoms/publish-atoms';
import { chatModalOpenAtom, chatSideAtom } from '@/infra/atoms/settings-atoms';
import { ChatOpenButton, ChatSlot, chatLayoutClass } from '@/shared-components/ChatSlot';
import { api } from '@/infra/api';
import { cleanName, isDummyName } from '@/infra/names';
import { store } from '@/infra/store';
import { Avatar } from '@/shared-components/Avatar';
import { FollowButton } from '@/shared-components/FollowButton';
import { Button } from '@/shared-components/Button';
import { CameraOverlay } from '@/shared-components/CameraOverlay';
import { ChatPanel } from '@/shared-components/ChatPanel';
import { Face } from '@/shared-components/Face';
import { panelClassName } from '@/shared-components/Panel';
import { PageFrame } from '@/shared-components/PageFrame';
import { StatusLine } from '@/shared-components/StatusLine';
import { ViewerCount } from '@/shared-components/ViewerCount';
import { StreamStatsButton } from '@/shared-components/StreamStats';
import { StreamTile } from '@/shared-components/StreamTile';
import { TestBadge } from '@/shared-components/TestBadge';
import { IconButton, PipIcon, SoundControl, revealClassName } from '@/shared-components/VideoControls';
import { VideoFrame } from '@/shared-components/VideoFrame';
import { cn } from '@/utils/cn';

/** The sentence under the word while they are not live: why to wait, or not. */
const NOT_LIVE_WORDS: Record<Presence, string> = {
  offline: 'not streaming right now. the stream shows up here the moment they start.',
  online: 'around, not streaming. the stream shows up here the moment they start.',
  dnd: 'do not disturb, not streaming.',
  streaming: 'starting'
};

export function WatchPage() {
  const params = useParams<{ name: string }>();
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement | null>(null);
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
  const phase = useAtomValue(watchPhaseAtom);
  const presence = useAtomValue(presenceOfAtom(name));
  const tiles = useAtomValue(tilesAtom);
  const layout = useAtomValue(layoutAtom);
  const overlaid = useAtomValue(cameraOverlaidAtom);
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
          <Avatar name={name} version={avatar} />
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
          {/* follow them, and how many do (docs/follows.md). the count moves with the click; the api's number comes with the next grant */}
          {name && !isDummyName(name) && (
            <span className="ml-3 inline-flex items-center gap-2 align-middle text-base font-normal">
              <FollowButton id="follow" name={name} onChange={(now) => store.set(followersAtom, (followers ?? 0) + (now ? 1 : -1))} />
              {followers !== null && (
                <span id="followers" className="text-textSecondary">
                  {followers} {followers === 1 ? 'follower' : 'followers'}
                </span>
              )}
            </span>
          )}
        </>
      }
      titleId="who"
      wide
    >
      {/* the video column, the chat, the bio, in that order. left or right is a grid at lg+ (the
          chat across both rows, the bio under the video) whose column eases shut when the chat
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
              (docs/follows.md). the face, the word and a sentence; the bio sits below and the chat stays.
              the player appears when they start (`live` pushed on the events socket, docs/status.md), so
              there is nothing to press and no black box, not even for the ask: a player with no stream
              would be one. a streamer who put an offline picture gets it where the player goes, the
              profile under it, and the line they wrote (if any) above the sentence */}
          {phase === 'waiting' || phase === 'loading' ? (
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
                {/* the chat's button lives on the player; without a player it lives here */}
                <ChatOpenButton className="self-start" />
              </div>
            </>
          ) : (
            <div className="group relative">
              <VideoFrame
                id="video"
                streamAtom={remoteStreamAtom}
                videoRef={videoRef}
                muted={muted}
                volume={volume}
                onPlaying={markPlaying}
                onAutoplayBlocked={markAutoplayBlocked}
              />
              {/* the camera over a shared screen, where the streamer put it; a click makes it the big one */}
              {overlaid && layout && <CameraOverlay id="camera-overlay" streamAtom={slotStreamAtom(0)} layout={layout} onPick={() => pickSlot(0)} />}
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
                <div className={cn('absolute inset-x-0 bottom-0 flex items-center gap-3 p-3', revealClassName(muted || !chatOpen))}>
                  {canHear && <SoundControl videoRef={videoRef} buttonId="unmute" dialId="volume" />}
                  <ChatOpenButton className="ml-auto" />
                  <IconButton id="pip" label={cornerTaken ? 'your stream is in the corner' : 'picture in picture'} disabled={cornerTaken} onClick={toCorner}>
                    <PipIcon />
                  </IconButton>
                </div>
              )}
            </div>
          )}
          {/* the streamer's other pictures while a screen is shared: the camera beside the screen,
              or the other way round. click one and it is the big one; the sound stays put */}
          {tiles.length > 0 && (
            <div id="tiles" className="mt-2 flex gap-2 overflow-x-auto">
              {tiles.map((tile) => (
                <StreamTile key={tile.slot} id={`tile-${tile.slot}`} streamAtom={slotStreamAtom(tile.slot)} label={slotLabel(tile)} onPick={() => pickSlot(tile.slot)} />
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-baseline gap-x-4">
            <StatusLine text={message} tone={tone} />
            <ViewerCount id="viewers" count={viewers} className="text-lg text-textSecondary" />
          </div>

          {canRetry && (
            <div className="my-3">
              <Button id="retry" onClick={retry}>
                retry
              </Button>
            </div>
          )}
        </div>

        {name && (
          <ChatSlot>
            <ChatPanel name={name} className={cn('h-full min-h-0 flex-1', chatSide === 'modal' && 'border-0 shadow-none')} />
          </ChatSlot>
        )}

        {bio && (
          <p
            id="bio"
            className={cn(
              'mt-4 whitespace-pre-wrap text-textSecondary [overflow-wrap:anywhere]',
              chatSide === 'right' && 'lg:col-start-1 lg:mt-0',
              chatSide === 'left' && 'lg:col-start-2 lg:row-start-2 lg:mt-0'
            )}
          >
            {bio}
          </p>
        )}
      </div>
    </PageFrame>
  );
}
