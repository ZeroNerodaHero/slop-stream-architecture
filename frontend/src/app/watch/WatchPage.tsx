import { useAtomValue } from 'jotai';
import { useEffect, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import {
  avatarAtom,
  bioAtom,
  canHearAtom,
  canRetryAtom,
  dialAtom,
  leaveWatchPage,
  markAutoplayBlocked,
  markPlaying,
  muteVideo,
  mutedAtom,
  needsTapAtom,
  remoteStreamAtom,
  retry,
  setVolume,
  settleDial,
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

/** A control over the video: the same dark glass as the corner player's × and the cards' live chip, 32px tall. */
const CHIP = 'flex h-8 items-center border border-white/10 bg-black/70 text-sm font-semibold text-textPrimary backdrop-blur-sm transition-colors duration-150';
/** A chip that is itself the button: blue stroke and blue glyph on hover, like every button on the site, over solid black. */
const CHIP_BUTTON = cn(CHIP, 'hover:border-primaryBlue hover:bg-black/90 hover:text-primaryBlue');
/**
 * The name of an icon-only control, above it, while the pointer or keyboard focus is on it
 * (`group/control relative` is the control; it adds `left-0` or `right-0` for which way the name hangs).
 */
const TIP =
  'pointer-events-none absolute bottom-full mb-2 whitespace-nowrap border border-white/10 bg-black/90 px-2 py-1 text-xs font-semibold text-textPrimary opacity-0 transition-opacity duration-150 group-hover/control:opacity-100 group-focus-visible/control:opacity-100';
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

/** The usual picture in picture glyph: a screen with a small picture in its bottom right corner. Square, like the rest. */
function PipIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M3 5h18v14H3z" />
      <path d="M11 11h8v6h-8z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** A speaker. Crossed out while muted; angular sound waves (no arcs in this theme) when the sound is on. */
function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="miter">
      <path d="M3 9h4l5-4v14l-5-4H3z" fill="currentColor" />
      {muted ? <path d="M16 9l6 6M22 9l-6 6" /> : <path d="M16 9l2 3-2 3M19 6l3 6-3 6" />}
    </svg>
  );
}

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
  const dial = useAtomValue(dialAtom);
  /** Where the dial was when it was taken hold of (pointer or key), for `settleDial` when it is let go. */
  const grabbed = useRef(dial);
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
                  'absolute inset-x-0 bottom-0 flex items-center gap-3 p-3 transition-[opacity,transform] duration-200',
                  // hidden: faded and 4px low, and it waits 300ms before going (a pointer that strays off the
                  // video for a moment does not make the controls blink). shown: at once.
                  !muted &&
                    'translate-y-1 opacity-0 delay-300 group-hover:translate-y-0 group-hover:opacity-100 group-hover:delay-0 [&:has(:focus-visible)]:translate-y-0 [&:has(:focus-visible)]:opacity-100 [&:has(:focus-visible)]:delay-0 [@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100'
                )}
              >
                {canHear && (
                  <div className={cn(CHIP, 'gap-3 pr-3 hover:border-white/30')}>
                    <button
                      id="unmute"
                      type="button"
                      aria-label={muted ? 'unmute' : 'mute'}
                      className="group/control relative flex h-full w-8 items-center justify-center transition-colors duration-150 hover:text-primaryBlue"
                      onClick={() => (muted ? unmuteVideo : muteVideo)(videoRef.current)}
                    >
                      <SpeakerIcon muted={muted} />
                      <span role="tooltip" className={cn(TIP, 'left-0')}>
                        {muted ? 'unmute' : 'mute'}
                      </span>
                    </button>
                    <input
                      id="volume"
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={dial}
                      aria-label="volume"
                      title={`volume ${Math.round(dial * 100)}%`}
                      onChange={(e) => setVolume(videoRef.current, e.target.valueAsNumber)}
                      onPointerDown={() => (grabbed.current = dial)}
                      onPointerUp={() => settleDial(grabbed.current)}
                      onKeyDown={(e) => {
                        if (!e.repeat) grabbed.current = dial;
                      }}
                      onKeyUp={() => settleDial(grabbed.current)}
                      className={DIAL}
                      style={{ background: `linear-gradient(to right, rgb(var(--text-primary)) ${dial * 100}%, rgb(255 255 255 / 0.3) ${dial * 100}%)` }}
                    />
                  </div>
                )}
                <button
                  id="pip"
                  type="button"
                  aria-label="picture in picture"
                  onClick={toCorner}
                  className={cn(CHIP_BUTTON, 'group/control relative ml-auto w-8 justify-center')}
                >
                  <PipIcon />
                  <span role="tooltip" className={cn(TIP, 'right-0')}>
                    picture in picture
                  </span>
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
