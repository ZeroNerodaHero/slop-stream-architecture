import { useAtomValue } from 'jotai';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '@/infra/api';
import {
  addStreamThumb,
  cameraAtom,
  chatRoomAtom,
  copyWatchUrl,
  enterLivePage,
  isPublishingAtom,
  leaveLivePage,
  micLevelReader,
  mixerOpenAtom,
  moveSource,
  nudgeSource,
  previewSlotAtom,
  previewStreamAtom,
  publishPhaseAtom,
  publishStatsAtom,
  ownerAtom,
  publishMessageAtom,
  publishToneAtom,
  removeSource,
  removeStreamThumb,
  reorderSource,
  resizeSource,
  sceneAtom,
  screenStreamAtom,
  selectedSourceAtom,
  selectSource,
  sourcesAtom,
  startCamera,
  startPublishPip,
  streamNameAtom,
  streamThumbsAtom,
  thumbStatusAtom,
  toggleSource,
  watchUrlAtom,
  liveViewersAtom
} from '@/infra/atoms/publish-atoms';
import { chatModalOpenAtom, chatSideAtom } from '@/infra/atoms/settings-atoms';
import { ChatOpenButton, ChatSlot, chatLayoutClass } from '@/shared-components/ChatSlot';
import { ChatPanel } from '@/shared-components/ChatPanel';
import { Mixer } from '@/shared-components/live/Mixer';
import { Presets } from '@/shared-components/live/Presets';
import { Sources } from '@/shared-components/live/Sources';
import { MicMeter } from '@/shared-components/MicMeter';
import { PageFrame } from '@/shared-components/PageFrame';
import { panelClassName } from '@/shared-components/Panel';
import { type SceneEdit, SceneView } from '@/shared-components/SceneView';
import { StatusLine } from '@/shared-components/StatusLine';
import { ViewerCount } from '@/shared-components/ViewerCount';
import { StreamStatsButton } from '@/shared-components/StreamStats';
import { IconButton, PipIcon, revealClassName } from '@/shared-components/VideoControls';
import { cn } from '@/utils/cn';

/** A layer's stream on this side: the camera, or a screen slot's own display stream. */
const streamFor = (slot: number) => (slot === 0 ? cameraAtom : screenStreamAtom(slot - 1));

export function LivePage() {
  const navigate = useNavigate();
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const message = useAtomValue(publishMessageAtom);
  const tone = useAtomValue(publishToneAtom);
  const name = useAtomValue(streamNameAtom);
  const chatRoom = useAtomValue(chatRoomAtom);
  const publishing = useAtomValue(isPublishingAtom);
  const phase = useAtomValue(publishPhaseAtom);
  const stats = useAtomValue(publishStatsAtom);
  const watchUrl = useAtomValue(watchUrlAtom);
  const thumbs = useAtomValue(streamThumbsAtom);
  const thumbStatus = useAtomValue(thumbStatusAtom);
  const owner = useAtomValue(ownerAtom);
  const viewers = useAtomValue(liveViewersAtom);
  const chatSide = useAtomValue(chatSideAtom);
  const chatOpen = useAtomValue(chatModalOpenAtom);
  const scene = useAtomValue(sceneAtom);
  const sources = useAtomValue(sourcesAtom);
  const previewSlot = useAtomValue(previewSlotAtom);
  const selected = useAtomValue(selectedSourceAtom);
  const mixerOpen = useAtomValue(mixerOpenAtom);
  const thumbFileRef = useRef<HTMLInputElement | null>(null);

  // the editor's hooks on the preview: a drag, a corner, the keys. delete takes a picture out and
  // puts a video source beside (a key must not stop a share); the brackets move through the stack
  const edit: SceneEdit = {
    selectedId: selected,
    onSelect: selectSource,
    onMove: moveSource,
    onResize: resizeSource,
    onNudge: nudgeSource,
    onKey: (id, what) => {
      if (what === 'remove') {
        if (sources.find((s) => s.id === id)?.kind === 'image') removeSource(id);
        else toggleSource(id);
      } else reorderSource(id, what === 'forward' ? 'up' : 'down');
    }
  };

  // Mount only: open the camera (or find it still on, back from the corner), settle the name,
  // and on the way out leave a stream that is up to the corner player; with nothing on air,
  // release the camera. The tab closing is the stream's own listener (publish-atoms), since the
  // stream can outlive this page.
  useEffect(() => {
    void startCamera();
    void enterLivePage();
    return leaveLivePage;
  }, []);

  // The picture in picture button is a home click: leaving keeps the stream either way, the
  // button only turns the corner on first, so it has the camera by the time home shows.
  const toCorner = () => {
    startPublishPip();
    navigate('/');
  };

  return (
    <PageFrame title="go live" wide>
      {/* the same arrangement as the watch page, for the same layout setting: the preview, the
          chat, the status box. left or right is a column at lg+ that eases shut when the chat
          closes; a window takes the chat out. */}
      <div className={chatLayoutClass(chatSide, chatOpen)}>
        <div className={cn('min-w-0', chatSide === 'left' && 'lg:col-start-2 lg:row-start-1')}>
          {/* the sources beside the preview at lg and up, above it below that (the chat is not a column
              there either). `items-start`: the sidebar is as tall as it needs, not as tall as the picture */}
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
            <Sources />
            <div className="min-w-0 flex-1">
              <div className="group relative">
                {/* the frame as every watcher gets it (docs/screen.md): the sources on the stream, laid out
                    in fractions. taken hold of here; the watchers' players follow within a beat */}
                <SceneView
                  id="scene"
                  layers={scene.layers}
                  streamFor={streamFor}
                  imageUrl={(asset) => api.assetUrl(name, asset)}
                  main={{ id: 'preview', streamAtom: previewStreamAtom, videoRef: previewRef, slot: previewSlot, muted: true }}
                  edit={edit}
                />
                {/* top left, while the stream is up: the mic, as loud as it is right now, read off the mixer once
                    that is up (the key: a chip mounted before it opens would otherwise keep its own reader);
                    beside it, once live, how the upload is going (up on its own while something limits it) */}
                {publishing && <MicMeter key={mixerOpen ? 'mixer' : 'own'} id="live-mic" streamAtom={cameraAtom} read={mixerOpen ? micLevelReader : undefined} />}
                {(phase === 'live' || phase === 'reconnecting') && <StreamStatsButton id="live-stats" role="publish" stats={stats} className="left-[3.25rem] top-3" />}
                {/* while the chat is closed the bar stays up, so it can be opened again off the preview. once
                    live, picture in picture beside it: the same button as the watch page's, for your own stream
                    (here any way off the page keeps the stream; the button is the one that says so) */}
                <div className={cn('absolute inset-x-0 bottom-0 z-20 flex items-center gap-3 p-3', revealClassName(!chatOpen))}>
                  <ChatOpenButton className="ml-auto" />
                  {publishing && (
                    <IconButton id="live-pip" label="picture in picture" onClick={toCorner}>
                      <PipIcon />
                    </IconButton>
                  )}
                </div>
              </div>
              <Presets />
              {publishing && <Mixer />}
            </div>
          </div>
          {/* the stream's status and who is watching. no name box: a login streams as its account, a guest
              as the nick in the corner panel; start and stop are the foot of the sources panel */}
          <div className="flex flex-wrap items-baseline gap-x-4">
            <StatusLine text={message} tone={tone} />
            <ViewerCount id="viewers" count={viewers} className="text-lg text-textSecondary" />
          </div>

          {watchUrl && (
            <p id="link" className="my-3 [overflow-wrap:anywhere]">
              watch link:{' '}
              <a id="watchurl" href={watchUrl} target="_blank" rel="noopener">
                {watchUrl}
              </a>{' '}
              <button id="copy" type="button" className="ml-2 text-base font-semibold text-primaryBlue" onClick={copyWatchUrl}>
                copy
              </button>
            </p>
          )}
        </div>

        {/* the streamer's own chat, in the room of the settled name. once live, `owner` makes its lines marked */}
        <ChatSlot>
          {chatRoom ? (
            <ChatPanel name={chatRoom} owner={owner} className={cn('h-full min-h-0 flex-1', chatSide === 'modal' && 'border-0')} />
          ) : (
            <aside
              id="chat"
              className="flex h-full min-h-[200px] flex-1 items-center justify-center border border-dashed border-secondaryStroke p-6 text-center text-textTertiary"
            >
              pick a name and the chat opens here. once you are live, your lines are marked.
            </aside>
          )}
        </ChatSlot>

        <div className={cn('min-w-0', chatSide === 'right' && 'lg:col-start-1', chatSide === 'left' && 'lg:col-start-2 lg:row-start-2')}>
          {/* pictures for the card on home. none, and that card shows the camera. the status and the picture are
              not here: the profile tab (the user modal) is where they are set */}
          <section className={panelClassName('my-5 px-5 py-4')}>
            <p className="text-textSecondary">thumbnails</p>
            <p className="mt-1 text-sm text-textSecondary">
              one picture on your card on home, until that page is refreshed. with none, home shows one frame of the camera.
            </p>
            {thumbs.length > 0 && (
              <ul className="mt-3 flex list-none flex-wrap gap-3 p-0">
                {thumbs.map((id) => (
                  <li key={id} className="w-36">
                    <img src={api.streamThumbUrl(name, id)} alt="" draggable={false} className="aspect-video w-full border border-primaryStroke object-cover" />
                    <button id={`thumb-remove-${id}`} type="button" className="mt-2 text-sm font-semibold text-textTertiary" onClick={() => void removeStreamThumb(id)}>
                      remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <input
                ref={thumbFileRef}
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
              <button id="thumb-add" type="button" className="text-base font-semibold text-primaryBlue disabled:opacity-40" disabled={thumbs.length >= 6 || thumbStatus === 'saving'} onClick={() => thumbFileRef.current?.click()}>
                add a thumbnail
              </button>
              <span id="thumbstatus" className="text-textSecondary" aria-live="polite">
                {thumbStatus}
              </span>
            </div>
          </section>
        </div>
      </div>
    </PageFrame>
  );
}
