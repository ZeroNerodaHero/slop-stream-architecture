import { type ClipboardEvent, type DragEvent, type FormEvent, type MouseEvent, type PointerEvent, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/shared-components/Button';
import { INPUT } from '@/shared-components/input';
import { SHEET_DIALOG, SheetGrab, useSheetBack } from '@/shared-components/MobileSheet';
import { cn } from '@/utils/cn';

/** Short plain words for the phrase: two of them, picked fresh on each open. */
const WORDS = [
  'amber',
  'falcon',
  'river',
  'pickle',
  'maple',
  'copper',
  'lantern',
  'meadow',
  'otter',
  'pebble',
  'thistle',
  'walnut',
  'harbor',
  'cactus',
  'velvet',
  'ember',
  'willow',
  'badger',
  'canyon',
  'cobalt',
  'fennel',
  'glacier',
  'hazel',
  'island',
  'juniper',
  'kettle',
  'lemon',
  'marble',
  'nutmeg',
  'orchid',
  'parrot',
  'quartz',
  'raven',
  'saffron',
  'tundra',
  'umber',
  'violet',
  'wren',
  'yarrow',
  'zephyr',
  'anchor',
  'biscuit',
  'cedar',
  'dune',
  'ferret',
  'garnet',
  'heron',
  'iris',
  'jasper',
  'moss'
];

function pickPhrase(): string {
  const first = Math.floor(Math.random() * WORDS.length);
  // the second from the rest, so the two are never the same word
  const second = (first + 1 + Math.floor(Math.random() * (WORDS.length - 1))) % WORDS.length;
  return `${WORDS[first]} ${WORDS[second]}`;
}

interface TypeToConfirmProps {
  /** The ids the tests key on: `<id>`, `<id>-title`, `<id>-message`, `<id>-phrase`, `<id>-input`, `<id>-yes`, `<id>-no`. */
  id: string;
  /** The question, as the heading. */
  title: string;
  /** What a yes does, spelled out. */
  message: string;
  /** The yes button's word ("delete"). The other one says "cancel". */
  yes: string;
  onYes: () => void;
  /** Cancel, escape, a click on the backdrop, or the question taken away unanswered. */
  onNo: () => void;
}

/**
 * ConfirmDialog for the worst of them (deleting a group): the yes stays off until two random
 * words are typed back. The words are new on every open and cannot be copied or pasted, so
 * the yes takes reading them. Mounted = asked, portalled onto the page like ConfirmDialog: a
 * modal inside a modal closes the outer one with it.
 */
export function TypeToConfirm(props: TypeToConfirmProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setHost(anchor.current?.ownerDocument.body ?? null);
  }, []);
  return (
    <>
      <span ref={anchor} hidden />
      {host && createPortal(<TypeBox {...props} />, host)}
    </>
  );
}

const stop = (e: ClipboardEvent | DragEvent | MouseEvent) => e.preventDefault();

function TypeBox({ id, title, message, yes, onYes, onNo }: TypeToConfirmProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  /** Yes was pressed: the `close` that follows is a yes. Anything else is a no. */
  const saidYes = useRef(false);
  /** The press that began this click was on the backdrop too: a drag that ends outside is not a no. */
  const pressedBackdrop = useRef(false);
  const [phrase] = useState(pickPhrase);
  const [typed, setTyped] = useState('');
  const matches = typed.trim() === phrase;

  // as ConfirmDialog's: the cleanup runs while the node is still in the document, and a question taken away unanswered is a no
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    dialog.querySelector<HTMLElement>(`#${CSS.escape(id)}-input`)?.focus();
    return () => {
      if (!dialog.open) return;
      dialog.close();
      onNo();
    };
  }, []);

  const close = () => dialogRef.current?.close();
  useSheetBack(close);
  const onPointerDown = (e: PointerEvent<HTMLDialogElement>) => {
    pressedBackdrop.current = e.target === e.currentTarget;
  };
  const onClick = (e: MouseEvent<HTMLDialogElement>) => {
    if (pressedBackdrop.current && e.target === e.currentTarget) close();
  };
  // enter, or the yes button: only once the words match
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!matches) return;
    saidYes.current = true;
    close();
  };

  return (
    <dialog
      ref={dialogRef}
      id={id}
      data-sheet=""
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-message`}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onClose={(event) => {
        event.stopPropagation();
        if (saidYes.current) onYes();
        else onNo();
      }}
      className={cn(
        'm-auto w-[min(420px,calc(100vw-3rem))] border border-primaryStroke bg-backgroundSecondary p-6 text-base text-textPrimary backdrop:bg-black/60',
        SHEET_DIALOG
      )}
    >
      <SheetGrab onDismiss={close} />
      <h2 id={`${id}-title`} className="border-l-4 border-primaryBlue pl-3 text-xl font-semibold leading-tight">
        {title}
      </h2>
      <p id={`${id}-message`} className="mt-4 text-textSecondary">
        {message}
      </p>
      <form onSubmit={onSubmit} className="mt-4">
        <label htmlFor={`${id}-input`} className="block text-sm text-textSecondary">
          type{' '}
          <span
            id={`${id}-phrase`}
            draggable={false}
            onCopy={stop}
            onCut={stop}
            onContextMenu={stop}
            onDragStart={stop}
            className="select-none whitespace-nowrap border border-primaryStroke bg-background px-2 py-0.5 font-mono font-semibold text-textPrimary"
          >
            {phrase}
          </span>{' '}
          to delete
        </label>
        <input
          id={`${id}-input`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onPaste={stop}
          onDrop={stop}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="phrase"
          className={cn(INPUT, 'mt-3')}
        />
        <div className="mt-6 flex items-center justify-end gap-3">
          <Button id={`${id}-no`} size="sm" onClick={close}>
            cancel
          </Button>
          <Button id={`${id}-yes`} type="submit" size="sm" variant="danger" disabled={!matches}>
            {yes}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
