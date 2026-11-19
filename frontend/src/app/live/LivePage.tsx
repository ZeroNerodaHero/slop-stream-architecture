import { useAtomValue } from 'jotai';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
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
  selectedSourceAtom,
  selectSource,
  sentStreamAtom,
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
import { myAvatarVersionAtom } from '@/infra/atoms/profile-atoms';
import { chatModalOpenAtom } from '@/infra/atoms/settings-atoms';
import { CHAT_MOBILE, useIsMobile, useKeyboardStrip, useLockedDocument, useVisibleViewport } from '@/infra/mobile';
import { ChatOpenButton, ChatSlot, chatLayoutClass, useChatSide } from '@/shared-components/ChatSlot';
import { ChatPanel } from '@/shared-components/ChatPanel';
import { Face } from '@/shared-components/Face';
import { Mixer } from '@/shared-components/live/Mixer';
import { Rigging } from '@/shared-components/live/Rigging';
import { Sources, StartStop } from '@/shared-components/live/Sources';
import { ModelLoading } from '@/shared-components/live/ModelLoading';
import { MicMeter } from '@/shared-components/MicMeter';
import { PageFrame } from '@/shared-components/PageFrame';
import { panelClassName } from '@/shared-components/Panel';
import { type SceneEdit, SceneView } from '@/shared-components/SceneView';
import { StatusLine } from '@/shared-components/StatusLine';
import { ViewerCount } from '@/shared-components/ViewerCount';
import { StreamStatsButton } from '@/shared-components/StreamStats';
import { IconButton, PipIcon, revealClassName } from '@/shared-components/VideoControls';
import { cn } from '@/utils/cn';
import { streamNumbers } from '@/utils/count';
import { roveTabs } from '@/utils/tabs';

/** A phone's tabs under the preview, in the bar's order. Chat first: it is where a phone's page opens. */
const LIVE_TABS = ['chat', 'about', 'sources', 'sound', 'thumbnails'] as const;
type LiveTab = (typeof LIVE_TABS)[number];

/** The tab open last, for this browser tab: back on the page, it is open again. */
const TAB_KEY = 'live-tab';

function keptTab(): LiveTab {
  try {
    const kept = sessionStorage.getItem(TAB_KEY);
    return LIVE_TABS.find((t) => t === kept) ?? 'chat';
  } catch {
    return 'chat';
  }
}

function keepTab(tab: LiveTab) {
  try {
    sessionStorage.setItem(TAB_KEY, tab);
  } catch {
    // private mode: the tab is just not kept
  }
}

export function LivePage() {
  const navigate = useNavigate();
  const mobile = useIsMobile();
  // the visual viewport (mobile.ts): the page is what the keyboard leaves, panned with it
  const view = useVisibleViewport(mobile, true);
  useLockedDocument(mobile);
  // a phone's preview is a strip while the keyboard is up, so the chat has the room
  const strip = useKeyboardStrip(view?.keyboard ?? false);
  const [tab, setTab] = useState<LiveTab>(keptTab);
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
  const chatSide = useChatSide();
  const chatOpen = useAtomValue(chatModalOpenAtom);
  const scene = useAtomValue(sceneAtom);
  const sources = useAtomValue(sourcesAtom);
  const previewSlot = useAtomValue(previewSlotAtom);
  const selected = useAtomValue(selectedSourceAtom);
  const mixerOpen = useAtomValue(mixerOpenAtom);
  const myAvatar = useAtomValue(myAvatarVersionAtom);
  const me = useAtomValue(meAtom);
  const thumbFileRef = useRef<HTMLInputElement | null>(null);

  // the editor's hooks on the preview: a drag, a corner, the keys. delete takes a picture or the
  // avatar out and puts a video source beside (a key must not stop a share, or turn the camera
  // off); the brackets move through the stack
  const edit: SceneEdit = {
    selectedId: selected,
    onSelect: selectSource,
    onMove: moveSource,
    onResize: resizeSource,
    onNudge: nudgeSource,
    onKey: (id, what) => {
      if (what === 'remove') {
        const kind = sources.find((s) => s.id === id)?.kind;
        if (kind === 'image' || kind === 'avatar') removeSource(id);
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

  const openTab = (t: LiveTab) => {
    setTab(t);
    keepTab(t);
  };

  // the preview, as the desktop and the phone both have it. a phone has no chat button on it:
  // the chat is a tab there, never closed
  const preview = (
    <div ref={mobile ? strip.ref : undefined} className={cn('group relative', mobile && strip.box)} style={mobile ? strip.style : undefined}>
      {/* the frame as every watcher gets it (docs/screen.md): the sources on the stream, laid out
          in fractions. taken hold of here; the watchers' players follow within a beat */}
      <SceneView
        id="scene"
        // a phone's preview sits right on the row's own stroke: no second line between them. scaled into the strip while typing
        className={cn('max-md:border-t-0', mobile && strip.frame)}
        layers={scene.layers}
        streamFor={sentStreamAtom}
        imageUrl={(asset) => api.assetUrl(name, asset)}
        // the avatar moves with the mic: the mixer's own reading once that is up (the layer rebinds on that, the way the mic chip does)
        avatar={{ name, version: myAvatar, streamAtom: cameraAtom, read: mixerOpen ? micLevelReader : undefined }}
        main={{ id: 'preview', streamAtom: previewStreamAtom, videoRef: previewRef, slot: previewSlot, muted: true }}
        edit={edit}
      />
      {/* a model on its way on (docs/vtuber.md): its picture and how far along it is, where the model will be */}
      <ModelLoading />
      {/* top left, while the stream is up: the mic, as loud as it is right now, read off the mixer once
          that is up (the key: a chip mounted before it opens would otherwise keep its own reader);
          beside it, once live, how the upload is going (up on its own while something limits it) */}
      {publishing && <MicMeter key={mixerOpen ? 'mixer' : 'own'} id="live-mic" streamAtom={cameraAtom} read={mixerOpen ? micLevelReader : undefined} />}
      {(phase === 'live' || phase === 'reconnecting') && <StreamStatsButton id="live-stats" role="publish" stats={stats} className="left-[3.25rem] top-3" />}
      {/* while the chat is closed the bar stays up, so it can be opened again off the preview. once
          live, picture in picture beside it: the same button as the watch page's, for your own stream
          (here any way off the page keeps the stream; the button is the one that says so). the bar
          itself takes no presses, only its buttons do: it lies across the bottom of the frame, where a
          layer in a corner is taken hold of */}
      <div className={cn('pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-center gap-3 p-3 [&>*]:pointer-events-auto', revealClassName(mobile || !chatOpen))}>
        {mobile ? <span className="ml-auto" /> : <ChatOpenButton className="ml-auto" />}
        {publishing && (
          <IconButton id="live-pip" label="picture in picture" onClick={toCorner}>
            <PipIcon />
          </IconButton>
        )}
      </div>
    </div>
  );

  const link = watchUrl && (
    <p id="link" className="my-3 [overflow-wrap:anywhere]">
      watch link:{' '}
      <a id="watchurl" href={watchUrl} target="_blank" rel="noopener">
        {watchUrl}
      </a>{' '}
      <button id="copy" type="button" className="ml-2 text-base font-semibold text-primaryBlue" onClick={copyWatchUrl}>
        copy
      </button>
    </p>
  );

  // pictures for the card on home. none, and that card shows the camera. the status and the picture are
  // not here: the profile tab (the user modal) is where they are set
  const thumbnails = (
    <section className={panelClassName(mobile ? 'px-4 py-4' : 'my-5 px-5 py-4')}>
      <p className="text-textSecondary">thumbnails</p>
      <p className="mt-1 text-sm text-textSecondary">one picture on your card on home, until that page is refreshed. with none, home shows one frame of the camera.</p>
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
  );

  // the streamer's own chat, in the room of the settled name. once live, `owner` makes its lines marked
  const chat = (className: string) =>
    chatRoom ? (
      <ChatPanel name={chatRoom} owner={owner} className={className} />
    ) : (
      <aside
        id="chat"
        className="flex h-full min-h-[200px] flex-1 items-center justify-center border border-dashed border-secondaryStroke p-6 text-center text-textTertiary"
      >
        pick a name and the chat opens here. once you are live, your lines are marked.
      </aside>
    );

  if (mobile) {
    // a phone's page is the window and never scrolls: the row, the preview pinned under it, start
    // or stop with the status beside it, the tabs, and the open tab in what is left. only a tab's
    // own content scrolls. every tab stays mounted, hidden while another is open, so the chat
    // keeps its place and the line being typed. the box follows the visual viewport, so the send
    // row stays over the keyboard
    const panel = (t: LiveTab, children: ReactNode, className?: string) => (
      <div
        id={`live-panel-${t}`}
        role="tabpanel"
        aria-labelledby={`live-tab-${t}`}
        inert={tab !== t ? true : undefined}
        className={cn('absolute inset-0', tab !== t && 'invisible', className ?? 'overflow-y-auto overscroll-contain px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4')}
      >
        {children}
      </div>
    );
    return (
      <div
        id="live-mobile"
        data-keyboard={view?.keyboard ?? false}
        className="group/phone fixed inset-x-0 top-0 flex h-[100dvh] flex-col overflow-hidden bg-background pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
        style={view ? { height: view.height, transform: view.top ? `translateY(${view.top}px)` : undefined } : undefined}
      >
        <PageFrame
          title="go live"
          mobileTitle={name || 'go live'}
          // who is going live, beside the menu: your picture (or the letter your name makes). a picture, not a control
          mobileStart={me ? <Face name={me} version={myAvatar} className="h-8 w-8 text-sm" /> : undefined}
          // under the name, how many watch (this page has no count of followers). no follow button: it is your own
          // stream, so home takes the row's right end
          mobileSub={streamNumbers(null, viewers)}
          mobileEnd={null}
          wide
          bleed
          fill
        >
          <div className="shrink-0">{preview}</div>
          {/* the stream's state and the press that changes it, always in sight. not while typing: the keyboard has that room */}
          <div className={cn('flex shrink-0 items-center gap-3 border-b border-primaryStroke px-4 py-2', view?.keyboard && 'hidden')}>
            <div className="min-w-0 flex-1">
              <StatusLine text={message} tone={tone} className="my-0 truncate text-lg leading-tight" />
              <ViewerCount id="viewers" count={viewers} className="text-sm text-textSecondary" />
            </div>
            <StartStop className="flex w-32 shrink-0 flex-col items-stretch gap-1 [&>button:first-child]:h-11 [&>button:first-child]:py-0" />
          </div>
          <div role="tablist" aria-label="go live" onKeyDown={roveTabs} className="flex shrink-0 border-b border-primaryStroke">
            {LIVE_TABS.map((t) => {
              const on = t === tab;
              return (
                <button
                  key={t}
                  id={`live-tab-${t}`}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  aria-controls={`live-panel-${t}`}
                  tabIndex={on ? 0 : -1}
                  onClick={() => openTab(t)}
                  className={cn(
                    '-mb-px h-11 flex-auto whitespace-nowrap border-b-2 px-2 text-sm font-semibold leading-tight transition-colors duration-150 focus-visible:outline-none focus-visible:text-primaryBlue',
                    on ? 'border-primaryBlue bg-backgroundTertiary text-textPrimary' : 'border-transparent text-textSecondary'
                  )}
                >
                  {t}
                </button>
              );
            })}
          </div>
          <div className="relative min-h-0 flex-1">
            {panel('chat', chat(cn('h-full min-h-0 flex-1', CHAT_MOBILE)), 'flex flex-col')}
            {panel(
              'about',
              <>
                <p className="text-textSecondary">
                  {publishing ? 'you are live. the link is where anyone watches.' : 'press start and you are live. the link is where anyone watches.'}
                </p>
                {link || <p className="my-3 text-textTertiary">the watch link is here once your name is picked.</p>}
              </>
            )}
            {panel(
              'sources',
              <>
                <Sources startStop={false} />
                {/* what the face reader sees of the streamer, while a model is on (docs/vtuber.md) */}
                <Rigging />
              </>
            )}
            {/* the mixer's own top margin is for under the preview; the tab's padding is that here */}
            {panel('sound', publishing ? <div className="[&>section]:mt-0"><Mixer /></div> :<p className="text-textTertiary">the sound, a fader for the mic and for the mix that goes out, is here once you are live.</p>)}
            {panel('thumbnails', thumbnails)}
          </div>
        </PageFrame>
      </div>
    );
  }

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
              {preview}
              {/* under the picture that is sent, while a model is on: what the face reader sees of the streamer, on this page only (docs/vtuber.md) */}
              <Rigging />
              {publishing && <Mixer />}
            </div>
          </div>
          {/* the stream's status and who is watching are at the foot of the sources panel, under stop (Sources.tsx) */}

          {link}
        </div>

        <ChatSlot>{chat(cn('h-full min-h-0 flex-1', chatSide === 'modal' && 'border-0'))}</ChatSlot>

        <div className={cn('min-w-0', chatSide === 'right' && 'lg:col-start-1', chatSide === 'left' && 'lg:col-start-2 lg:row-start-2')}>{thumbnails}</div>
      </div>
    </PageFrame>
  );
}
