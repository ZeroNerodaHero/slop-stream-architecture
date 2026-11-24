import { useAtomValue } from 'jotai';
import { Component, type ErrorInfo, lazy, type ReactNode, Suspense, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { friendsOpenAtom } from '@/infra/atoms/follow-atoms';
import { publishPipAtom } from '@/infra/atoms/publish-state';
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
import { useIsMobile } from '@/infra/mobile';
import { cleanName } from '@/infra/names';
import { report } from '@/infra/report';
import { cn } from '@/utils/cn';
import { Button } from '@/shared-components/Button';
import { cornerChatAtom, isLivePage, toggleCornerChat } from '@/shared-components/corner-chat';
import { CORNER_BADGE, CornerPlayer } from '@/shared-components/CornerPlayer';
import { StreamStatsButton } from '@/shared-components/StreamStats';
import { SoundControl } from '@/shared-components/VideoControls';
import { ViewerCount } from '@/shared-components/ViewerCount';

function isWatchPageOf(pathname: string, name: string): boolean {
  const m = /^\/watch\/([^/]+)\/?$/.exec(pathname);
  return m !== null && cleanName(m[1]) === name;
}

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

const LiveCorner = lazy(() => import('@/shared-components/LiveCorner').then((m) => ({ default: m.LiveCorner })));

function LiveCornerWhenUsed({ pathname }: { pathname: string }) {
  const pip = useAtomValue(publishPipAtom);
  const [used, setUsed] = useState(false);
  if (!used && (pip || isLivePage(pathname))) setUsed(true);
  if (!used) return null;
  return (
    <Suspense fallback={null}>
      <LiveCorner />
    </Suspense>
  );
}

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
  const storedPipChat = useAtomValue(pipChatPlaceAtom);
  const pipChat = useIsMobile() ? 'bottom' : storedPipChat;
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
      message={tone === 'live' && viewers !== null ? <ViewerCount id="pip-viewers" count={viewers} /> : message}
      tone={tone}
      streamAtom={remoteStreamAtom}
      videoRef={videoRef}
      muted={muted}
      volume={volume}
      onPlaying={markPlaying}
      onAutoplayBlocked={markAutoplayBlocked}
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

export function MiniPlayer() {
  const side = useAtomValue(panelSideAtom);
  const sidebarOpen = useAtomValue(friendsOpenAtom);
  const mobile = useIsMobile();
  const { pathname } = useLocation();
  return (
    <div
      id="corner-players"
      className={cn(
        'pointer-events-none fixed bottom-6 z-50 flex flex-col items-end gap-3',
        side === 'right' && !mobile ? (sidebarOpen ? 'right-[324px]' : 'right-20') : 'right-6'
      )}
    >
      <CornerCatch at={pathname}>
        <WatchCorner />
      </CornerCatch>
      <CornerCatch at={pathname}>
        <LiveCornerWhenUsed pathname={pathname} />
      </CornerCatch>
    </div>
  );
}
