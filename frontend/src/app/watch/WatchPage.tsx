import { useAtomValue } from 'jotai';
import { useEffect, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';

import {
  bioAtom,
  canRetryAtom,
  leaveWatchPage,
  markAutoplayBlocked,
  markPlaying,
  markUnmuted,
  mutedAtom,
  needsTapAtom,
  remoteStreamAtom,
  retry,
  showUnmuteAtom,
  watch,
  watchMessageAtom,
  watchNameAtom,
  watchToneAtom
} from '@/infra/atoms/watch-atoms';
import { cleanName } from '@/infra/names';
import { Button } from '@/shared-components/Button';
import { PageFrame } from '@/shared-components/PageFrame';
import { StatusLine } from '@/shared-components/StatusLine';
import { VideoFrame } from '@/shared-components/VideoFrame';

export function WatchPage() {
  const params = useParams<{ name: string }>();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const name = useAtomValue(watchNameAtom);
  const message = useAtomValue(watchMessageAtom);
  const tone = useAtomValue(watchToneAtom);
  const bio = useAtomValue(bioAtom);
  const canRetry = useAtomValue(canRetryAtom);
  const showUnmute = useAtomValue(showUnmuteAtom);
  const needsTap = useAtomValue(needsTapAtom);
  const muted = useAtomValue(mutedAtom);

  // Mount only: start watching the name in the url, stop when the page goes away.
  useEffect(() => {
    void watch(cleanName(params.name));
    return leaveWatchPage;
  }, []);

  // Inside the click, so the browser allows sound.
  function unmute() {
    const el = videoRef.current;
    markUnmuted();
    if (el) {
      el.muted = false;
      el.play().catch(() => undefined);
    }
  }

  return (
    <PageFrame title={name} titleId="who" aside={<Link to="/">home</Link>}>
      <VideoFrame id="video" streamAtom={remoteStreamAtom} videoRef={videoRef} muted={muted} onPlaying={markPlaying} onAutoplayBlocked={markAutoplayBlocked} />
      <StatusLine text={message} tone={tone} />

      <div className="my-3 flex flex-wrap items-center gap-3">
        {showUnmute && (
          <Button id="unmute" variant="primary" onClick={unmute}>
            {needsTap ? 'tap to play' : 'unmute'}
          </Button>
        )}
        {canRetry && (
          <Button id="retry" onClick={retry}>
            retry
          </Button>
        )}
      </div>

      {bio && (
        <p id="bio" className="whitespace-pre-wrap text-textSecondary [overflow-wrap:anywhere]">
          {bio}
        </p>
      )}
    </PageFrame>
  );
}
