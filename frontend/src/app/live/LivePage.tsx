import { useAtomValue } from 'jotai';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import {
  addStreamThumb,
  avatarStatusAtom,
  bioDraftAtom,
  bioStatusAtom,
  cameraAtom,
  cameraOverlaidAtom,
  canShareScreenAtom,
  canStartAtom,
  chatRoomAtom,
  commitStreamName,
  copyWatchUrl,
  enterLivePage,
  goLive,
  isPublishingAtom,
  layoutAtom,
  leaveLivePage,
  publishPhaseAtom,
  publishStatsAtom,
  myAvatarAtom,
  ownerAtom,
  publishMessageAtom,
  publishToneAtom,
  removeAvatar,
  removeStreamThumb,
  saveAvatar,
  saveBio,
  screenShareSupported,
  screensAtom,
  screenStreamAtom,
  setLayout,
  setStreamName,
  shareScreen,
  stageStreamAtom,
  startCamera,
  startPublishPip,
  stopLive,
  stopScreen,
  streamNameAtom,
  streamThumbsAtom,
  thumbStatusAtom,
  watchUrlAtom,
  liveViewersAtom
} from '@/infra/atoms/publish-atoms';
import { chatModalOpenAtom, chatSideAtom } from '@/infra/atoms/settings-atoms';
import { ChatOpenButton, ChatSlot, chatLayoutClass } from '@/shared-components/ChatSlot';
import { CAMERA_MAX_W, CAMERA_MIN_W, SCREEN_SLOTS } from '@/infra/relay';
import { store } from '@/infra/store';
import { Avatar } from '@/shared-components/Avatar';
import { Button } from '@/shared-components/Button';
import { CameraOverlay } from '@/shared-components/CameraOverlay';
import { ChatPanel } from '@/shared-components/ChatPanel';
import { MicMeter } from '@/shared-components/MicMeter';
import { PageFrame } from '@/shared-components/PageFrame';
import { panelClassName } from '@/shared-components/Panel';
import { StatusLine } from '@/shared-components/StatusLine';
import { ViewerCount } from '@/shared-components/ViewerCount';
import { StreamStatsButton } from '@/shared-components/StreamStats';
import { StreamTile } from '@/shared-components/StreamTile';
import { IconButton, PipIcon, revealClassName } from '@/shared-components/VideoControls';
import { VideoFrame } from '@/shared-components/VideoFrame';
import { cn } from '@/utils/cn';

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
  const layout = useAtomValue(layoutAtom);
  const overlaid = useAtomValue(cameraOverlaidAtom);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const thumbFileRef = useRef<HTMLInputElement | null>(null);

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
          chat, the bio box. left or right is a column at lg+ that eases shut when the chat
          closes; a window takes the chat out. */}
      <div className={chatLayoutClass(chatSide, chatOpen)}>
        <div className={cn('min-w-0', chatSide === 'left' && 'lg:col-start-2 lg:row-start-1')}>
          <div className="group relative">
            {/* what a watcher gets big: the camera, or the first shared screen with the camera over it where
                it was put. the camera is dragged around in here, and the watchers' players follow */}
            <VideoFrame id="preview" streamAtom={stageStreamAtom} videoRef={previewRef} muted />
            {overlaid && <CameraOverlay id="camera-overlay" streamAtom={cameraAtom} layout={layout} onMove={(x, y) => setLayout({ x, y })} />}
            {/* top left, while the stream is up: the mic, as loud as it is right now; beside it, once live, how
                the upload is going (up on its own while something limits it, otherwise on hover) */}
            {publishing && <MicMeter id="live-mic" streamAtom={cameraAtom} />}
            {(phase === 'live' || phase === 'reconnecting') && <StreamStatsButton id="live-stats" role="publish" stats={stats} className="left-[3.25rem] top-3" />}
            {/* while the chat is closed the bar stays up, so it can be opened again off the preview. once
                live, picture in picture beside it: the same button as the watch page's, for your own stream
                (here any way off the page keeps the stream; the button is the one that says so) */}
            <div className={cn('absolute inset-x-0 bottom-0 flex items-center gap-3 p-3', revealClassName(!chatOpen))}>
              <ChatOpenButton className="ml-auto" />
              {publishing && (
                <IconButton id="live-pip" label="picture in picture" onClick={toCorner}>
                  <PipIcon />
                </IconButton>
              )}
            </div>
          </div>
          {/* the screens being shared, each with its stop (the browser's own "stop sharing" bar works too),
              and the camera first while the layout keeps it beside the screen: a watcher's tiles */}
          {screens.length > 0 && (
            <div id="screens" className="mt-2 flex gap-2 overflow-x-auto">
              {!overlaid && <StreamTile id="camera-tile" streamAtom={cameraAtom} label="camera" />}
              {screens.map((screen) => (
                <StreamTile
                  key={screen.slot}
                  id={`screen-${screen.slot}`}
                  streamAtom={screenStreamAtom(screen.slot)}
                  label={screen.label}
                  corner={
                    <IconButton
                      id={`stop-screen-${screen.slot}`}
                      label="stop sharing"
                      tipAt="below-right"
                      onClick={() => stopScreen(screen.slot)}
                      className="text-lg leading-none"
                    >
                      ×
                    </IconButton>
                  }
                />
              ))}
            </div>
          )}
          {/* where the camera goes while a screen is shared: on the screen (drag it in the preview; this
              dial is its size) or beside it as a tile. kept for the next stream */}
          {screens.length > 0 && (
            <div id="layout" className="mt-2 flex flex-wrap items-center gap-3">
              <span className="text-textSecondary">camera</span>
              <Button
                id="camera-over"
                flat
                variant={overlaid ? 'primary' : 'secondary'}
                aria-pressed={overlaid}
                className="px-3 py-1.5 text-sm"
                onClick={() => setLayout({ camera: 'over' })}
              >
                on the screen
              </Button>
              <Button
                id="camera-beside"
                flat
                variant={overlaid ? 'secondary' : 'primary'}
                aria-pressed={!overlaid}
                className="px-3 py-1.5 text-sm"
                onClick={() => setLayout({ camera: 'beside' })}
              >
                beside it
              </Button>
              <label htmlFor="camera-size" className={cn('ml-2 text-textSecondary', !overlaid && 'opacity-40')}>
                size
              </label>
              <input
                id="camera-size"
                type="range"
                min={CAMERA_MIN_W}
                max={CAMERA_MAX_W}
                step={0.01}
                value={layout.w}
                disabled={!overlaid}
                title={`${Math.round(layout.w * 100)}% of the width`}
                onChange={(e) => setLayout({ w: e.target.valueAsNumber })}
                className="w-32 accent-primaryBlue disabled:opacity-40"
              />
            </div>
          )}
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
            {/* one screen (or window, or tab) per press, up to SCREEN_SLOTS at once. not on phones: no screen capture there */}
            {publishing && screenShareSupported && (
              <Button
                id="share-screen"
                flat
                disabled={!canShare}
                title={screens.length >= SCREEN_SLOTS ? `${SCREEN_SLOTS} screens at most` : undefined}
                onClick={() => void shareScreen()}
              >
                share screen
              </Button>
            )}
          </div>

          {watchUrl && (
            <p id="link" className="my-3 [overflow-wrap:anywhere]">
              watch link:{' '}
              <a id="watchurl" href={watchUrl} target="_blank" rel="noopener">
                {watchUrl}
              </a>{' '}
              <Button id="copy" flat className="ml-2 px-4 py-2" onClick={copyWatchUrl}>
                copy
              </Button>
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
            <label htmlFor="bio" className="text-textSecondary">
              your bio
            </label>
            <textarea
              id="bio"
              value={bioDraft}
              onChange={(e) => store.set(bioDraftAtom, e.target.value)}
              placeholder="who are you. what is this stream."
              maxLength={500}
              className="mt-2 min-h-[90px] w-full resize-y border border-primaryStroke bg-background px-4 py-3 text-textPrimary"
            />
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button id="savebio" flat onClick={() => void saveBio()}>
                save bio
              </Button>
              <span id="biostatus" className="text-textSecondary" aria-live="polite">
                {bioStatus}
              </span>
            </div>

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
              <Button id="avatar-pick" flat onClick={() => fileRef.current?.click()}>
                {avatar === null ? 'choose picture' : 'change picture'}
              </Button>
              {avatar !== null && (
                <Button id="avatar-remove" flat onClick={() => void removeAvatar()}>
                  remove
                </Button>
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
                      <Button id={`thumb-remove-${id}`} flat className="mt-2 w-full px-3 py-2 text-sm" onClick={() => void removeStreamThumb(id)}>
                        remove
                      </Button>
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
                <Button id="thumb-add" flat disabled={thumbs.length >= 6 || thumbStatus === 'saving'} onClick={() => thumbFileRef.current?.click()}>
                  add a thumbnail
                </Button>
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
