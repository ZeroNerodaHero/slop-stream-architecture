import { atom, useAtomValue } from 'jotai';
import { useRef } from 'react';
import { useLocation } from 'react-router-dom';

import {
  cameraAtom,
  endLive,
  isPublishingAtom,
  liveViewersAtom,
  micLevelReader,
  mixerOpenAtom,
  ownerAtom,
  previewSlotAtom,
  previewStreamAtom,
  publishMessageAtom,
  publishPhaseAtom,
  publishPipAtom,
  publishStatsAtom,
  publishToneAtom,
  sceneAtom,
  sentStreamAtom,
  streamNameAtom
} from '@/infra/atoms/publish-atoms';
import { friendsOpenAtom } from '@/infra/atoms/follow-atoms';
import { myAvatarVersionAtom } from '@/infra/atoms/profile-atoms';
import { pipChatPlaceAtom, panelSideAtom } from '@/infra/atoms/settings-atoms';
import {
  avatarAtom,
  canHearAtom,
  endWatch,
  markAutoplayBlocked,
  markPlaying,
  mutedAtom,
  needsTapAtom,
  pickSlot,
  pipAtom,
  primarySlotAtom,
  remoteStreamAtom,
  slotStreamAtom,
  unmuteVideo,
  volumeAtom,
  watchLayersAtom,
  watchMessageAtom,
  watchNameAtom,
  watchStatsAtom,
  watchToneAtom,
  watchViewersAtom
} from '@/infra/atoms/watch-atoms';
import { api } from '@/infra/api';
import { cleanName } from '@/infra/names';
import { cn } from '@/utils/cn';
import { store } from '@/infra/store';
import { Button } from '@/shared-components/Button';
import { CORNER_BADGE, CORNER_BADGE_2, CornerPlayer } from '@/shared-components/CornerPlayer';
import { MicMeter } from '@/shared-components/MicMeter';
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
 * Which player's chat button is on, if any. One, not one each: the chat atoms hold one room
 * (and only one player shows at a time anyway). Kept while a page with its own chat hides the
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
  const layers = useAtomValue(watchLayersAtom);
  const primary = useAtomValue(primarySlotAtom);
  const avatar = useAtomValue(avatarAtom);
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
      // the streamer's frame, as on the page: the corner would otherwise show the big picture alone, and a face in a corner of it would be gone
      scene={{
        layers,
        slot: primary,
        streamFor: slotStreamAtom,
        imageUrl: (asset) => api.assetUrl(name, asset),
        avatar: { name, version: avatar, streamAtom: remoteStreamAtom },
        onPick: pickSlot
      }}
      badge={canHear && <StreamStatsButton id="pip-stats" role="watch" stats={stats} className={CORNER_BADGE} playback={{ muted, level: volume }} />}
      bar={canHear && <SoundControl videoRef={videoRef} buttonId="pip-unmute" dialId="pip-volume" dialClassName="w-20" />}
      barShown={muted}
    />
  );
}

/**
 * Your own stream, wherever you go while it is up (leaving the go live page with a stream on
 * air puts it here) and you are anywhere but that page: your frame as the watchers get it
 * (muted, it is you; the preview's `<video>` stands in for the bottom video layer, and a
 * mic-only stream shows its avatar), the status word (`live`, green), how many are watching,
 * the upload stats on hover, and your own chat with your lines marked. The stream itself is
 * untouched: the peer, the socket and the camera are the same module handles the page uses.
 * The × is stop, after a yes (a box in a corner is easy to close by habit, and this one ends
 * the stream for everyone): your stream ends and the camera goes, as if you had pressed stop
 * on the page.
 */
function LiveCorner() {
  const pip = useAtomValue(publishPipAtom);
  const name = useAtomValue(streamNameAtom);
  const message = useAtomValue(publishMessageAtom);
  const tone = useAtomValue(publishToneAtom);
  const phase = useAtomValue(publishPhaseAtom);
  const publishing = useAtomValue(isPublishingAtom);
  const stats = useAtomValue(publishStatsAtom);
  const viewers = useAtomValue(liveViewersAtom);
  const owner = useAtomValue(ownerAtom);
  const scene = useAtomValue(sceneAtom);
  const previewSlot = useAtomValue(previewSlotAtom);
  const mixerOpen = useAtomValue(mixerOpenAtom);
  const myAvatar = useAtomValue(myAvatarVersionAtom);
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
      streamAtom={previewStreamAtom}
      videoRef={videoRef}
      muted
      // the frame as the page's preview draws it, the avatar moving with the mic (off the mixer while it is up)
      scene={{
        layers: scene.layers,
        slot: previewSlot,
        streamFor: sentStreamAtom,
        imageUrl: (asset) => api.assetUrl(name, asset),
        avatar: { name, version: myAvatar, streamAtom: cameraAtom, read: mixerOpen ? micLevelReader : undefined }
      }}
      chat={{ name, owner, place: pipChat, open: cornerChat === 'live-pip', pageHasChat: hasOwnChat(pathname), onToggle: () => toggleCornerChat('live-pip') }}
      closeLabel="stop streaming"
      onClose={endLive}
      // × here ends the stream for everyone watching, from a box in a corner: a yes or no first
      closeConfirm={{ title: 'stop streaming?', message: 'closing this will stop the stream. everyone watching sees it end.', yes: 'yes, stop' }}
      // top left, as on the page: the mic's level while the stream is up, and beside it the upload stats once live
      badge={
        <>
          {publishing && <MicMeter id="live-pip-mic" streamAtom={cameraAtom} className={CORNER_BADGE} />}
          {sending && <StreamStatsButton id="live-pip-stats" role="publish" stats={stats} className={CORNER_BADGE_2} />}
        </>
      }
      footer={<ViewerCount id="live-pip-viewers" count={viewers} />}
    />
  );
}

/**
 * The corner players, rendered once by the router's shell so they survive every route change,
 * and so does where you put them. One shows at a time: your own stream while it is on air
 * (the watch page's picture in picture button is disabled then), else the stream you watch
 * (start on the go live page ends it). Each sits at the bottom right corner until dragged,
 * then stays where it was dropped.
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
