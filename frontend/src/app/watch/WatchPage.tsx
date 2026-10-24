import { useAtomValue } from 'jotai';
import { useEffect, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import {
  avatarAtom,
  bioAtom,
  canHearAtom,
  canRetryAtom,
  leaveWatchPage,
  markAutoplayBlocked,
  markPlaying,
  muteVideo,
  mutedAtom,
  needsTapAtom,
  remoteStreamAtom,
  retry,
  setVolume,
  startPip,
  unmuteVideo,
  verifiedAtom,
  volumeAtom,
  watch,
  watchMessageAtom,
  watchNameAtom,
  watchPhaseAtom,
  watchToneAtom
} from '@/infra/atoms/watch-atoms';
import { cleanName, isDummyName } from '@/infra/names';
import { Avatar } from '@/shared-components/Avatar';
import { Button } from '@/shared-components/Button';
import { ChatPanel } from '@/shared-components/ChatPanel';
import { PageFrame } from '@/shared-components/PageFrame';
import { StatusLine } from '@/shared-components/StatusLine';
import { TestBadge } from '@/shared-components/TestBadge';
import { VideoFrame } from '@/shared-components/VideoFrame';
import { cn } from '@/utils/cn';

/** A control over the video: the same dark glass as the corner player's × and the cards' live chip. */
const CHIP = 'border border-white/10 bg-black/70 text-sm font-semibold text-textPrimary backdrop-blur-sm transition-colors hover:border-primaryBlue';
/**
 * The dial. A flat 4px track with a square thumb (the theme has no round shapes); the part up
 * to the thumb is filled through an inline gradient, since no browser draws that on its own.
 */
const DIAL = cn(
  'h-1 w-24 cursor-pointer appearance-none bg-white/30',
  '[&::-webkit-slider-thumb]:-mt-1 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:bg-textPrimary',
  '[&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:rounded-none [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-textPrimary',
  '[&:focus-visible::-webkit-slider-thumb]:bg-primaryBlue [&:focus-visible::-moz-range-thumb]:bg-primaryBlue'
);

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
  const verified = useAtomValue(verifiedAtom);
  const avatar = useAtomValue(avatarAtom);
  const phase = useAtomValue(watchPhaseAtom);

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
        </>
      }
      titleId="who"
      aside={<Link to="/">home</Link>}
      wide
    >
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-6">
        <div className="min-w-0">
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
            {phase !== 'bad-name' && (
              <div
                className={cn(
                  'absolute inset-x-0 bottom-0 flex items-center gap-3 p-3 transition-opacity duration-150',
                  !muted && 'opacity-0 group-hover:opacity-100 [&:has(:focus-visible)]:opacity-100 [@media(hover:none)]:opacity-100'
                )}
              >
                {canHear && (
                  <div className={cn(CHIP, 'flex items-center gap-3 pr-3')}>
                    <button id="unmute" type="button" className="px-3 py-1.5 hover:text-primaryBlue" onClick={() => (muted ? unmuteVideo : muteVideo)(videoRef.current)}>
                      {muted ? 'unmute' : 'mute'}
                    </button>
                    <input
                      id="volume"
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={volume}
                      aria-label="volume"
                      title={`volume ${Math.round(volume * 100)}%`}
                      onChange={(e) => setVolume(videoRef.current, e.target.valueAsNumber)}
                      className={DIAL}
                      style={{
                        background: `linear-gradient(to right, rgb(var(${muted ? '--text-tertiary' : '--text-primary'})) ${volume * 100}%, rgb(255 255 255 / 0.3) ${volume * 100}%)`
                      }}
                    />
                  </div>
                )}
                <button
                  id="pip"
                  type="button"
                  title="keeps playing in a corner while you look around the site"
                  onClick={toCorner}
                  className={cn(CHIP, 'ml-auto px-3 py-1.5')}
                >
                  picture in picture
                </button>
              </div>
            )}
          </div>
          <StatusLine text={message} tone={tone} />

          {canRetry && (
            <div className="my-3">
              <Button id="retry" onClick={retry}>
                retry
              </Button>
            </div>
          )}

          {bio && (
            <p id="bio" className="whitespace-pre-wrap text-textSecondary [overflow-wrap:anywhere]">
              {bio}
            </p>
          )}
        </div>

        {name && <ChatPanel name={name} className="mt-4 h-[60vh] max-h-[640px] lg:mt-0 lg:h-[calc(100vh-140px)] lg:max-h-[720px]" />}
      </div>
    </PageFrame>
  );
}
