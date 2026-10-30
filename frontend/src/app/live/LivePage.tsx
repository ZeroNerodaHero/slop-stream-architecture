import { useAtomValue } from 'jotai';
import { useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import {
  addStreamThumb,
  avatarStatusAtom,
  bioDraftAtom,
  bioStatusAtom,
  cameraAtom,
  canShareScreenAtom,
  canStartAtom,
  chatRoomAtom,
  commitStreamName,
  copyWatchUrl,
  enterLivePage,
  goLive,
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
  myAvatarAtom,
  ownerAtom,
  publishMessageAtom,
  publishToneAtom,
  removeAvatar,
  removeSource,
  removeStreamThumb,
  reorderSource,
  resizeSource,
  saveAvatar,
  saveBio,
  sceneAtom,
  screenShareSupported,
  screensAtom,
  screenStreamAtom,
  selectedSourceAtom,
  selectSource,
  setStreamName,
  shareScreen,
  sourcesAtom,
  startCamera,
  startPublishPip,
  stopLive,
  streamNameAtom,
  streamThumbsAtom,
  thumbStatusAtom,
  toggleSource,
  watchUrlAtom,
  liveViewersAtom
} from '@/infra/atoms/publish-atoms';
import { chatModalOpenAtom, chatSideAtom } from '@/infra/atoms/settings-atoms';
import { ChatOpenButton, ChatSlot, chatLayoutClass } from '@/shared-components/ChatSlot';
import { isValidName } from '@/infra/names';
import { SCREEN_SLOTS } from '@/infra/relay';
import { store } from '@/infra/store';
import { Avatar } from '@/shared-components/Avatar';
import { Button } from '@/shared-components/Button';
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
  const canStart = useAtomValue(canStartAtom);
  const publishing = useAtomValue(isPublishingAtom);
  const phase = useAtomValue(publishPhaseAtom);
  const stats = useAtomValue(publishStatsAtom);
  const watchUrl = useAtomValue(watchUrlAtom);
  const bioDraft = useAtomValue(bioDraftAtom);
  const bioStatus = useAtomValue(bioStatusAtom);
  const avatar = useAtomValue(myAvatarAtom);
  const avatarStatus = useAtomValue(avatarStatusAtom);
  const thumbs = useAtomValue(streamThumbsAtom);
  const thumbStatus = useAtomValue(thumbStatusAtom);
  const owner = useAtomValue(ownerAtom);
  const viewers = useAtomValue(liveViewersAtom);
  const me = useAtomValue(meAtom);
  const chatSide = useAtomValue(chatSideAtom);
  const chatOpen = useAtomValue(chatModalOpenAtom);
  const screens = useAtomValue(screensAtom);
  const canShare = useAtomValue(canShareScreenAtom);
  const scene = useAtomValue(sceneAtom);
  const sources = useAtomValue(sourcesAtom);
  const previewSlot = useAtomValue(previewSlotAtom);
  const selected = useAtomValue(selectedSourceAtom);
  const mixerOpen = useAtomValue(mixerOpenAtom);
  const fileRef = useRef<HTMLInputElement | null>(null);
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

  // Mount only: open the camera (or find it still on, back from the corner), fill the name box,
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
          <div className="flex flex-wrap items-baseline gap-x-4">
            <StatusLine text={message} tone={tone} />
            <ViewerCount id="viewers" count={viewers} className="text-lg text-textSecondary" />
          </div>

          <div className="my-3 flex flex-wrap items-center gap-3">
            <label htmlFor="name" className="sr-only">
              your name
            </label>
            <input
              id="name"
              value={name}
              onChange={(e) => setStreamName(e.target.value)}
              onBlur={() => void commitStreamName()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              disabled={publishing || !!me}
              title={me ? 'you stream as your account' : undefined}
              placeholder="your name"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              maxLength={32}
              className="w-full max-w-[320px] border border-primaryStroke bg-backgroundSecondary px-4 py-3 text-textPrimary disabled:opacity-60"
            />
            {!publishing && (
              <Button id="start" variant="primary" flat disabled={!canStart} onClick={() => void goLive()}>
                start
              </Button>
            )}
            {publishing && (
              <Button id="stop" variant="danger" flat onClick={() => stopLive()}>
                stop
              </Button>
            )}
            {/* one screen (or window, or tab) per press, up to SCREEN_SLOTS at once; the same as the sources' +.
                not on phones: no screen capture there */}
            {publishing && screenShareSupported && (
              <button
                id="share-screen"
                type="button"
                disabled={!canShare}
                title={screens.length >= SCREEN_SLOTS ? `${SCREEN_SLOTS} screens at most` : undefined}
                className="text-base font-semibold text-primaryBlue disabled:opacity-40"
                onClick={() => void shareScreen()}
              >
                share screen
              </button>
            )}
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
            <ChatPanel name={chatRoom} owner={owner} className={cn('h-full min-h-0 flex-1', chatSide === 'modal' && 'border-0 shadow-none')} />
          ) : (
            <aside
              id="chat"
              className="flex h-full min-h-[200px] flex-1 items-center justify-center border border-dashed border-secondaryStroke p-6 text-center text-textTertiary"
            >
              type your name and the chat opens here. once you are live, your lines are marked.
            </aside>
          )}
        </ChatSlot>

        <div className={cn('min-w-0', chatSide === 'right' && 'lg:col-start-1', chatSide === 'left' && 'lg:col-start-2 lg:row-start-2')}>
          <section className={panelClassName('my-5 px-5 py-4')}>
            {/* the status: one line about you, under your name on your page and beside it on home. `bio` on the
                wire (the word `status` is the presence choice's, docs/status.md). the profile tab has the same box */}
            <label htmlFor="bio" className="text-textSecondary">
              your status
            </label>
            <p className="mt-1 text-sm text-textSecondary">one line: what you are up to, what this stream is. under your name on your page, on your card on home.</p>
            <input
              id="bio"
              value={bioDraft}
              onChange={(e) => store.set(bioDraftAtom, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveBio();
              }}
              placeholder="what are you up to. what is this stream."
              maxLength={500}
              autoComplete="off"
              className="mt-2 w-full border border-primaryStroke bg-background px-4 py-3 text-textPrimary"
            />
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button id="savebio" type="button" className="text-base font-semibold text-primaryBlue" onClick={() => void saveBio()}>
                save status
              </button>
              <span id="biostatus" className="text-textSecondary" aria-live="polite">
                {bioStatus}
              </span>
            </div>
            {isValidName(name) && (
              <p className="mt-3 text-sm text-textTertiary">
                your links are written on your page, under the player:{' '}
                <Link id="your-page" to={`/watch/${name}`} className="text-primaryBlue underline-offset-2 hover:underline">
                  /watch/{name}
                </Link>
              </p>
            )}

            {/* the picture: on the watch page next to your name, and in the preview card of a shared link */}
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-primaryStroke pt-4">
              <Avatar name={name} version={avatar} className="mr-0 h-16 w-16" />
              <span className="text-textSecondary">your picture</span>
              <input
                ref={fileRef}
                id="avatar-file"
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void saveAvatar(file);
                }}
              />
              <button id="avatar-pick" type="button" className="text-base font-semibold text-primaryBlue" onClick={() => fileRef.current?.click()}>
                {avatar === null ? 'choose picture' : 'change picture'}
              </button>
              {avatar !== null && (
                <button id="avatar-remove" type="button" className="text-base font-semibold text-textTertiary" onClick={() => void removeAvatar()}>
                  remove
                </button>
              )}
              <span id="avatarstatus" className="text-textSecondary" aria-live="polite">
                {avatarStatus}
              </span>
            </div>

            {/* pictures for the card on home. none, and that card shows the camera */}
            <div className="mt-4 border-t border-primaryStroke pt-4">
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
            </div>
          </section>
        </div>
      </div>
    </PageFrame>
  );
}
