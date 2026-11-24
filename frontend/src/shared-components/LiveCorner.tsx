import { useAtomValue } from 'jotai';
import { useRef } from 'react';
import { useLocation } from 'react-router-dom';

import { api } from '@/infra/api';
import { myAvatarVersionAtom } from '@/infra/atoms/profile-atoms';
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
  publishStatsAtom,
  publishToneAtom,
  sceneAtom,
  sentStreamAtom,
  streamNameAtom
} from '@/infra/atoms/publish-atoms';
import { publishPipAtom } from '@/infra/atoms/publish-state';
import { pipChatPlaceAtom } from '@/infra/atoms/settings-atoms';
import { useIsMobile } from '@/infra/mobile';
import { cornerChatAtom, isLivePage, toggleCornerChat } from '@/shared-components/corner-chat';
import { CORNER_BADGE, CORNER_BADGE_2, CornerPlayer } from '@/shared-components/CornerPlayer';
import { MicMeter } from '@/shared-components/MicMeter';
import { StreamStatsButton } from '@/shared-components/StreamStats';
import { ViewerCount } from '@/shared-components/ViewerCount';

export function LiveCorner() {
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
  const storedPipChat = useAtomValue(pipChatPlaceAtom);
  const pipChat = useIsMobile() ? 'bottom' : storedPipChat;
  const cornerChat = useAtomValue(cornerChatAtom);
  const { pathname } = useLocation();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sending = phase === 'live' || phase === 'reconnecting';

  return (
    <CornerPlayer
      prefix="live-pip"
      visible={pip && name !== '' && !isLivePage(pathname)}
      popOutOnLeave={publishing && name !== ''}
      label={`${name}, your stream, picture in picture`}
      name={name}
      to="/live"
      message={message}
      tone={tone}
      streamAtom={previewStreamAtom}
      videoRef={videoRef}
      muted
      scene={{
        layers: scene.layers,
        slot: previewSlot,
        streamFor: sentStreamAtom,
        imageUrl: (asset) => api.assetUrl(name, asset),
        avatar: { name, version: myAvatar, streamAtom: cameraAtom, read: mixerOpen ? micLevelReader : undefined }
      }}
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
      closeConfirm={{ title: 'stop streaming?', message: 'closing this will stop the stream. everyone watching sees it end.', yes: 'yes, stop' }}
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
