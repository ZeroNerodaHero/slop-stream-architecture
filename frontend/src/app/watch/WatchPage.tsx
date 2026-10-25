import { useAtomValue } from 'jotai';
import { useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import {
  avatarAtom,
  bioAtom,
  canHearAtom,
  canRetryAtom,
  leaveWatchPage,
  markAutoplayBlocked,
  markPlaying,
  mutedAtom,
  needsTapAtom,
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
  watchToneAtom,
  watchViewersAtom,
} from '@/infra/atoms/watch-atoms';
import { PRESENCE_SQUARE, PRESENCE_TEXT, PRESENCE_WORD, presenceOfAtom } from '@/infra/atoms/presence-atoms';
import { chatModalOpenAtom, chatSideAtom } from '@/infra/atoms/settings-atoms';
import { ChatOpenButton, ChatSlot, chatLayoutClass } from '@/shared-components/ChatSlot';
import { cleanName, isDummyName } from '@/infra/names';
import { Avatar } from '@/shared-components/Avatar';
import { Button } from '@/shared-components/Button';
import { ChatPanel } from '@/shared-components/ChatPanel';
import { PageFrame } from '@/shared-components/PageFrame';
import { StatusLine } from '@/shared-components/StatusLine';
import { ViewerCount } from '@/shared-components/ViewerCount';
import { StreamStatsButton } from '@/shared-components/StreamStats';
import { StreamTile } from '@/shared-components/StreamTile';
import { TestBadge } from '@/shared-components/TestBadge';
import { IconButton, PipIcon, SoundControl, revealClassName } from '@/shared-components/VideoControls';
import { VideoFrame } from '@/shared-components/VideoFrame';
import { cn } from '@/utils/cn';

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
  const phase = useAtomValue(watchPhaseAtom);
  const presence = useAtomValue(presenceOfAtom(name));
  const tiles = useAtomValue(tilesAtom);
  const viewers = useAtomValue(watchViewersAtom);
  // the layout setting: a column on the left, a column on the right, or a window over the page.
  // closed, a column slides out to that side and the video takes the row
  const chatSide = useAtomValue(chatSideAtom);
  const chatOpen = useAtomValue(chatModalOpenAtom);

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
            {/* while the chat is closed the bar stays up, so the button that brings it back is on the picture */}
            {phase !== 'bad-name' && (
              <div className={cn('absolute inset-x-0 bottom-0 flex items-center gap-3 p-3', revealClassName(muted || !chatOpen))}>
                {canHear && <SoundControl videoRef={videoRef} buttonId="unmute" dialId="volume" />}
                {canHear && <StreamStatsButton id="stats" role="watch" stats={stats} tipAt="above-left" panel="up" playback={{ muted, level: volume }} />}
                <ChatOpenButton className="ml-auto" />
                <IconButton id="pip" label="picture in picture" onClick={toCorner}>
                  <PipIcon />
                </IconButton>
              </div>
            )}
          </div>
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
