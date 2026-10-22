import { useAtomValue } from 'jotai';
import { useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';

import {
  endWatch,
  markAutoplayBlocked,
  markPlaying,
  mutedAtom,
  needsTapAtom,
  pipAtom,
  remoteStreamAtom,
  showUnmuteAtom,
  unmuteVideo,
  watchMessageAtom,
  watchNameAtom,
  watchToneAtom
} from '@/infra/atoms/watch-atoms';
import { cleanName } from '@/infra/names';
import { Button } from '@/shared-components/Button';
import { panelClassName } from '@/shared-components/Panel';
import { VideoFrame } from '@/shared-components/VideoFrame';
import { cn } from '@/utils/cn';

/** `/watch/<name>` or `/watch/<name>/`, spelled any way the page would read as this name. */
function isWatchPageOf(pathname: string, name: string): boolean {
  const m = /^\/watch\/([^/]+)\/?$/.exec(pathname);
  return m !== null && cleanName(m[1]) === name;
}

/**
 * The stream in a corner of the page while picture in picture is on and you are anywhere but
 * its own watch page (there the page's <video> plays; a second one here would be a second
 * sound). Same session, same MediaStream atom, same status words. Rendered once, by the
 * router's shell, so it survives every route change.
 */
export function MiniPlayer() {
  const pip = useAtomValue(pipAtom);
  const name = useAtomValue(watchNameAtom);
  const message = useAtomValue(watchMessageAtom);
  const tone = useAtomValue(watchToneAtom);
  const muted = useAtomValue(mutedAtom);
  const showUnmute = useAtomValue(showUnmuteAtom);
  const needsTap = useAtomValue(needsTapAtom);
  const { pathname } = useLocation();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  if (!pip || !name || isWatchPageOf(pathname, name)) return null;
  const to = `/watch/${encodeURIComponent(name)}`;

  return (
    <aside
      id="pip-player"
      aria-label={`${name}, picture in picture`}
      className={panelClassName('fixed bottom-6 right-6 z-50 w-[min(320px,calc(100vw-3rem))] shadow-hard-lg')}
    >
      <div className="relative">
        <Link to={to} aria-label={`back to ${name}`} className="block">
          <VideoFrame
            id="pip-video"
            streamAtom={remoteStreamAtom}
            videoRef={videoRef}
            muted={muted}
            onPlaying={markPlaying}
            onAutoplayBlocked={markAutoplayBlocked}
            className="border-0 border-b"
          />
        </Link>
        <button
          id="pip-close"
          type="button"
          onClick={endWatch}
          aria-label="stop watching"
          title="stop watching"
          className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center border border-white/10 bg-black/70 text-lg leading-none text-textPrimary backdrop-blur-sm hover:border-primaryBlue hover:bg-black/90"
        >
          ×
        </button>
        {showUnmute && (
          <Button id="pip-unmute" variant="primary" className="absolute bottom-2 right-2 px-3 py-1.5 text-sm" onClick={() => unmuteVideo(videoRef.current)}>
            {needsTap ? 'tap to play' : 'unmute'}
          </Button>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
        <Link to={to} className="min-w-0 truncate font-semibold">
          {name}
        </Link>
        <span id="pip-status" className={cn('shrink-0 text-textSecondary', tone === 'live' && 'text-increase', tone === 'bad' && 'text-decrease')}>
          {message}
        </span>
      </div>
    </aside>
  );
}
