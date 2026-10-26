import { atom, useAtomValue } from 'jotai';
import { useRef } from 'react';
import { useLocation } from 'react-router-dom';

import {
  cameraAtom,
  endLive,
  liveViewersAtom,
  ownerAtom,
  publishMessageAtom,
  publishPhaseAtom,
  publishPipAtom,
  publishStatsAtom,
  publishToneAtom,
  streamNameAtom
} from '@/infra/atoms/publish-atoms';
import { friendsOpenAtom } from '@/infra/atoms/follow-atoms';
import { pipChatPlaceAtom, panelSideAtom } from '@/infra/atoms/settings-atoms';
import {
  canHearAtom,
  endWatch,
  markAutoplayBlocked,
  markPlaying,
  mutedAtom,
  needsTapAtom,
  pipAtom,
  remoteStreamAtom,
  unmuteVideo,
  volumeAtom,
  watchMessageAtom,
  watchNameAtom,
  watchStatsAtom,
  watchToneAtom,
  watchViewersAtom
} from '@/infra/atoms/watch-atoms';
import { cleanName } from '@/infra/names';
import { cn } from '@/utils/cn';
import { store } from '@/infra/store';
import { Button } from '@/shared-components/Button';
import { CornerPlayer } from '@/shared-components/CornerPlayer';
import { StreamStatsButton } from '@/shared-components/StreamStats';
import { SoundControl } from '@/shared-components/VideoControls';
import { ViewerCount } from '@/shared-components/ViewerCount';

/** `/watch/<name>` or `/watch/<name>/`, spelled any way the page would read as this name. */
function isWatchPageOf(pathname: string, name: string): boolean {
  const m = /^\/watch\/([^/]+)\/?$/.exec(pathname);
  return m !== null && cleanName(m[1]) === name;
}

const isLivePage = (pathname: string) => pathname.replace(/\/$/, '') === '/live';

/** The pages with a chat of their own. The chat atoms hold one room, so the players' chats stay closed there. */
const hasOwnChat = (pathname: string) => /^\/(watch\/|live\/?$)/.test(pathname);

/** The two players, by the id prefix each puts on its elements. */
type Corner = 'pip' | 'live-pip';

/**
 * Which player's chat button is on, if any. One, not one each: the chat atoms hold one room,
 * so the second chat opened closes the first. Kept while a page with its own chat hides the
 * chat, and across streams: the button is a choice for the visit.
 */
const cornerChatAtom = atom<Corner | null>(null);

function toggleCornerChat(corner: Corner) {
  store.set(cornerChatAtom, store.get(cornerChatAtom) === corner ? null : corner);
}

/**
 * The stream being watched, while picture in picture is on and you are anywhere but its own
 * watch page (there the page's <video> plays; a second one here would be a second sound).
 * Same session, same MediaStream atom, same status words. On hover it has the sound control
 * and the stats; its chat is the stream's.
 */
function WatchCorner() {
  const pip = useAtomValue(pipAtom);
  const name = useAtomValue(watchNameAtom);
  const message = useAtomValue(watchMessageAtom);
  const tone = useAtomValue(watchToneAtom);
  const muted = useAtomValue(mutedAtom);
  const volume = useAtomValue(volumeAtom);
  const stats = useAtomValue(watchStatsAtom);
  const canHear = useAtomValue(canHearAtom);
  const needsTap = useAtomValue(needsTapAtom);
  const viewers = useAtomValue(watchViewersAtom);
  const pipChat = useAtomValue(pipChatPlaceAtom);
  const cornerChat = useAtomValue(cornerChatAtom);
  const { pathname } = useLocation();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  return (
    <CornerPlayer
      prefix="pip"
      visible={pip && name !== '' && !isWatchPageOf(pathname, name)}
      label={`${name}, picture in picture`}
      name={name}
      to={`/watch/${encodeURIComponent(name)}`}
      // once the stream plays, the viewer count stands where the word `watching` would: a number says that, and more
      message={tone === 'live' && viewers !== null ? <ViewerCount id="pip-viewers" count={viewers} /> : message}
      tone={tone}
      streamAtom={remoteStreamAtom}
      videoRef={videoRef}
      muted={muted}
      volume={volume}
      onPlaying={markPlaying}
      onAutoplayBlocked={markAutoplayBlocked}
      chat={{ name, place: pipChat, open: cornerChat === 'pip', pageHasChat: hasOwnChat(pathname), onToggle: () => toggleCornerChat('pip') }}
      closeLabel="stop watching"
      onClose={endWatch}
      center={
        needsTap && (
          <Button
            id="pip-tap-to-play"
            variant="primary"
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 px-3 py-1.5 text-sm"
            onClick={() => unmuteVideo(videoRef.current)}
          >
            tap to play
          </Button>
        )
      }
      bar={
        canHear && (
          <>
            <SoundControl videoRef={videoRef} buttonId="pip-unmute" dialId="pip-volume" dialClassName="w-20" />
            <StreamStatsButton id="pip-stats" role="watch" stats={stats} tipAt="above-left" panel="up" playback={{ muted, level: volume }} />
          </>
        )
      }
      barShown={muted}
    />
  );
}

/**
 * Your own stream, wherever you go while it is up (leaving the go live page with a stream on
 * air puts it here) and you are anywhere but that page: the camera (muted, it is you), the
 * status word (`live`, green), how many are watching, the upload stats on hover, and your own
 * chat with your lines marked. The stream itself is untouched: the peer, the socket and the
 * camera are the same module handles the page uses. The × is stop: your stream ends and the
 * camera goes, as if you had pressed stop on the page.
 */
function LiveCorner() {
  const pip = useAtomValue(publishPipAtom);
  const name = useAtomValue(streamNameAtom);
  const message = useAtomValue(publishMessageAtom);
  const tone = useAtomValue(publishToneAtom);
  const phase = useAtomValue(publishPhaseAtom);
  const stats = useAtomValue(publishStatsAtom);
  const viewers = useAtomValue(liveViewersAtom);
  const owner = useAtomValue(ownerAtom);
  const pipChat = useAtomValue(pipChatPlaceAtom);
  const cornerChat = useAtomValue(cornerChatAtom);
  const { pathname } = useLocation();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sending = phase === 'live' || phase === 'reconnecting';

  return (
    <CornerPlayer
      prefix="live-pip"
      visible={pip && name !== '' && !isLivePage(pathname)}
      label={`${name}, your stream, picture in picture`}
      name={name}
      to="/live"
      message={message}
      tone={tone}
      streamAtom={cameraAtom}
      videoRef={videoRef}
      muted
      chat={{ name, owner, place: pipChat, open: cornerChat === 'live-pip', pageHasChat: hasOwnChat(pathname), onToggle: () => toggleCornerChat('live-pip') }}
      closeLabel="stop streaming"
      onClose={endLive}
      bar={sending && <StreamStatsButton id="live-pip-stats" role="publish" stats={stats} tipAt="above-left" panel="up" />}
      footer={<ViewerCount id="live-pip-viewers" count={viewers} />}
    />
  );
}

/**
 * The corner players, rendered once by the router's shell so they survive every route change,
 * and so does where you put them. Stacked at the bottom right corner until dragged: your own
 * stream at the corner, the stream you watch above it, so going live and watching someone
 * else in picture in picture at once do not sit on each other. A player that was dragged
 * leaves the stack and stays where it was dropped.
 */
export function MiniPlayer() {
  const side = useAtomValue(panelSideAtom);
  const sidebarOpen = useAtomValue(friendsOpenAtom);
  return (
    <div
      id="corner-players"
      className={cn(
        'pointer-events-none fixed bottom-6 z-50 flex flex-col items-end gap-3',
        // the sidebar can take the right edge: keep the players in the page, not on the column
        side === 'right' ? (sidebarOpen ? 'right-96' : 'right-[6.5rem]') : 'right-6'
      )}
    >
      <WatchCorner />
      <LiveCorner />
    </div>
  );
}
