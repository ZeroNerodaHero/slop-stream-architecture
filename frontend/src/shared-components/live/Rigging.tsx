import { useAtomValue } from 'jotai';
import { useEffect, useRef } from 'react';

import {
  faceAtom,
  faceLinesAtom,
  faceMirrorAtom,
  type FaceReading,
  livePanelsAtom,
  modelAtom,
  readerCameraAtom,
  rigPictureAtom,
  screenMaySeePageAtom,
  setLivePanel,
  watchFaceMarks
} from '@/infra/atoms/publish-atoms';
import type { FaceLines, FaceMarks } from '@/infra/face';
import { Collapsible } from '@/shared-components/live/Collapsible';
import { cn } from '@/utils/cn';

const WORDS: Record<FaceReading, string> = {
  idle: '',
  starting: 'getting ready to read your face',
  on: '',
  lost: 'no face in view',
  off: 'the face reader did not load',
  'no-camera': 'no camera to read your face',
  'camera-blocked': 'camera blocked'
};

const BARS: readonly { id: string; label: string; of: (marks: FaceMarks) => number }[] = [
  { id: 'mouth', label: 'mouth open', of: (marks) => marks.mouth },
  { id: 'blink', label: 'eyes shut', of: (marks) => marks.blink },
  { id: 'smile', label: 'smile', of: (marks) => marks.smile },
  { id: 'brows-up', label: 'brows up', of: (marks) => Math.max(0, marks.brows) },
  { id: 'brows-down', label: 'brows down', of: (marks) => Math.max(0, -marks.brows) }
];
const TURNS: readonly { id: string; label: string; of: (marks: FaceMarks) => number }[] = [
  { id: 'turn', label: 'head turn', of: (marks) => marks.yaw },
  { id: 'nod', label: 'head nod', of: (marks) => marks.pitch },
  { id: 'tilt', label: 'head tilt', of: (marks) => marks.roll }
];
const REST: FaceMarks = { points: null, yaw: 0, pitch: 0, roll: 0, mouth: 0, blink: 0, smile: 0, brows: 0 };
const ASPECT = 4 / 3;
const FACE_FILLS = 0.6;
const CLOSEST = 0.3;
const FOLLOW_S = 0.6;
const HEAD_UP = 0.06;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function RigBody() {
  const stream = useAtomValue(readerCameraAtom);
  const face = useAtomValue(faceAtom);
  const mirror = useAtomValue(faceMirrorAtom);
  const picture = useAtomValue(rigPictureAtom);
  const sharing = useAtomValue(screenMaySeePageAtom);
  const lines = useAtomValue(faceLinesAtom);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const numbersRef = useRef<HTMLDivElement | null>(null);
  const linesRef = useRef<FaceLines | null>(null);
  const readingRef = useRef(false);
  const repaintRef = useRef<() => void>(() => undefined);
  const reading = face === 'on';
  const shown = picture && !sharing && stream !== null;
  const settings = stream?.getVideoTracks()[0]?.getSettings();
  const aspect = settings?.width && settings.height ? settings.width / settings.height : ASPECT;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = shown ? stream : null;
    if (shown) video.play().catch(() => undefined);
    return () => {
      video.srcObject = null;
    };
  }, [stream, shown]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const numbers = numbersRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !numbers || !ctx) return;
    const win = canvas.ownerDocument.defaultView ?? window;
    const bars = BARS.map((bar) => ({
      meter: numbers.querySelector<HTMLElement>(`#rig-${bar.id}`),
      fill: numbers.querySelector<HTMLElement>(`#rig-${bar.id} > span`),
      value: numbers.querySelector<HTMLElement>(`#rig-${bar.id}-value`),
      shown: 0
    }));
    const turns = TURNS.map((turn) => ({ value: numbers.querySelector<HTMLElement>(`#rig-${turn.id}`), shown: 0 }));
    const still = win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const view = { x: 0.5, y: 0.5, across: 1 };
    let latest: FaceMarks = REST;
    let frame = 0;
    let frames = 0;
    let paintedAt = 0;
    let last = '';
    const inks = { at: -Infinity, mesh: '', outline: '', features: '', irises: '' };

    const paint = (now: number) => {
      frame = 0;
      const marks = readingRef.current ? latest : REST;
      const to = { x: 0.5, y: 0.5, across: 1 };
      if (marks.points && !still) {
        let top = 1;
        let bottom = 0;
        let left = 1;
        let right = 0;
        for (let i = 0; i + 1 < marks.points.length; i += 2) {
          const x = marks.points[i]!;
          const y = marks.points[i + 1]!;
          if (x < left) left = x;
          if (x > right) right = x;
          if (y < top) top = y;
          if (y > bottom) bottom = y;
        }
        to.across = clamp((bottom - top) / FACE_FILLS, CLOSEST, 1);
        to.x = clamp((left + right) / 2, to.across / 2, 1 - to.across / 2);
        to.y = clamp((top + bottom) / 2 - (bottom - top) * HEAD_UP, to.across / 2, 1 - to.across / 2);
      }
      const since = now - paintedAt;
      const k = 1 - Math.exp(-(since > 0 && since < 250 ? since / 1000 : 1 / 30) / FOLLOW_S);
      paintedAt = now;
      view.x += (to.x - view.x) * k;
      view.y += (to.y - view.y) * k;
      view.across += (to.across - view.across) * k;
      const settled = Math.abs(to.x - view.x) + Math.abs(to.y - view.y) + Math.abs(to.across - view.across) < 0.002;
      if (settled) Object.assign(view, to);
      const zoom = 1 / view.across;
      const video = videoRef.current;
      const through = zoom === 1 ? '' : `scale(${zoom.toFixed(4)}) translate(${((0.5 - view.x) * 100).toFixed(3)}%, ${((0.5 - view.y) * 100).toFixed(3)}%)`;
      if (video && through !== last) {
        last = through;
        video.style.transform = through;
      }
      const dots = win.devicePixelRatio || 1;
      const w = Math.round(canvas.clientWidth * dots);
      const h = Math.round(canvas.clientHeight * dots);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      } else {
        ctx.clearRect(0, 0, w, h);
      }
      const joins = linesRef.current;
      const points = joins && w > 0 ? marks.points : null;
      if (points && joins) {
        if (now - inks.at > 1000) {
          const css = win.getComputedStyle(canvas);
          const colour = (name: string, alpha = 1) => `rgb(${css.getPropertyValue(name).trim()} / ${alpha})`;
          Object.assign(inks, {
            at: now,
            mesh: colour('--text-primary', 0.3),
            outline: colour('--text-primary', 0.85),
            features: colour('--primary-color'),
            irises: colour('--increase')
          });
        }
        const stroke = (pairs: Uint16Array, style: string, width: number) => {
          ctx.strokeStyle = style;
          ctx.lineWidth = width * dots;
          ctx.lineJoin = 'round';
          ctx.beginPath();
          for (let i = 0; i + 1 < pairs.length; i += 2) {
            const a = pairs[i]! * 2;
            const b = pairs[i + 1]! * 2;
            if (b + 1 >= points.length || a + 1 >= points.length) continue;
            ctx.moveTo(((points[a]! - view.x) * zoom + 0.5) * w, ((points[a + 1]! - view.y) * zoom + 0.5) * h);
            ctx.lineTo(((points[b]! - view.x) * zoom + 0.5) * w, ((points[b + 1]! - view.y) * zoom + 0.5) * h);
          }
          ctx.stroke();
        };
        stroke(joins.mesh, inks.mesh, 0.5);
        stroke(joins.outline, inks.outline, 1.25);
        stroke(joins.features, inks.features, 1.75);
        stroke(joins.irises, inks.irises, 1.75);
      }
      canvas.dataset.points = String(points ? points.length / 2 : 0);
      canvas.dataset.frames = String(++frames);
      canvas.dataset.zoom = zoom.toFixed(2);

      BARS.forEach((bar, i) => {
        const el = bars[i]!;
        const value = Math.min(100, Math.max(0, Math.round(bar.of(marks))));
        if (value === el.shown) return;
        el.shown = value;
        if (el.fill) el.fill.style.width = `${value}%`;
        if (el.value) el.value.textContent = `${value}%`;
        el.meter?.setAttribute('aria-valuenow', String(value));
      });
      TURNS.forEach((turn, i) => {
        const el = turns[i]!;
        const value = Math.round(turn.of(marks));
        if (value === el.shown || !el.value) return;
        el.shown = value;
        el.value.textContent = `${value > 0 ? '+' : ''}${value}°`;
        el.value.dataset.value = String(value);
      });
      if (!settled && !readingRef.current) schedule();
    };
    function schedule() {
      if (!frame) frame = win.requestAnimationFrame(paint);
    }
    repaintRef.current = schedule;
    const stop = watchFaceMarks((marks) => {
      latest = marks;
      schedule();
    });
    return () => {
      stop();
      repaintRef.current = () => undefined;
      if (frame) win.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    linesRef.current = lines;
    readingRef.current = reading;
    repaintRef.current();
  }, [lines, reading]);

  const words = WORDS[face];
  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-3 p-3">
        <div id="rig-view" className="relative w-full max-w-md overflow-hidden border border-primaryStroke bg-black" style={{ aspectRatio: String(aspect) }}>
          <div className={cn('absolute inset-0', mirror && '-scale-x-100')}>
            <video
              ref={videoRef}
              id="rig-video"
              aria-label="your camera"
              muted
              playsInline
              autoPlay
              className={cn('absolute inset-0 h-full w-full object-cover', !shown && 'invisible')}
            />
            <canvas ref={canvasRef} id="rig-marks" data-points="0" data-frames="0" data-zoom="1.00" aria-hidden className="absolute inset-0 h-full w-full" />
          </div>
          {words && (
            <p
              id="rig-words"
              className="absolute bottom-2 left-2 max-w-[calc(100%-1rem)] border border-white/10 bg-black/70 px-2 py-0.5 text-xs font-semibold text-white"
            >
              {words}
            </p>
          )}
        </div>
        <div ref={numbersRef} id="rig-numbers" className="flex min-w-0 max-w-sm flex-col gap-2.5">
          {BARS.map((bar) => (
            <div key={bar.id} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="truncate text-textSecondary">{bar.label}</span>
                <span id={`rig-${bar.id}-value`} className="tabular-nums text-textPrimary">
                  0%
                </span>
              </div>
              <span
                id={`rig-${bar.id}`}
                role="meter"
                aria-label={bar.label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={0}
                className="block h-1 w-full bg-backgroundTertiary"
              >
                <span className="block h-full w-0 bg-primaryBlue" />
              </span>
            </div>
          ))}
          <div className="flex flex-col gap-1.5 border-t border-primaryStroke pt-2.5">
            {TURNS.map((turn) => (
              <div key={turn.id} className="flex items-baseline justify-between gap-2 text-xs">
                <span className="truncate text-textSecondary">{turn.label}</span>
                <span id={`rig-${turn.id}`} data-value="0" className="tabular-nums text-textPrimary">
                  0°
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <p id="rig-note" className="border-t border-primaryStroke px-3 py-2 text-xs text-textTertiary">
        {sharing && picture
          ? "only you see this. your camera's picture is hidden while you share a screen: a share of this page would send it."
          : "only you see this. your camera's picture is not sent."}
      </p>
    </>
  );
}

export function Rigging() {
  const model = useAtomValue(modelAtom);
  const open = useAtomValue(livePanelsAtom).rig;
  if (!model) return null;
  return (
    <Collapsible
      id="rig"
      title="rigging"
      open={open}
      onToggle={() => setLivePanel('rig', !open)}
      className="mt-3"
    >
      <RigBody />
    </Collapsible>
  );
}
