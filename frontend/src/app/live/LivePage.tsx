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
import { myAvatarVersionAtom, profileForAtom, profileWelcomeAtom } from '@/infra/atoms/profile-atoms';
import { chatModalOpenAtom } from '@/infra/atoms/settings-atoms';
import { usePinnedPage, useKeyboard, useTypingIn } from '@/infra/keyboard';
import { CHAT_MOBILE, keyboardStrip, useIsMobile } from '@/infra/mobile';
import { usePrefetchOnPointerDown } from '@/infra/prefetch';
import { KbdDebug } from '@/shared-components/KbdDebug';
import { ChatOpenButton, ChatSlot, chatLayoutClass, useChatSide } from '@/shared-components/ChatSlot';
import { ChatModActions } from '@/shared-components/ChatMod';
import { ChatPanel } from '@/shared-components/ChatPanel';
import { ExternalLink } from '@/shared-components/ExternalLink';
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

const LIVE_TABS = ['chat', 'about', 'sources', 'sound', 'thumbnails'] as const;
type LiveTab = (typeof LIVE_TABS)[number];

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
  }
}

export function LivePage() {
  const navigate = useNavigate();
  const mobile = useIsMobile();
  usePinnedPage(mobile);
  const keyboard = useKeyboard().keyboard;
  const typing = useTypingIn('chat-text') && mobile;
  const strip = keyboardStrip(typing);
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
  const profileFor = useAtomValue(profileForAtom);
  const profileWelcome = useAtomValue(profileWelcomeAtom);
  const welcome = profileFor === chatRoom ? profileWelcome : null;
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

  useEffect(() => {
    void startCamera();
    void enterLivePage();
    return leaveLivePage;
  }, []);

  const toCorner = () => {
    startPublishPip();
    navigate('/');
  };
  const homePress = usePrefetchOnPointerDown('/');

  const openTab = (t: LiveTab) => {
    setTab(t);
    keepTab(t);
  };

  const preview = (
    <div data-kbd-video={mobile || undefined} className={cn('group relative', mobile && strip.box)} style={mobile ? strip.style : undefined}>
      <SceneView
        id="scene"
        className={cn('max-md:border-t-0', mobile && strip.frame)}
        layers={scene.layers}
        streamFor={sentStreamAtom}
        imageUrl={(asset) => api.assetUrl(name, asset)}
        avatar={{ name, version: myAvatar, streamAtom: cameraAtom, read: mixerOpen ? micLevelReader : undefined }}
        main={{ id: 'preview', streamAtom: previewStreamAtom, videoRef: previewRef, slot: previewSlot, muted: true }}
        edit={edit}
      />
      <ModelLoading />
      {publishing && <MicMeter key={mixerOpen ? 'mixer' : 'own'} id="live-mic" streamAtom={cameraAtom} read={mixerOpen ? micLevelReader : undefined} className={cn('left-3 top-3', mobile && strip.overlay)} />}
      {(phase === 'live' || phase === 'reconnecting') && <StreamStatsButton id="live-stats" role="publish" stats={stats} className={cn('left-[3.25rem] top-3', mobile && strip.overlay)} />}
      <div className={cn('pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-center gap-3 p-3 [&>*]:pointer-events-auto', revealClassName(mobile || !chatOpen), mobile && strip.overlay)}>
        {mobile ? <span className="ml-auto" /> : <ChatOpenButton className="ml-auto" />}
        {publishing && (
          <IconButton id="live-pip" label="picture in picture" {...homePress} onClick={toCorner}>
            <PipIcon />
          </IconButton>
        )}
      </div>
    </div>
  );

  const link = watchUrl && (
    <p id="link" className="my-3 [overflow-wrap:anywhere]">
      watch link:{' '}
      <ExternalLink id="watchurl" href={watchUrl}>
        {watchUrl}
      </ExternalLink>{' '}
      <button id="copy" type="button" className="ml-2 text-base font-semibold text-primaryBlue" onClick={copyWatchUrl}>
        copy
      </button>
    </p>
  );

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

  const chat = (className: string) =>
    chatRoom ? (
      <ChatPanel
        name={chatRoom}
        owner={owner}
        welcome={welcome}
        lineActions={me && me === chatRoom ? (line) => <ChatModActions name={chatRoom} line={line} me={me} /> : undefined}
        className={className}
      />
    ) : (
      <aside
        id="chat"
        className="flex h-full min-h-[200px] flex-1 items-center justify-center border border-dashed border-secondaryStroke p-6 text-center text-textTertiary"
      >
        pick a name and the chat opens here. once you are live, your lines are marked.
      </aside>
    );

  if (mobile) {
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
        data-keyboard={typing || keyboard}
        className="group/phone fixed inset-x-0 top-[var(--vvt,0px)] flex h-[var(--vvh,100dvh)] flex-col overflow-hidden bg-background pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
      >
        <PageFrame
          title="go live"
          mobileTitle={name || 'go live'}
          mobileStart={me ? <Face name={me} version={myAvatar} className="h-8 w-8 text-sm" /> : undefined}
          mobileSub={streamNumbers(null, viewers)}
          mobileEnd={null}
          wide
          bleed
          fill
        >
          <div className="shrink-0">{preview}</div>
          <div className={cn('flex shrink-0 items-center gap-3 border-b border-primaryStroke px-4 py-2', typing && 'hidden')}>
            <div className="min-w-0 flex-1">
              <StatusLine text={message} tone={tone} className="my-0 truncate text-lg leading-tight" />
              <ViewerCount id="viewers" count={viewers} className="text-sm text-textSecondary" />
            </div>
            <StartStop className="flex w-32 shrink-0 flex-col items-stretch gap-1 [&>button:first-child]:h-11 [&>button:first-child]:py-0" />
          </div>
          <div role="tablist" aria-label="go live" onKeyDown={roveTabs} className={cn('flex shrink-0 border-b border-primaryStroke', typing && 'hidden')}>
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
                <Rigging />
              </>
            )}
            {panel('sound', publishing ? <div className="[&>section]:mt-0"><Mixer /></div> :<p className="text-textTertiary">the sound, a fader for the mic and for the mix that goes out, is here once you are live.</p>)}
            {panel('thumbnails', thumbnails)}
          </div>
        </PageFrame>
        <KbdDebug typing={typing} />
      </div>
    );
  }

  return (
    <PageFrame title="go live" wide>
      <div className={chatLayoutClass(chatSide, chatOpen)}>
        <div className={cn('min-w-0', chatSide === 'left' && 'lg:col-start-2 lg:row-start-1')}>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
            <Sources />
            <div className="min-w-0 flex-1">
              {preview}
              <Rigging />
              {publishing && <Mixer />}
            </div>
          </div>

          {link}
        </div>

        <ChatSlot>{chat(cn('h-full min-h-0 flex-1', chatSide === 'modal' && 'border-0'))}</ChatSlot>

        <div className={cn('min-w-0', chatSide === 'right' && 'lg:col-start-1', chatSide === 'left' && 'lg:col-start-2 lg:row-start-2')}>{thumbnails}</div>
      </div>
    </PageFrame>
  );
}
