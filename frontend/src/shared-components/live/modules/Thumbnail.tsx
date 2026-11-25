import { RiCloseLine, RiImageLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useRef, useState } from 'react';

import { api } from '@/infra/api';
import { addStreamThumb, removeStreamThumb, sceneAtom, streamNameAtom, streamThumbsAtom, thumbStatusAtom } from '@/infra/atoms/publish-atoms';
import { livePanelsAtom, setLivePanel, setRail } from '@/infra/live-dock';
import { frameOf } from '@/infra/scene-frame';
import { Button } from '@/shared-components/Button';
import { FOLD, FOLD_BUTTON, FOLD_OPEN, FOLD_SHUT, FoldButton } from '@/shared-components/live/Dock';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

const MOST = 6;

async function grabFrame(): Promise<boolean> {
  const root = document.getElementById('scene');
  const frame = root ? await frameOf(root) : null;
  if (!frame) return false;
  await addStreamThumb(new File([frame], 'frame.jpg', { type: 'image/jpeg' }));
  return true;
}

export function ThumbnailsBody() {
  const name = useAtomValue(streamNameAtom);
  const thumbs = useAtomValue(streamThumbsAtom);
  const thumbStatus = useAtomValue(thumbStatusAtom);
  const empty = useAtomValue(sceneAtom).layers.length === 0;
  const [taking, setTaking] = useState(false);
  const [missed, setMissed] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const full = thumbs.length >= MOST;
  const saving = thumbStatus === 'saving';
  const frameWhy = empty ? 'nothing on the preview to capture yet' : full ? '6 thumbnails at most: remove one first' : saving ? 'saving the last one' : null;
  const takeFrame = async () => {
    setTaking(true);
    setMissed(false);
    const took = await grabFrame().catch(() => false);
    setTaking(false);
    setMissed(!took);
  };
  return (
    <div id="thumbs" className="flex flex-col gap-2">
      {thumbs.length > 0 ? (
        <ul className="m-0 grid list-none grid-cols-3 gap-1.5 p-0">
          {thumbs.map((id) => (
            <li key={id} className="group/thumb relative">
              <img src={api.streamThumbUrl(name, id)} alt="" draggable={false} className="block aspect-video w-full rounded-card border border-primaryStroke object-cover" />
              <Tooltip content="remove">
                <button
                  id={`thumb-remove-${id}`}
                  type="button"
                  aria-label="remove this thumbnail"
                  onClick={() => void removeStreamThumb(id)}
                  className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-avatar border border-primaryStroke bg-backgroundSecondary text-textSecondary hover:border-decrease hover:text-decrease focus-visible:border-primaryBlue focus-visible:outline-none"
                >
                  <RiCloseLine aria-hidden size={12} />
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      ) : (
        <p className="flex h-16 items-center justify-center rounded-card border border-dashed border-secondaryStroke px-3 text-center text-xs text-textTertiary">
          none yet: home shows one frame of the camera
        </p>
      )}
      <div className="flex min-w-0 items-center gap-2">
        <input
          ref={fileRef}
          id="thumb-file"
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void addStreamThumb(file);
          }}
        />
        <Button
          id="thumb-add"
          size="sm"
          variant="outline"
          className="h-7 min-w-0 flex-1 whitespace-nowrap px-2 py-0 text-xs max-md:min-h-11"
          disabled={full || saving}
          onClick={() => fileRef.current?.click()}
        >
          {thumbs.length > 0 ? 'add another' : 'add a thumbnail'}
        </Button>
        <Tooltip content={frameWhy ?? 'add the preview as it is now'}>
          <Button id="thumb-frame" size="sm" className="h-7 min-w-0 flex-1 whitespace-nowrap px-2 py-0 text-xs max-md:min-h-11" disabled={frameWhy !== null || taking} onClick={() => void takeFrame()}>
            use frame
          </Button>
        </Tooltip>
      </div>
      <span id="thumbstatus" className="min-w-0 truncate text-xs text-textSecondary empty:-mt-2" aria-live="polite">
        {missed ? 'the preview has no picture yet' : thumbStatus}
      </span>
    </div>
  );
}

export function ThumbnailModule({ strip = false }: { strip?: boolean }) {
  const open = useAtomValue(livePanelsAtom).thumbnail;
  const name = useAtomValue(streamNameAtom);
  const first = useAtomValue(streamThumbsAtom)[0];
  if (strip)
    return (
      <div className="flex flex-col items-center pt-2">
        <Tooltip content="thumbnail">
          <button id="live-thumb-mini" type="button" aria-label="open the thumbnail" onClick={() => setRail(true)} className={cn(FOLD_BUTTON, 'h-6 w-8 overflow-hidden p-0')}>
            {first !== undefined ? (
              <img src={api.streamThumbUrl(name, first)} alt="" draggable={false} className="h-full w-full object-cover" />
            ) : (
              <RiImageLine aria-hidden size={14} />
            )}
          </button>
        </Tooltip>
      </div>
    );
  return (
    <section id="thumbs-panel" aria-labelledby="thumbs-panel-title" className="flex flex-col border-t border-primaryStroke px-3 py-2">
      <h2 className="flex h-7 items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wider text-textTertiary">
        <span id="thumbs-panel-title">thumbnail</span>
        <FoldButton id="thumbs-panel-toggle" open={open} controls="thumbs-panel-body" what="thumbnail" onToggle={() => setLivePanel('thumbnail', !open)} />
      </h2>
      <div id="thumbs-panel-body" inert={!open ? true : undefined} className={cn(FOLD, open ? FOLD_OPEN : FOLD_SHUT)}>
        <div className="min-h-0 overflow-hidden">
          <div className="pt-1.5">
            <ThumbnailsBody />
          </div>
        </div>
      </div>
    </section>
  );
}
