import { RiArrowLeftSLine, RiArrowRightSLine, RiLinkM } from '@remixicon/react';
import { atom, useAtomValue } from 'jotai';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { type ChatLine, chatRoomFor } from '@/infra/atoms/chat-atoms';
import {
  cameraAtom,
  chatRoomAtom,
  copyWatchUrl,
  enterLivePage,
  isPublishingAtom,
  leaveLivePage,
  liveDockTabAtom,
  livePanelsAtom,
  micLevelReader,
  mixerOpenAtom,
  modelAtom,
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
  reorderSource,
  resizeSource,
  sceneAtom,
  selectedSourceAtom,
  selectSource,
  sentStreamAtom,
  setLiveDockTab,
  setLivePanel,
  sourcesAtom,
  startCamera,
  startPublishPip,
  streamNameAtom,
  toggleSource,
  watchUrlAtom,
  liveViewersAtom
} from '@/infra/atoms/publish-atoms';
import { myAvatarVersionAtom, profileForAtom, profileWelcomeAtom } from '@/infra/atoms/profile-atoms';
import { chatModalOpenAtom } from '@/infra/atoms/settings-atoms';
import { usePinnedPage, useKeyboard, useTypingIn } from '@/infra/keyboard';
import { CHAT_BESIDE_MIN, CHAT_COLUMN, DOCK_PANELS, DOCK_WORDS, type DockTab, dockTabs, readDockTab, sideBySide, unreadAfter, unreadWords } from '@/infra/live-dock';
import { CHAT_MOBILE, keyboardStrip, useIsMobile } from '@/infra/mobile';
import { usePrefetchOnPointerDown } from '@/infra/prefetch';
import { KbdDebug } from '@/shared-components/KbdDebug';
import { ChatOpenButton, ChatSlot, useChatSide } from '@/shared-components/ChatSlot';
import { ChatModActions } from '@/shared-components/ChatMod';
import { ChatPanel } from '@/shared-components/ChatPanel';
import { Face } from '@/shared-components/Face';
import { DockPanel, DockTabs, FaceBody, FOLD_BUTTON, LiveControls, RigNone, SoundNone, ThumbnailsBody } from '@/shared-components/live/Dock';
import { MixerBody } from '@/shared-components/live/Mixer';
import { ModelDialog } from '@/shared-components/live/ModelDialog';
import { RigBody } from '@/shared-components/live/Rigging';
import { SourcesBody, StartStop } from '@/shared-components/live/Sources';
import { ModelLoading } from '@/shared-components/live/ModelLoading';
import { MicMeter } from '@/shared-components/MicMeter';
import { PageFrame } from '@/shared-components/PageFrame';
import { panelClassName } from '@/shared-components/Panel';
import { type SceneEdit, SceneView } from '@/shared-components/SceneView';
import { StatusLine } from '@/shared-components/StatusLine';
import { Tooltip } from '@/shared-components/Tooltip';
import { useFitWidth } from '@/shared-components/useFitWidth';
import { ViewerCount } from '@/shared-components/ViewerCount';
import { StreamStatsButton } from '@/shared-components/StreamStats';
import { ChatIcon, IconButton, PipIcon, revealClassName } from '@/shared-components/VideoControls';
import { cn } from '@/utils/cn';
import { streamNumbers } from '@/utils/count';
import { roveTabs } from '@/utils/tabs';

type PhoneTab = DockTab;
const PHONE_TABS: readonly PhoneTab[] = ['sources', 'face', 'rig', 'thumbnail', 'chat'];

const TAB_KEY = 'live-tab';

function keptTab(): PhoneTab {
  try {
    const kept = sessionStorage.getItem(TAB_KEY);
    return [...PHONE_TABS, 'sound' as const].find((t) => t === kept) ?? 'sources';
  } catch {
    return 'sources';
  }
}

function keepTab(tab: PhoneTab) {
  try {
    sessionStorage.setItem(TAB_KEY, tab);
  } catch {}
}

const CHAT_BESIDE_QUERY = `(min-width: ${CHAT_BESIDE_MIN}px)`;

function useChatBeside(): boolean {
  return useSyncExternalStore(
    (on) => {
      const query = window.matchMedia(CHAT_BESIDE_QUERY);
      query.addEventListener('change', on);
      return () => query.removeEventListener('change', on);
    },
    () => window.matchMedia(CHAT_BESIDE_QUERY).matches,
    () => true
  );
}

function useWideDock(on: boolean, chatColumn: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || !el) return;
    const read = () => setWide(sideBySide(el.getBoundingClientRect().width - chatColumn));
    read();
    const watcher = new ResizeObserver(read);
    watcher.observe(el);
    return () => watcher.disconnect();
  }, [on, chatColumn]);
  return [ref, on && wide] as const;
}

const noLinesAtom = atom<ChatLine[]>([]);
const noLoadAtom = atom(false);

function useUnread(name: string, shut: boolean): number {
  const room = name ? chatRoomFor(name) : null;
  const lines = useAtomValue(room?.linesAtom ?? noLinesAtom);
  const loaded = useAtomValue(room?.loadedAtom ?? noLoadAtom);
  const me = useAtomValue(meAtom);
  const [seen, setSeen] = useState<string | null>(null);
  if (!shut && seen !== null) setSeen(null);
  else if (shut && seen === null && (loaded || lines.length > 0)) setSeen(lines[lines.length - 1]?.id ?? '');
  return shut ? unreadAfter(lines, seen, me ?? null) : 0;
}

function Unread({ count, id }: { count: number; id?: string }) {
  if (count <= 0) return null;
  return (
    <span id={id} className="min-w-5 rounded-control bg-primaryBlue px-1 text-center text-xs font-semibold leading-5 text-background">
      <span className="sr-only">, unread: </span>
      {unreadWords(count)}
    </span>
  );
}

export function LivePage() {
  const navigate = useNavigate();
  const mobile = useIsMobile();
  usePinnedPage(mobile);
  const keyboard = useKeyboard().keyboard;
  const typing = useTypingIn('chat-text') && mobile;
  const strip = keyboardStrip(typing);
  const [tab, setTab] = useState<PhoneTab>(keptTab);
  const [picking, setPicking] = useState(false);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const message = useAtomValue(publishMessageAtom);
  const tone = useAtomValue(publishToneAtom);
  const name = useAtomValue(streamNameAtom);
  const chatRoom = useAtomValue(chatRoomAtom);
  const publishing = useAtomValue(isPublishingAtom);
  const phase = useAtomValue(publishPhaseAtom);
  const stats = useAtomValue(publishStatsAtom);
  const watchUrl = useAtomValue(watchUrlAtom);
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
  const model = useAtomValue(modelAtom);
  const panels = useAtomValue(livePanelsAtom);
  const storedTab = useAtomValue(liveDockTabAtom);
  const chatBeside = useChatBeside();
  const beside = !mobile && chatSide !== 'modal' && chatBeside;
  const chatTab = !mobile && chatSide !== 'modal' && !chatBeside;
  const [deskRef, wide] = useWideDock(!mobile, beside ? CHAT_COLUMN : 0);
  const tabbed = !wide;
  const tabs = dockTabs(chatTab);
  const dockTab = readDockTab(storedTab, tabs);
  const dockOpen = tabbed ? panels.dock : DOCK_PANELS.some((p) => panels[p]);
  const chatShut = mobile ? tab !== 'chat' : beside ? !panels.chat : chatTab ? !panels.dock || dockTab !== 'chat' : false;
  const unread = useUnread(chatRoom, chatShut && chatSide !== 'modal');
  const [fitCell, fitTail, fitWidth] = useFitWidth(!mobile);
  const openModel = () => setPicking(true);

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

  const openTab = (t: PhoneTab) => {
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
      {publishing && (
        <MicMeter
          key={mixerOpen ? 'mixer' : 'own'}
          id="live-mic"
          streamAtom={cameraAtom}
          read={mixerOpen ? micLevelReader : undefined}
          className={cn('left-3 top-3', mobile && strip.overlay)}
        />
      )}
      {(phase === 'live' || phase === 'reconnecting') && (
        <StreamStatsButton id="live-stats" role="publish" stats={stats} className={cn('left-[3.25rem] top-3', mobile && strip.overlay)} />
      )}
      <div
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-center gap-3 p-3 [&>*]:pointer-events-auto',
          revealClassName(mobile || !chatOpen),
          mobile && strip.overlay
        )}
      >
        {!mobile && chatSide === 'modal' ? <ChatOpenButton className="ml-auto" /> : <span className="ml-auto" />}
        {publishing && (
          <IconButton id="live-pip" label="picture in picture" {...homePress} onClick={toCorner}>
            <PipIcon />
          </IconButton>
        )}
      </div>
    </div>
  );

  const chat = (className: string, embedded = false, headerEnd?: ReactNode) =>
    chatRoom ? (
      <ChatPanel
        name={chatRoom}
        owner={owner}
        welcome={welcome}
        embedded={embedded}
        headerEnd={headerEnd}
        lineActions={me && me === chatRoom ? (line) => <ChatModActions name={chatRoom} line={line} me={me} /> : undefined}
        className={className}
      />
    ) : (
      <aside
        id="chat"
        className={cn('flex min-h-0 flex-1 items-center justify-center border border-dashed border-secondaryStroke p-6 text-center text-textTertiary', className)}
      >
        pick a name and the chat opens here. once you are live, your lines are marked.
      </aside>
    );

  const modelDialog = picking && <ModelDialog onClose={() => setPicking(false)} />;

  if (mobile) {
    const phoneTabs: readonly PhoneTab[] = publishing ? [...PHONE_TABS.slice(0, 4), 'sound', 'chat'] : PHONE_TABS;
    const shown = phoneTabs.includes(tab) ? tab : 'sources';
    const panel = (t: PhoneTab, children: ReactNode, className?: string) => (
      <div
        id={`live-panel-${t}`}
        role="tabpanel"
        aria-labelledby={`live-tab-${t}`}
        inert={shown !== t ? true : undefined}
        className={cn('absolute inset-0', shown !== t && 'invisible', className ?? 'overflow-y-auto overscroll-contain bg-backgroundSecondary pb-4')}
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
          mobileEnd={
            watchUrl ? (
              <Tooltip content="copy watch link">
                <button id="copy" type="button" aria-label="copy watch link" onClick={copyWatchUrl} className={cn(FOLD_BUTTON, 'h-11 w-11')}>
                  <RiLinkM aria-hidden size={20} />
                </button>
              </Tooltip>
            ) : null
          }
          wide
          bleed
          fill
        >
          <div className="shrink-0">{preview}</div>
          <div
            role="tablist"
            aria-label="go live"
            onKeyDown={roveTabs}
            className={cn('flex shrink-0 overflow-x-auto border-b border-primaryStroke', typing && 'hidden')}
          >
            {phoneTabs.map((t) => {
              const on = t === shown;
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
                    '-mb-px flex h-11 flex-auto items-center justify-center gap-1 whitespace-nowrap border-b-2 px-2 text-sm leading-tight transition-colors duration-150 focus-visible:text-primaryBlue focus-visible:outline-none',
                    on ? 'border-primaryBlue font-semibold text-textPrimary' : 'border-transparent text-textSecondary'
                  )}
                >
                  {DOCK_WORDS[t]}
                  {t === 'chat' && <Unread count={unread} />}
                </button>
              );
            })}
          </div>
          <div className="relative min-h-0 flex-1">
            {panel('chat', chat(cn('h-full min-h-0 flex-1', CHAT_MOBILE)), 'flex flex-col')}
            {panel('sources', <SourcesBody onModel={openModel} />)}
            {panel('face', <FaceBody onModel={openModel} />)}
            {panel('rig', model ? <RigBody /> : <RigNone />)}
            {panel('sound', publishing ? <MixerBody /> : <SoundNone />)}
            {panel('thumbnail', <ThumbnailsBody />)}
          </div>
          <div
            id="live-start-bar"
            className={cn(
              'flex shrink-0 items-center gap-3 border-t border-primaryStroke bg-background px-3 pb-[calc(0.625rem+env(safe-area-inset-bottom))] pt-2.5',
              typing && 'hidden'
            )}
          >
            <div className="min-w-0 flex-1">
              <StatusLine text={message} tone={tone} className="my-0 truncate text-sm leading-tight" />
              <ViewerCount id="viewers" count={viewers} className="text-xs text-textSecondary" />
            </div>
            <StartStop className="flex w-[62%] shrink-0 flex-col items-stretch gap-1 [&>button:first-child]:h-12 [&>button:first-child]:py-0" />
          </div>
        </PageFrame>
        {modelDialog}
        <KbdDebug typing={typing} />
      </div>
    );
  }

  const togglePanel = (p: DockTab) => {
    if (p !== 'chat') setLivePanel(p, !panels[p]);
  };
  const onDockTab = (t: DockTab) => {
    setLiveDockTab(t);
    if (!panels.dock) setLivePanel('dock', true);
  };
  const dockBody = (p: DockTab): ReactNode => {
    if (p === 'sources') return <SourcesBody onModel={openModel} split={tabbed} />;
    if (p === 'face') return <FaceBody onModel={openModel} />;
    if (p === 'rig') return model ? <RigBody dock /> : <RigNone />;
    if (p === 'thumbnail') return <ThumbnailsBody />;
    if (p === 'sound') return publishing ? <MixerBody /> : <SoundNone />;
    return chat('h-full min-h-0 flex-1', true);
  };
  const columns = beside
    ? chatSide === 'left'
      ? panels.chat
        ? 'grid-cols-[340px_minmax(0,1fr)]'
        : 'grid-cols-[36px_minmax(0,1fr)]'
      : panels.chat
        ? 'grid-cols-[minmax(0,1fr)_340px]'
        : 'grid-cols-[minmax(0,1fr)_36px]'
    : 'grid-cols-[minmax(0,1fr)]';
  const ChatFold = chatSide === 'left' ? RiArrowLeftSLine : RiArrowRightSLine;
  const ChatOpen = chatSide === 'left' ? RiArrowRightSLine : RiArrowLeftSLine;

  return (
    <PageFrame title="go live" wide fluid fill>
      <div
        ref={deskRef}
        id="live-desk"
        data-chat={beside ? 'beside' : chatTab ? 'tabbed' : undefined}
        data-dock={tabbed ? 'tabs' : 'side'}
        className={cn(
          'grid items-start gap-x-3 bubble:gap-x-2 motion-safe:transition-[grid-template-columns] motion-safe:duration-150 motion-safe:ease-out motion-reduce:transition-none',
          columns
        )}
      >
        <div className={cn('flex min-w-0 flex-col gap-3 bubble:gap-2', beside && chatSide === 'left' && 'col-start-2 row-start-1')}>
          <div ref={fitCell} className="min-w-0">
            <div id="live-preview" style={fitWidth ? { width: fitWidth } : undefined} className="mx-auto w-full">
              {preview}
            </div>
          </div>
          <div
            ref={fitTail}
            id="live-dock-row"
            className={cn(
              'grid gap-3 bubble:gap-2',
              dockOpen ? 'items-stretch' : 'items-start',
              dockOpen ? 'grid-cols-[minmax(0,1fr)_13.75rem]' : 'grid-cols-[minmax(0,1fr)_auto]'
            )}
          >
            <div
              id="live-dock"
              className={cn(
                'min-w-0',
                tabbed
                  ? panelClassName('flex flex-col overflow-hidden')
                  : 'grid grid-cols-[minmax(14rem,1.3fr)_minmax(11rem,1fr)_minmax(13rem,1.2fr)_minmax(10rem,1fr)_minmax(11rem,1fr)] items-start gap-3 bubble:gap-2'
              )}
            >
              {tabbed && (
                <DockTabs
                  tabs={tabs}
                  tab={dockTab}
                  open={panels.dock}
                  unread={<Unread id="live-chat-unread" count={unread} />}
                  onTab={onDockTab}
                  onToggle={() => setLivePanel('dock', !panels.dock)}
                />
              )}
              <div
                id="live-dock-panels"
                inert={tabbed && !panels.dock ? true : undefined}
                className={cn(
                  tabbed
                    ? cn(
                        'grid motion-safe:transition-[grid-template-rows] motion-safe:duration-150 motion-safe:ease-out motion-reduce:transition-none',
                        panels.dock ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                      )
                    : 'contents'
                )}
              >
                <div className={tabbed ? 'min-h-0 overflow-hidden' : 'contents'}>
                  {tabs.map((p) => (
                    <DockPanel key={p} tab={p} tabbed={tabbed} active={p === dockTab} open={p === 'chat' || panels[p]} onToggle={() => togglePanel(p)}>
                      {dockBody(p)}
                    </DockPanel>
                  ))}
                </div>
              </div>
            </div>
            <LiveControls compact={!dockOpen} />
          </div>
        </div>

        {beside ? (
          <div
            id="live-chat"
            data-open={panels.chat}
            className={cn(
              'relative min-w-0 overflow-hidden h-[calc(100dvh-var(--page-top,100px)-0.75rem)] bubble:h-[calc(100dvh-var(--page-top,100px)-0.5rem)]',
              chatSide === 'left' && 'col-start-1 row-start-1'
            )}
          >
            <div
              inert={!panels.chat ? true : undefined}
              className={cn('absolute inset-y-0 flex w-[340px] flex-col', chatSide === 'left' ? 'left-0' : 'right-0', !panels.chat && 'invisible')}
            >
              {chat(
                'h-full min-h-0 flex-1',
                false,
                <Tooltip content="fold the chat">
                  <button
                    id="live-chat-toggle"
                    type="button"
                    aria-label="fold the chat"
                    aria-expanded
                    aria-controls="live-chat"
                    onClick={() => setLivePanel('chat', false)}
                    className={cn(FOLD_BUTTON, '-my-1')}
                  >
                    <ChatFold aria-hidden size={16} />
                  </button>
                </Tooltip>
              )}
            </div>
            {!panels.chat && (
              <Tooltip content="open the chat" at={chatSide === 'left' ? 'right' : 'left'}>
                <button
                  id="live-chat-strip"
                  type="button"
                  aria-label={unread > 0 ? `open the chat, ${unread} unread` : 'open the chat'}
                  aria-expanded={false}
                  aria-controls="live-chat"
                  onClick={() => setLivePanel('chat', true)}
                  className={panelClassName(
                    'absolute inset-0 flex flex-col items-center gap-2 py-2 text-textSecondary transition-colors duration-150 hover:border-primaryBlue hover:text-primaryBlue focus-visible:border-primaryBlue focus-visible:text-primaryBlue focus-visible:outline-none'
                  )}
                >
                  <ChatOpen aria-hidden size={16} />
                  <ChatIcon />
                  <Unread count={unread} id="live-chat-unread" />
                </button>
              </Tooltip>
            )}
          </div>
        ) : (
          chatSide === 'modal' && <ChatSlot>{chat('h-full min-h-0 flex-1 border-0')}</ChatSlot>
        )}
      </div>
      {modelDialog}
    </PageFrame>
  );
}
