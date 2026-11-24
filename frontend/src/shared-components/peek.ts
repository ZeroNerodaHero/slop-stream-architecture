import { type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useRef, useState } from 'react';

import type { GroupBadge } from '@/infra/api';
import type { Presence } from '@/infra/atoms/presence-atoms';

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
