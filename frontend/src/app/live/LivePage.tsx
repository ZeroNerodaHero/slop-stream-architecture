import { RiAddLine, RiDraggable, RiLinkM } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import {
  type CSSProperties,
  lazy,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';

import { api } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import {
  cameraAtom,
  chatRoomAtom,
  copyWatchUrl,
  enterLivePage,
  isPublishingAtom,
  leaveLivePage,
  liveViewersAtom,
  micLevelReader,
  mixerOpenAtom,
  moveSource,
  nudgeSource,
  previewSlotAtom,
  previewStreamAtom,
  publishPhaseAtom,
  publishStatsAtom,
  removeSource,
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
  toggleSource,
  watchUrlAtom
} from '@/infra/atoms/publish-atoms';
import { myAvatarVersionAtom } from '@/infra/atoms/profile-atoms';
import { chatModalOpenAtom } from '@/infra/atoms/settings-atoms';
import { usePinnedPage, useKeyboard, useTypingIn } from '@/infra/keyboard';
import {
  applyPreset,
  arrange,
  type Cell,
  clampCell,
  DOCK_WORDS,
  fits,
  GRID_COLS,
  GRID_ROWS,
  type Grid,
  liveEditingAtom,
  liveGridAtom,
  liveLayoutAtom,
  livePanelsAtom,
  livePresetAtom,
  liveRailAtom,
  MODULE_IDS,
  type ModuleId,
  type Place,
  placeIn,
  PRESET_WORDS,
  presetForKey,
  railOpen,
  resetGrid,
  saveMine,
  setGrid,
  setLivePanel,
  setRail,
  showInGrid,
  stopEditing,
  TILE_IDS,
  type TileId,
  typingInto
} from '@/infra/live-dock';
import { CHAT_MOBILE, keyboardStrip, useIsMobile } from '@/infra/mobile';
import { usePrefetchOnPointerDown } from '@/infra/prefetch';
import { inTauri } from '@/infra/update-check';
import { Button } from '@/shared-components/Button';
import { ChatOpenButton, useChatSide } from '@/shared-components/ChatSlot';
import { Face } from '@/shared-components/Face';
import { KbdDebug } from '@/shared-components/KbdDebug';
import { Collapsible } from '@/shared-components/live/Collapsible';
import { FOLD_BUTTON, ModuleBoundary } from '@/shared-components/live/Dock';
import { ModelDialog } from '@/shared-components/live/ModelDialog';
import { ModelLoading } from '@/shared-components/live/ModelLoading';
import { ChatModule, ChatWindow, Unread, useUnread } from '@/shared-components/live/modules/Chat';
import { FaceModule } from '@/shared-components/live/modules/Face';
import { LayoutModule } from '@/shared-components/live/modules/LayoutSwitcher';
import { PRESET_ICONS, PresetsModule } from '@/shared-components/live/modules/Presets';
import { RigModule } from '@/shared-components/live/modules/Rigging';
import { SoundModule } from '@/shared-components/live/modules/Sound';
import { SourcesModule } from '@/shared-components/live/modules/Sources';
import { StartStop, StudioModule } from '@/shared-components/live/modules/Studio';
import { ThumbnailModule } from '@/shared-components/live/modules/Thumbnail';
import { MicMeter } from '@/shared-components/MicMeter';
import { PageFrame } from '@/shared-components/PageFrame';
import { type SceneEdit, SceneView } from '@/shared-components/SceneView';
import { StreamStatsButton } from '@/shared-components/StreamStats';
import { DrawerClose, SwipeDrawer } from '@/shared-components/SwipeDrawer';
import { Tooltip } from '@/shared-components/Tooltip';
import { IconButton, PipIcon, revealClassName } from '@/shared-components/VideoControls';
import { cn } from '@/utils/cn';
import { streamNumbers } from '@/utils/count';
import { roveTabs } from '@/utils/tabs';

type PhoneTab = ModuleId;
const PHONE_TABS: readonly PhoneTab[] = ['sources', 'face', 'rig', 'sound', 'chat'];
const PHONE_WORDS: Record<PhoneTab, string> = { sources: 'sources', face: 'face', rig: 'rig', sound: 'sound', chat: 'chat' };

const TAB_KEY = 'live-tab';
const DESKTOP = inTauri();
const ScreenPicker = lazy(() => import('@/shared-components/live/ScreenPicker').then((m) => ({ default: m.ScreenPicker })));

function keptTab(): PhoneTab {
  try {
    const kept = sessionStorage.getItem(TAB_KEY);
    return PHONE_TABS.find((t) => t === kept) ?? 'sources';
  } catch {
    return 'sources';
  }
}

function keepTab(tab: PhoneTab) {
  try {
    sessionStorage.setItem(TAB_KEY, tab);
  } catch {}
}

const subscribeWidth = (on: () => void) => {
  window.addEventListener('resize', on);
  return () => window.removeEventListener('resize', on);
};

function useWindowWidth(): number {
  return useSyncExternalStore(
    subscribeWidth,
    () => window.innerWidth,
    () => 1366
  );
}

function useWidthOf(on: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || !el) return;
    const read = () => setWidth(Math.round(el.getBoundingClientRect().width));
    read();
    const watcher = new ResizeObserver(read);
    watcher.observe(el);
    return () => watcher.disconnect();
  }, [on]);
  return [ref, width] as const;
}

function usePresetKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (typingInto(e.target) || typingInto(document.activeElement)) return;
      if (document.querySelector('dialog:modal')) return;
      const id = presetForKey(e.key);
      if (!id) return;
      e.preventDefault();
      applyPreset(id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

type Hosts = Record<TileId, HTMLDivElement>;

function useHosts(): Hosts {
  const [hosts] = useState(() => {
    const made = {} as Hosts;
    for (const id of TILE_IDS) {
      const el = document.createElement('div');
      el.className = 'contents';
      el.dataset.host = id;
      made[id] = el;
    }
    return made;
  });
  return hosts;
}

interface SlotProps {
  hosts: Hosts;
  ids: readonly TileId[];
  id?: string;
  className?: string;
  style?: CSSProperties;
}

function Slot({ hosts, ids, id, className, style }: SlotProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    ids.forEach((t, i) => {
      const host = hosts[t];
      if (el.children[i] !== host) el.insertBefore(host, el.children[i] ?? null);
    });
  });
  return <div ref={ref} id={id} data-slot={ids.join(' ')} className={className} style={style} />;
}

const ROW_TALL = '15.5rem';
const ROW_LOW = '11rem';
const WIDE_CELL = 360;
const RAIL_PX = 244;
const STRIP_PX = 40;
const CHAT_PX = 340;
const GAP_PX = 8;
const CENTER_MIN = 720;
const CENTER_ALONE_MIN = 480;
const BAR_H = '2.375rem';
const UNDER_MIN = '12rem';
const GAP = '0.5rem';

function reserveFor(below: boolean, belowOpen: boolean, rowH: string, under: boolean, underOpen: boolean): string {
  const parts: string[] = [];
  if (below) parts.push(belowOpen ? rowH : BAR_H, GAP);
  if (under) parts.push(underOpen ? UNDER_MIN : BAR_H, GAP);
  return parts.length ? parts.join(' + ') : '0px';
}

interface Drag {
  id: TileId;
  kind: 'move' | 'size';
  from: Cell;
  x: number;
  y: number;
  pointer: number;
}

function EditBar({ hidden, onAdd }: { hidden: ModuleId[]; onAdd: (id: ModuleId) => void }) {
  return (
    <div
      id="live-edit-bar"
      role="toolbar"
      aria-label="edit layout"
      className="flex h-10 shrink-0 items-center gap-2 rounded-panel border border-primaryBlue/70 bg-backgroundSecondary px-2"
    >
      <span className="shrink-0 px-1 text-sm font-semibold text-primaryBlue">edit layout</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {hidden.map((id) => (
          <Button key={id} id={`live-edit-add-${id}`} size="sm" className="h-7 shrink-0 gap-1 px-2.5 py-0 text-xs" onClick={() => onAdd(id)}>
            <RiAddLine aria-hidden size={14} />
            {DOCK_WORDS[id]}
          </Button>
        ))}
      </div>
      <Button id="live-edit-reset" size="sm" className="h-7 shrink-0 px-2.5 py-0 text-xs" onClick={resetGrid}>
        reset
      </Button>
      <Tooltip content="keep this grid and these folds as yours">
        <Button id="live-edit-save" size="sm" className="h-7 shrink-0 px-2.5 py-0 text-xs" onClick={saveMine}>
          save as preset
        </Button>
      </Tooltip>
      <Button id="live-edit-done" size="sm" variant="primary" className="h-7 shrink-0 px-3 py-0 text-xs" onClick={stopEditing}>
        done
      </Button>
    </div>
  );
}

function GridStage({ hosts, shown, editing }: { hosts: Hosts; shown: TileId[]; editing: boolean }) {
  const grid = useAtomValue(liveGridAtom);
  const panels = useAtomValue(livePanelsAtom);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [draft, setDraft] = useState<Cell | null>(null);
  const [note, setNote] = useState('');
  const cellOf = (id: TileId) => (drag?.id === id && draft ? draft : grid[id]);
  const bad = drag !== null && draft !== null && !fits(grid, shown, drag.id, draft);

  const unit = () => {
    const el = gridRef.current;
    if (!el) return { w: 1, h: 1 };
    const r = el.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
    return { w: (r.width + gap) / GRID_COLS, h: (r.height + gap) / GRID_ROWS };
  };

  const commit = (id: TileId, cell: Cell) => {
    if (!fits(grid, shown, id, cell)) {
      setNote(`no room there for the ${DOCK_WORDS[id]}: it went back`);
      return false;
    }
    setNote('');
    setGrid({ ...grid, [id]: cell } as Grid);
    return true;
  };

  const down = (e: PointerEvent) => {
    if (!editing || e.button !== 0 || drag) return;
    const target = e.target as Element;
    const grip = target.closest<HTMLElement>('[data-grip]');
    const size = target.closest<HTMLElement>('[data-size]');
    const id = (grip?.dataset.grip ?? size?.dataset.size) as TileId | undefined;
    if (!id) return;
    e.preventDefault();
    gridRef.current?.setPointerCapture(e.pointerId);
    setDrag({ id, kind: grip ? 'move' : 'size', from: grid[id], x: e.clientX, y: e.clientY, pointer: e.pointerId });
    setDraft(grid[id]);
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    const u = unit();
    const dx = (e.clientX - drag.x) / u.w;
    const dy = (e.clientY - drag.y) / u.h;
    const f = drag.from;
    setDraft(clampCell(drag.id, drag.kind === 'move' ? { ...f, x: f.x + dx, y: f.y + dy } : { ...f, w: f.w + dx, h: f.h + dy }));
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    if (draft) commit(drag.id, draft);
    setDrag(null);
    setDraft(null);
  };
  const key = (e: KeyboardEvent) => {
    if (!editing) return;
    const grip = (e.target as Element).closest<HTMLElement>('[data-grip]');
    const id = grip?.dataset.grip as TileId | undefined;
    const steps: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const step = steps[e.key];
    if (!id || !step) return;
    e.preventDefault();
    const c = grid[id];
    commit(id, clampCell(id, e.shiftKey ? { ...c, w: c.w + step[0], h: c.h + step[1] } : { ...c, x: c.x + step[0], y: c.y + step[1] }));
  };

  const handlers = useRef({ down, key });
  useLayoutEffect(() => {
    handlers.current = { down, key };
  });
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const onDown = (e: PointerEvent) => handlers.current.down(e);
    const onKey = (e: KeyboardEvent) => handlers.current.key(e);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('keydown', onKey);
    };
  }, []);

  const order = drag ? [...shown.filter((t) => t !== drag.id), drag.id] : shown;
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      {editing && (
        <EditBar
          hidden={MODULE_IDS.filter((id) => panels.hidden.includes(id))}
          onAdd={(id) => !showInGrid(id) && setNote(`no room for the ${DOCK_WORDS[id]}: make a panel smaller first`)}
        />
      )}
      <div
        ref={gridRef}
        id="live-grid"
        data-editing={editing || undefined}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        className={cn('grid min-h-0 flex-1 gap-2', drag && 'select-none')}
        style={{ gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${GRID_ROWS}, minmax(0, 1fr))` }}
      >
        {order.map((id) => {
          const c = cellOf(id);
          const held = drag?.id === id;
          return (
            <div
              key={id}
              data-tile={id}
              data-held={held || undefined}
              className={cn('relative flex min-h-0 min-w-0 flex-col', held && (bad ? 'opacity-60' : 'opacity-90'))}
              style={{ gridColumn: `${c.x + 1} / span ${c.w}`, gridRow: `${c.y + 1} / span ${c.h}` }}
            >
              {id === 'preview' ? (
                <div
                  className={cn(
                    'flex min-h-0 flex-1 flex-col overflow-hidden',
                    editing && 'rounded-panel border border-dashed border-primaryBlue/70 bg-backgroundSecondary'
                  )}
                >
                  {editing && (
                    <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-primaryStroke pl-1 pr-1 text-xs font-semibold uppercase tracking-wider text-textSecondary">
                      <Tooltip content="drag to move. arrows move it, shift and arrows size it">
                        <button
                          id="live-preview-grip"
                          type="button"
                          data-grip="preview"
                          aria-label="move preview"
                          aria-roledescription="drag handle"
                          className="flex h-7 w-5 cursor-grab touch-none items-center justify-center text-textTertiary hover:text-textPrimary focus-visible:text-primaryBlue focus-visible:outline-none active:cursor-grabbing"
                        >
                          <RiDraggable aria-hidden size={16} />
                        </button>
                      </Tooltip>
                      preview
                    </div>
                  )}
                  <div className={cn('flex min-h-0 flex-1 items-center justify-center [container-type:size]', editing && 'p-2')}>
                    <Slot hosts={hosts} ids={['preview']} id="live-preview" className="shrink-0" style={{ width: 'min(100cqw, calc(100cqh * 16 / 9))' }} />
                  </div>
                </div>
              ) : (
                <Slot hosts={hosts} ids={[id]} className="flex min-h-0 flex-1 flex-col" />
              )}
              {editing && (
                <Tooltip content="drag to size">
                  <span
                    data-size={id}
                    aria-hidden
                    className="absolute bottom-0.5 right-0.5 h-3.5 w-3.5 cursor-nwse-resize touch-none border-b-2 border-r-2 border-primaryBlue"
                  />
                </Tooltip>
              )}
            </div>
          );
        })}
      </div>
      <p id="live-grid-note" aria-live="polite" className={cn('text-xs text-caution', !note && 'sr-only')}>
        {note}
      </p>
    </div>
  );
}

function Rail({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <Collapsible
      id="live-rail"
      title="studio"
      sideways
      open={open}
      onToggle={onToggle}
      className="w-[15.25rem] shrink-0"
      strip={
        <>
          <ModuleBoundary id="studio" name="studio" small>
            <StudioModule strip />
          </ModuleBoundary>
          <ModuleBoundary id="layout" name="layout switcher" small>
            <LayoutModule strip />
          </ModuleBoundary>
          <ModuleBoundary id="presets" name="presets" small>
            <PresetsModule strip />
          </ModuleBoundary>
          <span className="flex-1" />
          <ModuleBoundary id="thumbnail" name="thumbnail" small>
            <ThumbnailModule strip />
          </ModuleBoundary>
        </>
      }
      footer={
        <ModuleBoundary id="thumbnail" name="thumbnail">
          <ThumbnailModule />
        </ModuleBoundary>
      }
    >
      <ModuleBoundary id="studio" name="studio">
        <StudioModule />
      </ModuleBoundary>
      <ModuleBoundary id="layout" name="layout switcher">
        <LayoutModule />
      </ModuleBoundary>
      <ModuleBoundary id="presets" name="presets">
        <PresetsModule />
      </ModuleBoundary>
    </Collapsible>
  );
}

export function LivePage() {
  const navigate = useNavigate();
  const mobile = useIsMobile();
  usePinnedPage(mobile);
  usePresetKeys();
  const keyboard = useKeyboard().keyboard;
  const typing = useTypingIn('chat-text') && mobile;
  const strip = keyboardStrip(typing);
  const [tab, setTab] = useState<PhoneTab>(keptTab);
  const [picking, setPicking] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [peek, setPeek] = useState(false);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const park = useRef<HTMLDivElement | null>(null);
  const hosts = useHosts();
  const name = useAtomValue(streamNameAtom);
  const chatRoom = useAtomValue(chatRoomAtom);
  const publishing = useAtomValue(isPublishingAtom);
  const phase = useAtomValue(publishPhaseAtom);
  const stats = useAtomValue(publishStatsAtom);
  const watchUrl = useAtomValue(watchUrlAtom);
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
  const panels = useAtomValue(livePanelsAtom);
  const layout = useAtomValue(liveLayoutAtom);
  const editing = useAtomValue(liveEditingAtom);
  const preset = useAtomValue(livePresetAtom);
  const rail = useAtomValue(liveRailAtom);
  const width = useWindowWidth();
  const [deskRef, deskWidth] = useWidthOf(!mobile);
  const windowed = !mobile && chatSide === 'modal';
  const phoneTabs = PHONE_TABS.filter((t) => !panels.hidden.includes(t));
  const shownTab = phoneTabs.includes(tab) ? tab : (phoneTabs[0] ?? 'chat');
  const unread = useUnread(chatRoom, mobile && shownTab !== 'chat');
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

  useLayoutEffect(() => {
    const parking = park.current;
    if (!parking) return;
    for (const id of TILE_IDS) {
      const host = hosts[id];
      const slot = host.parentElement;
      if (slot === parking) continue;
      if (!slot?.isConnected || !(slot.dataset.slot ?? '').split(' ').includes(id)) parking.appendChild(host);
    }
  });

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
        {windowed ? <ChatOpenButton className="ml-auto" /> : <span className="ml-auto" />}
        {publishing && (
          <IconButton id="live-pip" label="picture in picture" {...homePress} onClick={toCorner}>
            <PipIcon />
          </IconButton>
        )}
      </div>
    </div>
  );

  const modelDialog = picking && <ModelDialog onClose={() => setPicking(false)} />;

  const skip: ModuleId[] = windowed ? ['chat'] : [];
  const a = layout === 5 ? null : arrange(layout, panels.hidden, skip);
  const isRailOpen = railOpen(rail, width);
  const columnPx = width >= 1600 ? 280 : 264;
  const besideChat =
    deskWidth -
    (isRailOpen ? RAIL_PX : STRIP_PX) -
    GAP_PX -
    (a && a.left.length > 0 ? columnPx + GAP_PX : 0) -
    (a && a.right.length > 0 ? columnPx + GAP_PX : 0) -
    CHAT_PX -
    GAP_PX;
  const crowded = a !== null && a.left.length + a.right.length + a.below.length > 0;
  const squeezed = a !== null && a.side.length > 0 && deskWidth > 0 && besideChat < (crowded ? CENTER_MIN : CENTER_ALONE_MIN);
  const sideOpen = squeezed ? peek && panels.chat : panels.chat;
  const centerPx = besideChat + CHAT_PX - (a && a.side.length > 0 ? (sideOpen ? CHAT_PX : STRIP_PX) : -GAP_PX);
  const cellPx = a && a.below.length > 0 ? (centerPx - (a.below.length - 1) * GAP_PX) / a.below.length : 0;
  const rowH = cellPx >= WIDE_CELL ? ROW_LOW : ROW_TALL;
  const toggleSide = (open: boolean) => {
    setPeek(open);
    if (open !== panels.chat) setLivePanel('chat', open);
  };

  const body = (id: ModuleId, place: Place): ReactNode => {
    if (id === 'sources') return <SourcesModule place={place} onModel={openModel} />;
    if (id === 'face') return <FaceModule place={place} onModel={openModel} />;
    if (id === 'rig') return <RigModule place={place} />;
    if (id === 'sound') return <SoundModule place={place} />;
    if (place === 'side') return <ChatModule place={place} open={sideOpen} onToggle={squeezed ? toggleSide : undefined} />;
    return <ChatModule place={place} className={place === 'phone' ? cn('h-full min-h-0 flex-1', CHAT_MOBILE) : undefined} />;
  };

  const presetWords = preset ? PRESET_WORDS[preset].name : 'custom';
  const PresetIcon = PRESET_ICONS[preset ?? 'full'];

  if (mobile) {
    const panel = (t: PhoneTab, children: ReactNode, className?: string) => (
      <div
        key={t}
        id={`live-panel-${t}`}
        role="tabpanel"
        aria-labelledby={`live-tab-${t}`}
        inert={shownTab !== t ? true : undefined}
        className={cn('absolute inset-0', shownTab !== t && 'invisible', className ?? 'overflow-y-auto overscroll-contain bg-backgroundSecondary pb-4')}
      >
        <ModuleBoundary id={t} name={DOCK_WORDS[t]}>
          {children}
        </ModuleBoundary>
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
              const on = t === shownTab;
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
                  {PHONE_WORDS[t]}
                  {t === 'chat' && <Unread count={unread} />}
                </button>
              );
            })}
          </div>
          <div className="relative min-h-0 flex-1">
            {PHONE_TABS.map((t) => (t === 'chat' ? panel('chat', body('chat', 'phone'), 'flex flex-col') : panel(t, body(t, 'phone'))))}
          </div>
          <div
            id="live-start-bar"
            className={cn(
              'sticky bottom-0 flex shrink-0 items-center gap-2 border-t border-primaryStroke bg-background px-3 pb-[calc(0.625rem+env(safe-area-inset-bottom))] pt-2.5',
              typing && 'hidden'
            )}
          >
            <StartStop className="flex min-w-0 flex-1 flex-col items-stretch gap-1 [&>button:first-child]:h-12 [&>button:first-child]:py-0" />
            <Button
              id="live-preset-open"
              size="sm"
              aria-haspopup="dialog"
              aria-expanded={drawer}
              aria-controls="live-drawer"
              className="h-12 max-w-[42%] shrink-0 gap-1.5 px-3"
              onClick={() => setDrawer(true)}
            >
              <PresetIcon aria-hidden size={16} className="shrink-0" />
              <span className="truncate">{presetWords}</span>
            </Button>
          </div>
        </PageFrame>
        <SwipeDrawer side="right" open={drawer} onOpenChange={setDrawer} label="studio" id="live-drawer" className="w-[85%] max-w-[22rem] bg-backgroundSecondary">
          {(shown) =>
            shown && (
              <>
                <div className="flex shrink-0 items-center justify-between pl-3 text-xs font-semibold uppercase tracking-wider text-textTertiary">
                  studio
                  <DrawerClose onClose={() => setDrawer(false)} />
                </div>
                <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
                  <ModuleBoundary id="studio" name="studio">
                    <StudioModule prefix="drawer" />
                  </ModuleBoundary>
                  <ModuleBoundary id="presets" name="presets">
                    <PresetsModule />
                  </ModuleBoundary>
                  <span className="flex-1" />
                  <ModuleBoundary id="thumbnail" name="thumbnail">
                    <ThumbnailModule />
                  </ModuleBoundary>
                </div>
              </>
            )
          }
        </SwipeDrawer>
        {modelDialog}
        <KbdDebug typing={typing} />
      </div>
    );
  }

  const gridShown = TILE_IDS.filter((t) => t === 'preview' || (!panels.hidden.includes(t) && !skip.includes(t)));
  const placeOf = (id: ModuleId): Place | null => (layout === 5 ? (gridShown.includes(id) ? 'tile' : null) : placeIn(a!, id));
  const belowOpen = a ? a.below.some((id) => panels[id]) : false;
  const reserve = a ? reserveFor(a.below.length > 0, belowOpen, rowH, a.under.length > 0, panels.chat) : '0px';
  const column = 'flex w-[16.5rem] shrink-0 flex-col gap-2 overflow-y-auto overscroll-contain min-[1600px]:w-[17.5rem]';

  return (
    <PageFrame title="go live" wide fluid fill>
      <div
        ref={deskRef}
        id="live-desk"
        data-squeezed={squeezed || undefined}
        data-layout={layout}
        data-editing={editing || undefined}
        data-preset={preset ?? 'custom'}
        className="flex h-[calc(100dvh-var(--page-top,100px)-0.75rem)] min-h-0 gap-2 bubble:h-[calc(100dvh-var(--page-top,100px)-0.5rem)]"
      >
        {a ? (
          <div id="live-stage" className="flex min-h-0 min-w-0 flex-1 gap-2">
            {a.left.length > 0 && <Slot hosts={hosts} ids={a.left} id="live-left" className={column} />}
            <div id="live-center" className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 [container-type:size]">
              <Slot
                hosts={hosts}
                ids={['preview']}
                id="live-preview"
                className="mx-auto w-full shrink-0"
                style={{ maxWidth: `calc((100cqh - (${reserve})) * 16 / 9)` }}
              />
              {a.below.length > 0 && (
                <Slot
                  hosts={hosts}
                  ids={a.below}
                  id="live-below"
                  className="grid shrink-0 items-start gap-2"
                  style={{ gridTemplateColumns: `repeat(${a.below.length}, minmax(0, 1fr))`, height: belowOpen ? rowH : undefined }}
                />
              )}
              {a.under.length > 0 && <Slot hosts={hosts} ids={a.under} id="live-under" className="flex min-h-0 flex-1 flex-col" />}
            </div>
            {a.right.length > 0 && <Slot hosts={hosts} ids={a.right} id="live-right" className={column} />}
            {a.side.length > 0 && (
              <Slot
                hosts={hosts}
                ids={a.side}
                id="live-side"
                className={cn(
                  'flex min-h-0 shrink-0 flex-col motion-safe:transition-[width] motion-safe:duration-150 motion-reduce:transition-none',
                  sideOpen ? 'w-[340px]' : 'w-10'
                )}
              />
            )}
          </div>
        ) : (
          <GridStage hosts={hosts} shown={gridShown} editing={editing} />
        )}
        <Rail open={isRailOpen} onToggle={() => setRail(!isRailOpen)} />
      </div>
      <div ref={park} id="live-park" hidden />
      {createPortal(preview, hosts.preview, 'preview')}
      {MODULE_IDS.map((id) =>
        createPortal(
          <ModuleBoundary id={id} name={DOCK_WORDS[id]}>
            {id === 'chat' && windowed ? null : body(id, placeOf(id) ?? 'column')}
          </ModuleBoundary>,
          hosts[id],
          id
        )
      )}
      {windowed && (
        <ModuleBoundary id="chat-window" name="chat">
          <ChatWindow />
        </ModuleBoundary>
      )}
      {modelDialog}
      {DESKTOP && (
        <Suspense fallback={null}>
          <ScreenPicker />
        </Suspense>
      )}
    </PageFrame>
  );
}
