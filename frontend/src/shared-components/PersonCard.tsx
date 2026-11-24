import { useAtomValue } from 'jotai';
import { type CSSProperties, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { api, type GroupBadge } from '@/infra/api';
import { BOT_GROUP } from '@/infra/atoms/chat-atoms';
import { homeStreamsAtom } from '@/infra/atoms/home-atoms';
import { loadPeek, peeksAtom } from '@/infra/atoms/follow-atoms';
import { type Presence, PRESENCE_WORD } from '@/infra/atoms/presence-atoms';
import { profilePopupAtom } from '@/infra/atoms/profile-popup-atoms';
import type { PanelSide } from '@/infra/atoms/settings-atoms';
import { Badge } from '@/shared-components/Badge';
import { BlurredPicture } from '@/shared-components/BlurredPicture';
import { Face } from '@/shared-components/Face';
import { Who } from '@/shared-components/PersonRow';
import { PresenceSquare } from '@/shared-components/PresenceSquare';
import { StreamStill } from '@/shared-components/StreamStill';
import { Tooltip } from '@/shared-components/Tooltip';
import { ViewerCount } from '@/shared-components/ViewerCount';
import { cn } from '@/utils/cn';

const CARD_W = 260;
const GAP = 4;
const ACTIONS_W = 30;
const LINGER_MS = 180;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface CardAction {
  key: string;
  label: string;
  icon: ReactNode;
  danger?: boolean;
  onPick: () => void;
}

export interface PeekHold {
  setCard: (el: HTMLElement | null) => void;
  enter: () => void;
  leave: () => void;
  pin: (on: boolean) => void;
  keyDown: (e: KeyboardEvent<HTMLElement>) => void;
  blur: (e: FocusEvent<HTMLElement>) => void;
}

export interface CardPerson {
  name: string;
  verified: boolean;
  oauth_verified?: boolean;
  avatar: number | null;
  bio?: string;
  presence?: Presence;
  groups?: GroupBadge[];
}

export interface CardSpot {
  row: DOMRect;
  column: DOMRect;
  host: HTMLElement;
}

let lastInput = 'mouse';
let tracking = false;
function trackInput() {
  if (tracking) return;
  tracking = true;
  const pressed = (e: globalThis.PointerEvent) => {
    lastInput = e.pointerType;
  };
  const typed = () => {
    lastInput = 'keyboard';
  };
  window.addEventListener('pointerdown', pressed, true);
  window.addEventListener('keydown', typed, true);
}

function peeking(e: PointerEvent<Element> | FocusEvent<Element>) {
  if ('pointerType' in e) return e.pointerType === 'mouse';
  return lastInput !== 'touch' && lastInput !== 'pen';
}

function rowTarget(row: HTMLElement): HTMLElement {
  return row.matches(FOCUSABLE) ? row : (row.querySelector<HTMLElement>(FOCUSABLE) ?? row);
}

export function usePeek(delay: number) {
  const [at, setAt] = useState<CardSpot | null>(null);
  const timer = useRef<number | null>(null);
  const closing = useRef<number | null>(null);
  const row = useRef<HTMLElement | null>(null);
  const card = useRef<HTMLElement | null>(null);
  const pinned = useRef(false);
  const stay = () => {
    if (closing.current !== null) {
      window.clearTimeout(closing.current);
      closing.current = null;
    }
  };
  const clear = () => {
    stay();
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const close = () => {
    clear();
    pinned.current = false;
    setAt(null);
  };
  const inUse = () => {
    const c = card.current;
    if (pinned.current || c?.matches(':hover') || row.current?.matches(':hover')) return true;
    return !!c && lastInput === 'keyboard' && c.contains(c.ownerDocument.activeElement);
  };
  const goSoon = () => {
    stay();
    closing.current = window.setTimeout(() => {
      closing.current = null;
      if (!inUse()) setAt(null);
    }, LINGER_MS);
  };
  useEffect(() => clear, []);
  useEffect(trackInput, []);
  const show = (e: PointerEvent<HTMLElement> | FocusEvent<HTMLElement>, column: Element | null) => {
    if (!column || !peeking(e)) return;
    const el = e.currentTarget;
    row.current = el;
    clear();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (!el.isConnected) return;
      setAt({
        row: el.getBoundingClientRect(),
        column: column.getBoundingClientRect(),
        host: el.closest<HTMLElement>('dialog:modal') ?? el.ownerDocument.body
      });
    }, delay);
  };
  const backToRow = () => {
    if (row.current?.isConnected) rowTarget(row.current).focus();
  };
  const hold: PeekHold = {
    setCard: (el) => {
      card.current = el;
    },
    enter: stay,
    leave: () => {
      if (!pinned.current) goSoon();
    },
    pin: (on) => {
      pinned.current = on;
      if (on) stay();
      else goSoon();
    },
    keyDown: (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        backToRow();
        return;
      }
      if (e.key !== 'Tab' || !card.current) return;
      const list = [...card.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const edge = e.shiftKey ? list[0] : list[list.length - 1];
      if (list.length > 0 && document.activeElement !== edge) return;
      e.preventDefault();
      if (!e.shiftKey) close();
      backToRow();
    },
    blur: (e) => {
      const to = e.relatedTarget as Node | null;
      if (card.current?.contains(to) || row.current?.contains(to) || inUse()) return;
      close();
    }
  };
  return {
    at,
    show,
    focus(e: FocusEvent<HTMLElement>, column: Element | null) {
      if (!e.target.matches(':focus-visible')) return;
      if (e.relatedTarget instanceof Element && e.relatedTarget.closest('#profile-popup')) return;
      if (at && card.current?.contains(e.relatedTarget as Node | null)) return;
      show(e, column);
    },
    leave(el: Element) {
      if (el.contains(document.activeElement)) return;
      clear();
      if (!pinned.current) goSoon();
    },
    blur(e: FocusEvent<HTMLElement>) {
      const el = e.currentTarget;
      const to = e.relatedTarget as Node | null;
      if (el.contains(to) || card.current?.contains(to) || inUse()) return;
      close();
    },
    keyDown(e: KeyboardEvent<HTMLElement>) {
      if (!at) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== 'Tab' || e.shiftKey) return;
      const first = card.current?.querySelector<HTMLElement>(FOCUSABLE);
      if (!first) return;
      e.preventDefault();
      first.focus();
    },
    hold,
    close
  };
}

interface PersonCardProps {
  id?: string;
  person: CardPerson;
  at: CardSpot;
  side?: PanelSide;
  actions?: CardAction[] | null;
  below?: ReactNode;
  hold: PeekHold;
}

export function PersonCard({ id, person, at, side, actions, below, hold }: PersonCardProps) {
  const { setCard } = hold;
  const peek = useAtomValue(peeksAtom)[person.name]?.card;
  const covered = useAtomValue(profilePopupAtom) !== null;
  useEffect(() => {
    void loadPeek(person.name);
  }, [person.name]);
  const viewers = useAtomValue(homeStreamsAtom)?.find((s) => s.name === person.name)?.viewers ?? null;
  if (covered) return null;
  const known = person.verified && peek && !peek.verified ? undefined : peek;
  const bio = person.bio ?? known?.bio ?? '';
  const presence = person.presence ?? known?.presence;
  const badge = known?.badge !== undefined ? known.badge : (person.groups?.find((g) => g.name !== BOT_GROUP) ?? null);
  const root = at.host.ownerDocument.documentElement;
  const w = root.clientWidth;
  const h = root.clientHeight;
  const edge = side ?? (at.column.left + at.column.width / 2 > w / 2 ? 'right' : 'left');
  const x = edge === 'right' ? at.column.left - GAP - CARD_W : at.column.right + GAP;
  const pressable = !!actions && actions.length > 0;
  const least = GAP + (pressable ? ACTIONS_W : 0);
  const style: CSSProperties = {
    width: CARD_W,
    left: Math.max(least, Math.min(x, w - CARD_W - GAP)),
    ...(at.row.top < h / 2 ? { top: at.row.top } : { bottom: h - at.row.bottom })
  };
  return createPortal(
    <div
      ref={setCard}
      style={style}
      data-peek-hold
      onPointerEnter={hold.enter}
      onPointerLeave={hold.leave}
      onKeyDown={hold.keyDown}
      onBlur={hold.blur}
      className="pointer-events-auto fixed z-[60]"
    >
      {pressable && (
        <div
          id={id ? `${id}-mod` : undefined}
          role="toolbar"
          aria-orientation="vertical"
          aria-label={`moderate ${person.name}`}
          className="absolute right-full top-0 -mr-px flex flex-col border border-primaryStroke bg-backgroundSecondary"
        >
          {actions.map((a) => (
            <Tooltip key={a.key} content={a.label} at="left">
              <button
                type="button"
                aria-label={a.label}
                data-card-action={a.key}
                onClick={a.onPick}
                className={cn(
                  'flex h-7 w-7 items-center justify-center border border-transparent hover:border-primaryStroke focus-visible:border-primaryBlue focus-visible:outline-none',
                  a.danger ? 'text-decrease' : 'text-textSecondary hover:text-textPrimary'
                )}
              >
                {a.icon}
              </button>
            </Tooltip>
          ))}
        </div>
      )}
      <div
        id={id}
        role={pressable || below ? 'dialog' : 'tooltip'}
        aria-label={pressable || below ? person.name : undefined}
        data-presence={presence}
        className="flex flex-col gap-2.5 border border-primaryStroke bg-backgroundSecondary p-3 text-sm text-textPrimary"
      >
        <span className="flex items-center gap-2.5">
          <span className="relative shrink-0">
            <Face name={person.name} version={person.avatar} className="h-8 w-8 text-sm" />
            {presence && (
              <>
                <PresenceSquare status={presence} className="border-backgroundSecondary" />
                <span className="sr-only">{PRESENCE_WORD[presence]}</span>
              </>
            )}
          </span>
          <span className="flex h-8 min-w-0 flex-1 flex-col items-start justify-center">
            <Who
              name={person.name}
              verified={person.verified}
              oauthVerified={person.oauth_verified ?? known?.oauth_verified}
              className="max-w-full text-sm font-semibold leading-4"
            />
            {(badge || presence === 'streaming') && (
              <span className="flex min-w-0 max-w-full items-center gap-2 text-xs leading-4">
                {badge && <Badge group={badge} className="min-w-0" />}
                {presence === 'streaming' && <ViewerCount count={viewers} className="shrink-0 whitespace-nowrap text-textSecondary" />}
              </span>
            )}
          </span>
        </span>
        {presence === 'streaming' ? (
          <StreamStill name={person.name} className="w-full" />
        ) : (
          <span
            id={id ? `${id}-thumb` : undefined}
            className="relative flex aspect-video w-full shrink-0 items-center justify-center overflow-hidden border border-primaryStroke bg-backgroundTertiary"
          >
            {known?.thumbs?.[0] !== undefined ? (
              <img src={api.streamThumbUrl(person.name, known.thumbs[0])} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
            ) : (
              <>
                <BlurredPicture name={person.name} version={person.avatar} />
                <span className="relative text-sm font-semibold uppercase tracking-wider text-white">offline</span>
              </>
            )}
          </span>
        )}
        {bio && <span className="line-clamp-4 break-words text-sm leading-snug">{bio}</span>}
        {below}
      </div>
    </div>,
    at.host
  );
}
