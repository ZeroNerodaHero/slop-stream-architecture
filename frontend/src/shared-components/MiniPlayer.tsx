import { atom, useAtomValue } from 'jotai';
import { Component, type ErrorInfo, type ReactNode, useRef } from 'react';
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
import { report } from '@/infra/report';
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

/**
 * One corner player's own catch. A crash in a player (or in its popped out window) is that
 * player's alone: without this it reached the router's crash page, which replaces every page,
 * and the crash page's reload ended a stream that was still up. The stream lives in the atoms,
 * not here, so it goes on; the player is tried again on the next page.
 */
class CornerCatch extends Component<{ at: string; children: ReactNode }, { failed: boolean; at: string }> {
  state = { failed: false, at: this.props.at };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: { at: string }, state: { failed: boolean; at: string }) {
    return props.at === state.at ? null : { failed: false, at: props.at };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    report('crash', error, { componentStack: info.componentStack ?? undefined });
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** The two players, by the id prefix each puts on its elements. */
type Corner = 'pip' | 'live-pip';

/**
 * Which player's chat button is on, if any. One, not one each: only one player shows at a time.
 * Each player's chat is its own stream's room (chat-atoms.ts), whatever the page's chat is, so
 * the button stays on across pages and streams: it is a choice for the visit.
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
      // the stream's own room: over a group's channel, a friend's chat or another stream's page alike, the corner's chat is this stream's
      chat={{ name, place: pipChat, open: cornerChat === 'pip', pageChatIsOurs: isWatchPageOf(pathname, name), onToggle: () => toggleCornerChat('pip') }}
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
 * on the page. While the stream is up the player also follows you out of the tab: leave the
 * tab, from the go live page too, and it is in a window of its own over the other tabs and
 * apps, back when the tab is (CornerPlayer `popOutOnLeave`; where the browser does that).
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
      // on air, the player follows you out of the tab: from the go live page too, where it is otherwise not shown
      popOutOnLeave={publishing && name !== ''}
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
      // your own room, as the streamer, on every page: while you watch someone else their page's chat is theirs and this
      // one stays yours. the go live page's chat is this same room: out in the window the player shows it as a guest
      chat={{
        name,
        owner,
        place: pipChat,
        open: cornerChat === 'live-pip',
        pageChatIsOurs: isLivePage(pathname),
        onToggle: () => toggleCornerChat('live-pip')
      }}
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
  const { pathname } = useLocation();
  return (
    <div
      id="corner-players"
      className={cn(
        'pointer-events-none fixed bottom-6 z-50 flex flex-col items-end gap-3',
        // the sidebar can take the right edge: keep the players in the page, not on the column (UserPanel.tsx: 3.5rem closed, 300px open, and the 1.5rem)
        side === 'right' ? (sidebarOpen ? 'right-[324px]' : 'right-20') : 'right-6'
      )}
    >
      <CornerCatch at={pathname}>
        <WatchCorner />
      </CornerCatch>
      <CornerCatch at={pathname}>
        <LiveCorner />
      </CornerCatch>
    </div>
  );
}
