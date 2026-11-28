import { RiAddLine, RiArrowLeftSLine, RiArrowRightSLine, RiDraggable, RiLinkM } from '@remixicon/react';
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
  avatarLookAtom,
  cameraAtom,
  cameraOnlyAtom,
  chatRoomAtom,
  copyWatchUrl,
  enterLivePage,
  isPublishingAtom,
  leaveLivePage,
  liveViewersAtom,
  micLevelReader,
  mixerOpenAtom,
  modelSeeThroughAtom,
  moveSource,
  nudgeSource,
  previewMoveSource,
  previewResizeSource,
  streamSourceBox,
  previewSlotAtom,
  previewStreamAtom,
  publishPhaseAtom,
  publishStatsAtom,
  removeSource,
  reorderSource,
  resizeSource,
  previewSceneAtom,
  waitingSourcesAtom,
  selectedSourceAtom,
  selectSource,
  sentStreamAtom,
  setCameraOnly,
  sourcesAtom,
  startCamera,
  startPublishPip,
  streamNameAtom,
  toggleSource,
  watchUrlAtom
} from '@/infra/atoms/publish-atoms';
import { myAvatarVersionAtom } from '@/infra/atoms/profile-atoms';
import { pickPreset, watchPresets } from '@/infra/atoms/preset-atoms';
import { publishPipAtom } from '@/infra/atoms/publish-state';
import { stopSounds, watchSources } from '@/infra/atoms/source-atoms';
import { chatModalOpenAtom } from '@/infra/atoms/settings-atoms';
import { usePinnedPage, useKeyboard, useTypingIn } from '@/infra/keyboard';
import {
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
  livePresetsAtom,
  migrateLayouts,
  migratePresets,
  livePanelsAtom,
  livePresetAtom,
  liveRailAtom,
  liveRailWidthAtom,
  MODULE_IDS,
  type ModuleId,
  type Place,
  placeIn,
  presetForKey,
  presetName,
  fitRailWidth,
  RAIL_W_MAX,
  RAIL_W_MIN,
  RAIL_W_STEP,
  railFocusAtom,
  railOpen,
  setGrid,
  setRail,
  setRailWidth,
  showInGrid,
  TILE_IDS,
  type TileId,
  typingInto
} from '@/infra/live-dock';
import { CHAT_MOBILE, keyboardStrip, useIsMobile } from '@/infra/mobile';
import { usePrefetchOnPointerDown } from '@/infra/prefetch';
import { store } from '@/infra/store';
import { inTauri } from '@/infra/update-check';
import { Button } from '@/shared-components/Button';
import { ChatOpenButton, useChatSide } from '@/shared-components/ChatSlot';
import { Face } from '@/shared-components/Face';
import { KbdDebug } from '@/shared-components/KbdDebug';
import { panelClassName } from '@/shared-components/Panel';
import { FOLD_BUTTON, ModuleBoundary } from '@/shared-components/live/Dock';
import { ModelDialog } from '@/shared-components/live/ModelDialog';
import { ModelLoading } from '@/shared-components/live/ModelLoading';
import { ChatModule, ChatWindow, Unread, useUnread } from '@/shared-components/live/modules/Chat';
import { DestinationsModule } from '@/shared-components/live/modules/Destinations';
import { LayoutModule } from '@/shared-components/live/modules/LayoutSwitcher';
import { PresetIcon, PresetsModule } from '@/shared-components/live/modules/Presets';
import { WaitingLayer } from '@/shared-components/live/WaitingLayer';
import { SoundModule } from '@/shared-components/live/modules/Sound';
import { SourceModule } from '@/shared-components/live/modules/Source';
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

type PhoneTab = Exclude<ModuleId, 'source'>;
const PHONE_TABS: readonly PhoneTab[] = ['sources', 'sound', 'chat'];
const PHONE_WORDS: Record<PhoneTab, string> = { sources: 'sources', sound: 'sound', chat: 'chat' };

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

function useHudBeside(on: boolean) {
  useLayoutEffect(() => {
    const rail = document.getElementById('live-rail');
    if (!on || !rail) return;
    const root = document.documentElement;
    const place = () => root.style.setProperty('--perf-hud-right', `${Math.max(6, root.clientWidth - rail.getBoundingClientRect().left + 6)}px`);
    place();
    const watcher = new ResizeObserver(place);
    watcher.observe(rail);
    watcher.observe(root);
    return () => {
      watcher.disconnect();
      root.style.removeProperty('--perf-hud-right');
    };
  }, [on]);
}

migratePresets();
migrateLayouts();

function usePresetKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (typingInto(e.target) || typingInto(document.activeElement)) return;
      if (document.querySelector('dialog:modal')) return;
      const id = presetForKey(e.key, store.get(livePresetsAtom).list);
      if (!id) return;
      e.preventDefault();
      void pickPreset(id);
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
const RAIL_STRIP_PX = 40;
const CHAT_PX = 340;
const GAP_PX = 8;
const UNDER_MIN = '12rem';
const GAP = '0.5rem';

function reserveFor(below: boolean, rowH: string, under: boolean): string {
  const parts: string[] = [];
  if (below) parts.push(rowH, GAP);
  if (under) parts.push(UNDER_MIN, GAP);
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
    </div>
  );
}

function GridStage({ hosts, shown, editing }: { hosts: Hosts; shown: TileId[]; editing: boolean }) {
  const grid = useAtomValue(liveGridAtom);
  const panels = useAtomValue(livePanelsAtom);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [draft, setDraft] = useState<Cell | null>(null);
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
    if (fits(grid, shown, id, cell)) setGrid({ ...grid, [id]: cell } as Grid);
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
      {editing && <EditBar hidden={MODULE_IDS.filter((id) => panels.hidden.includes(id))} onAdd={showInGrid} />}
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
                      <Tooltip content="drag to move. arrows move it, shift and arrows size it" hideOnPress>
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
                <Tooltip content="drag to size" hideOnPress>
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
    </div>
  );
}

const RAIL_HEAD = 'flex h-9 shrink-0 items-center gap-1.5 pl-3 pr-1 text-xs font-semibold uppercase tracking-wider text-textTertiary';

const GRIP_SHOW = 'opacity-0 group-hover/edge:opacity-100 group-focus-within/edge:opacity-100';

function RailStrip({ onToggle }: { onToggle: () => void }) {
  return (
    <nav
      id="live-rail-strip"
      aria-label="studio"
      className={panelClassName('flex min-h-0 w-10 shrink-0 flex-col items-center overflow-y-auto overflow-x-hidden overscroll-contain')}
    >
      <div className="flex flex-col items-center py-2">
        <Tooltip content="expand" at="left">
          <button
            id="live-rail-toggle"
            type="button"
            aria-label="expand"
            aria-expanded={false}
            aria-controls="live-rail-body"
            onClick={onToggle}
            className={FOLD_BUTTON}
          >
            <RiArrowLeftSLine aria-hidden size={16} />
          </button>
        </Tooltip>
      </div>
      <ModuleBoundary id="thumbnail" name="thumbnail" small>
        <ThumbnailModule strip />
      </ModuleBoundary>
      <ModuleBoundary id="studio" name="studio" small>
        <StudioModule strip />
      </ModuleBoundary>
      <ModuleBoundary id="presets" name="presets" small>
        <PresetsModule strip />
      </ModuleBoundary>
      <ModuleBoundary id="destinations" name="destinations" small>
        <DestinationsModule strip />
      </ModuleBoundary>
      <span className="flex-1" />
      <ModuleBoundary id="layout" name="layout switcher" small>
        <LayoutModule strip />
      </ModuleBoundary>
    </nav>
  );
}

function Rail({ open, width, onToggle }: { open: boolean; width: number; onToggle: () => void }) {
  const drag = useRef<{ id: number; x: number; w: number; now: number } | null>(null);
  const [live, setLive] = useState<number | null>(null);
  const focusAt = useAtomValue(railFocusAtom);
  const shown = live ?? width;
  const dragging = live !== null;

  useEffect(() => {
    if (!open || !focusAt) return;
    store.set(railFocusAtom, null);
    const section = document.querySelector<HTMLElement>(`#live-rail-body [data-rail-section="${focusAt}"]`);
    if (!section) return;
    section.scrollIntoView({ block: 'nearest' });
    section.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')?.focus({ preventScroll: true });
  }, [open, focusAt]);

  const finish = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.body.style.removeProperty('user-select');
    document.body.style.removeProperty('cursor');
    setRailWidth(d.now);
    setLive(null);
  };

  if (!open)
    return (
      <div id="live-rail" data-open={false} className="flex min-h-0 shrink-0">
        <RailStrip onToggle={onToggle} />
      </div>
    );

  return (
    <div id="live-rail" data-open className="relative flex min-h-0 shrink-0">
      <section id="live-rail-body" aria-label="studio" className={panelClassName('flex min-h-0 flex-col overflow-hidden')} style={{ width: shown }}>
        <h2 className={RAIL_HEAD}>
          <span className="min-w-0 flex-1 truncate">studio</span>
        </h2>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-contain">
          <ModuleBoundary id="thumbnail" name="thumbnail">
            <ThumbnailModule />
          </ModuleBoundary>
          <ModuleBoundary id="studio" name="studio">
            <StudioModule />
          </ModuleBoundary>
          <ModuleBoundary id="presets" name="presets">
            <PresetsModule />
          </ModuleBoundary>
          <ModuleBoundary id="destinations" name="destinations">
            <DestinationsModule />
          </ModuleBoundary>
        </div>
        <ModuleBoundary id="layout" name="layout switcher">
          <LayoutModule />
        </ModuleBoundary>
      </section>
      <div id="live-rail-edge" data-dragging={dragging || undefined} className="group/edge absolute inset-y-0 -left-2 w-2.5">
        <Tooltip content={dragging ? null : 'drag to resize · double-click resets'} at="left" hideOnPress>
          <div
            id="live-rail-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="resize studio"
            aria-valuenow={shown}
            aria-valuemin={RAIL_W_MIN}
            aria-valuemax={RAIL_W_MAX}
            tabIndex={0}
            data-dragging={dragging || undefined}
            onPointerDown={(e) => {
              if (e.button !== 0 || drag.current) return;
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { id: e.pointerId, x: e.clientX, w: width, now: width };
              document.body.style.userSelect = 'none';
              document.body.style.cursor = 'col-resize';
              setLive(width);
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d || e.pointerId !== d.id) return;
              d.now = fitRailWidth(d.w + d.x - e.clientX);
              setLive(d.now);
            }}
            onPointerUp={finish}
            onPointerCancel={finish}
            onLostPointerCapture={finish}
            onDoubleClick={() => setRailWidth(null)}
            onKeyDown={(e) => {
              let w: number | null = null;
              if (e.key === 'ArrowLeft') w = width + RAIL_W_STEP;
              else if (e.key === 'ArrowRight') w = width - RAIL_W_STEP;
              else if (e.key === 'Home') w = RAIL_W_MIN;
              else if (e.key === 'End') w = RAIL_W_MAX;
              if (w === null) return;
              e.preventDefault();
              setRailWidth(w);
            }}
            className="group/resize absolute inset-0 cursor-col-resize touch-none outline-none"
          >
            <span
              aria-hidden
              className={cn(
                'absolute inset-y-0 left-2 w-px transition-colors duration-150',
                dragging ? 'bg-primaryBlue' : 'bg-transparent group-focus-visible/resize:bg-primaryBlue'
              )}
            />
            <span
              id="live-rail-grip"
              aria-hidden
              className={cn(
                'absolute left-[8.5px] top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-[3px] rounded-control border bg-backgroundSecondary px-[3px] py-1.5 transition-[opacity,color,border-color] duration-150',
                dragging ? 'border-primaryBlue text-primaryBlue opacity-100' : cn('border-primaryStroke text-textTertiary', GRIP_SHOW)
              )}
            >
              <span className="h-[3px] w-[3px] rounded-avatar bg-current" />
              <span className="h-[3px] w-[3px] rounded-avatar bg-current" />
              <span className="h-[3px] w-[3px] rounded-avatar bg-current" />
            </span>
          </div>
        </Tooltip>
        {!dragging && (
          <Tooltip content="collapse" at="left">
            <button
              id="live-rail-toggle"
              type="button"
              aria-label="collapse"
              aria-expanded
              aria-controls="live-rail-body"
              onClick={onToggle}
              className={cn(
                'absolute left-[8.5px] top-[calc(50%+1.5rem)] flex h-5 w-4 -translate-x-1/2 items-center justify-center rounded-control border border-primaryStroke bg-backgroundSecondary text-textTertiary transition-[opacity,color,border-color] duration-150 hover:border-primaryBlue hover:text-primaryBlue focus-visible:border-primaryBlue focus-visible:text-primaryBlue focus-visible:outline-none',
                GRIP_SHOW
              )}
            >
              <RiArrowRightSLine aria-hidden size={12} />
            </button>
          </Tooltip>
        )}
        {dragging && (
          <span
            id="live-rail-size"
            aria-live="polite"
            className="pointer-events-none absolute bottom-[calc(50%+1.25rem)] left-[8.5px] -translate-x-1/2 whitespace-nowrap rounded-card border border-primaryStroke bg-backgroundSecondary px-2 py-0.5 text-xs font-semibold tabular-nums text-textPrimary"
          >
            {shown} / {RAIL_W_MAX}
          </span>
        )}
      </div>
    </div>
  );
}

export function LivePage() {
  const navigate = useNavigate();
  const mobile = useIsMobile();
  usePinnedPage(mobile);
  usePresetKeys();
  useHudBeside(!mobile);
  const keyboard = useKeyboard().keyboard;
  const typing = useTypingIn('chat-text') && mobile;
  const strip = keyboardStrip(typing);
  const [tab, setTab] = useState<PhoneTab>(keptTab);
  const [picking, setPicking] = useState(false);
  const [drawer, setDrawer] = useState(false);
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
  const scene = useAtomValue(previewSceneAtom);
  const waiting = useAtomValue(waitingSourcesAtom);
  const sources = useAtomValue(sourcesAtom);
  const previewSlot = useAtomValue(previewSlotAtom);
  const selected = useAtomValue(selectedSourceAtom);
  const mixerOpen = useAtomValue(mixerOpenAtom);
  const myAvatar = useAtomValue(myAvatarVersionAtom);
  const avatarLook = useAtomValue(avatarLookAtom);
  const me = useAtomValue(meAtom);
  const panels = useAtomValue(livePanelsAtom);
  const layout = useAtomValue(liveLayoutAtom);
  const editing = useAtomValue(liveEditingAtom);
  const preset = useAtomValue(livePresetAtom);
  const presets = useAtomValue(livePresetsAtom);
  const rail = useAtomValue(liveRailAtom);
  const railWidth = useAtomValue(liveRailWidthAtom);
  const cameraOnly = useAtomValue(cameraOnlyAtom);
  const seeThrough = useAtomValue(modelSeeThroughAtom);
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
    previewMove: previewMoveSource,
    previewResize: previewResizeSource,
    onStream: streamSourceBox,
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
    setCameraOnly(false);
  }, []);

  useEffect(() => watchPresets(), []);

  useEffect(() => {
    void startCamera();
    void enterLivePage();
    watchSources();
    return () => {
      leaveLivePage();
      if (!store.get(publishPipAtom)) stopSounds();
    };
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
        avatar={{ name, version: myAvatar, streamAtom: cameraAtom, read: mixerOpen ? micLevelReader : undefined, look: avatarLook }}
        main={{ id: 'preview', streamAtom: previewStreamAtom, videoRef: previewRef, slot: previewSlot, muted: true }}
        edit={cameraOnly ? undefined : edit}
        clearSlot={seeThrough ? 0 : null}
        placeholder={(layer) => {
          const source = waiting.find((s) => s.id === layer.id);
          return source ? <WaitingLayer source={source} /> : null;
        }}
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
  const a = layout === 'obs' ? arrange(panels.hidden, skip) : null;
  const isRailOpen = railOpen(rail);
  const columnPx = width >= 1600 ? 280 : 264;
  const besideChat =
    deskWidth -
    (isRailOpen ? railWidth : RAIL_STRIP_PX) -
    GAP_PX -
    (a && a.left.length > 0 ? columnPx + GAP_PX : 0) -
    (a && a.right.length > 0 ? columnPx + GAP_PX : 0) -
    CHAT_PX -
    GAP_PX;
  const centerPx = besideChat + (a && a.side.length > 0 ? 0 : CHAT_PX + GAP_PX);
  const cellPx = a && a.below.length > 0 ? (centerPx - (a.below.length - 1) * GAP_PX) / a.below.length : 0;
  const rowH = cellPx >= WIDE_CELL ? ROW_LOW : ROW_TALL;

  const body = (id: ModuleId, place: Place): ReactNode => {
    if (id === 'sources') return <SourcesModule place={place} onModel={openModel} />;
    if (id === 'source') return <SourceModule place={place} onModel={openModel} />;
    if (id === 'sound') return <SoundModule place={place} />;
    return <ChatModule place={place} className={place === 'phone' ? cn('h-full min-h-0 flex-1', CHAT_MOBILE) : undefined} />;
  };

  const presetWords = presetName(presets.list.find((p) => p.id === preset));

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
        className="group/phone fixed inset-x-0 [--sticky-top:0px] top-[calc(var(--vvt,0px)+var(--banner-h,0px))] flex h-[calc(var(--vvh,100dvh)-var(--banner-h,0px))] flex-col overflow-hidden bg-background pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
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
              <PresetIcon id={preset} size={16} className="shrink-0" />
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
                  <ModuleBoundary id="thumbnail" name="thumbnail">
                    <ThumbnailModule />
                  </ModuleBoundary>
                  <ModuleBoundary id="studio" name="studio">
                    <StudioModule prefix="drawer" />
                  </ModuleBoundary>
                  <ModuleBoundary id="presets" name="presets">
                    <PresetsModule />
                  </ModuleBoundary>
                  <ModuleBoundary id="destinations" name="destinations">
                    <DestinationsModule />
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
  const placeOf = (id: ModuleId): Place | null => (a ? placeIn(a, id) : gridShown.includes(id) ? 'tile' : null);
  const reserve = a ? reserveFor(a.below.length > 0, rowH, a.under.length > 0) : '0px';
  const column = 'flex w-[16.5rem] shrink-0 flex-col gap-2 overflow-y-auto overscroll-contain min-[1600px]:w-[17.5rem]';

  return (
    <PageFrame title="go live" wide fluid fill>
      <div
        ref={deskRef}
        id="live-desk"
        data-layout={layout}
        data-editing={editing || undefined}
        data-preset={preset}
        className="flex h-[calc(100dvh-var(--page-top,100px)-var(--banner-h,0px)-0.75rem)] min-h-0 gap-2 bubble:h-[calc(100dvh-var(--page-top,100px)-var(--banner-h,0px)-0.5rem)]"
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
                  style={{ gridTemplateColumns: `repeat(${a.below.length}, minmax(0, 1fr))`, height: rowH }}
                />
              )}
              {a.under.length > 0 && <Slot hosts={hosts} ids={a.under} id="live-under" className="flex min-h-0 flex-1 flex-col" />}
            </div>
            {a.right.length > 0 && <Slot hosts={hosts} ids={a.right} id="live-right" className={column} />}
            {a.side.length > 0 && <Slot hosts={hosts} ids={a.side} id="live-side" className="flex min-h-0 w-[340px] shrink-0 flex-col" />}
          </div>
        ) : (
          <GridStage hosts={hosts} shown={gridShown} editing={editing} />
        )}
        <Rail open={isRailOpen} width={railWidth} onToggle={() => setRail(!isRailOpen)} />
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
