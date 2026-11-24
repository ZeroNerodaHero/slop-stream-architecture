import { type CSSProperties, type ReactNode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import '@/app/globals.css';
import { Select, type SelectOption } from '@/shared-components/Select';

const CAMERAS: SelectOption[] = [
  { value: '', label: "the browser's camera" },
  { value: 'mac', label: 'MacBook Pro Camera' },
  { value: 'honda', label: '1988 Honda Accord CA5 Sedan Camera' },
  { value: 'desk', label: 'MacBook Pro Desk View Camera' },
  { value: 'honda-desk', label: '1988 Honda Accord CA5 Sedan Desk View Camera' }
];
const WORDS: SelectOption[] = [
  { value: 'alpha', label: 'alpha' },
  { value: 'bravo', label: 'bravo', disabled: true },
  { value: 'charlie', label: 'charlie' },
  { value: 'delta', label: 'delta' },
  { value: 'desk', label: 'desk lamp' },
  { value: 'echo', label: 'echo' }
];
const MANY: SelectOption[] = Array.from({ length: 30 }, (_, i) => ({
  value: `n${i + 1}`,
  label: i === 11 ? 'option 12, which is the longest of the thirty by a long way' : `option ${i + 1}`
}));

interface FixtureProps {
  id: string;
  options: SelectOption[];
  first: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
}

function Fixture({ id, options, first, className, placeholder, disabled }: FixtureProps) {
  const [value, setValue] = useState(first);
  const [changes, setChanges] = useState(0);
  return (
    <span id={`${id}-wrap`} data-changes={changes} style={{ display: 'flex', minWidth: 0, flex: 1 }}>
      <Select
        id={id}
        label={`the ${id} picker`}
        value={value}
        options={options}
        placeholder={placeholder}
        disabled={disabled}
        className={className}
        onChange={(next) => {
          setValue(next);
          setChanges((n) => n + 1);
        }}
      />
    </span>
  );
}

function Row({ style, className, children }: { style?: CSSProperties; className?: string; children: ReactNode }) {
  return (
    <div className={className} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, ...style }}>
      {children}
    </div>
  );
}

function Harness() {
  const dialog = useRef<HTMLDialogElement | null>(null);
  return (
    <div style={{ padding: 16, height: 1600 }}>
      <Row style={{ width: 220 }} className="text-xs text-textSecondary">
        <input id="before" aria-label="before" style={{ width: 20 }} />
        <span style={{ flexShrink: 0 }}>reads</span>
        <Fixture id="plain" options={CAMERAS} first="" className="min-w-0 flex-1" />
        <input id="after" aria-label="after" style={{ width: 20 }} />
      </Row>
      <Row style={{ width: 260 }} className="text-base">
        <Fixture id="keys" options={WORDS} first="alpha" className="w-full" />
      </Row>
      <Row style={{ width: 260 }} className="text-sm">
        <Fixture id="long" options={MANY} first="n20" className="w-full" />
      </Row>
      <Row style={{ width: 360 }} className="text-sm">
        <Fixture id="off" options={WORDS} first="alpha" disabled />
        <Fixture id="none" options={WORDS} first="nothing" placeholder="pick a word" />
      </Row>
      <div id="pane" style={{ width: 300, height: 90, overflow: 'auto', marginBottom: 12 }} className="border border-primaryStroke text-sm">
        <div style={{ height: 200 }} />
        <Row style={{ padding: '0 8px' }}>
          <Fixture id="paned" options={WORDS} first="alpha" />
        </Row>
        <div style={{ height: 200 }} />
      </div>
      <Row className="text-sm">
        <button id="open-dialog" type="button" className="font-semibold text-primaryBlue" onClick={() => dialog.current?.showModal()}>
          open the dialog
        </button>
        <button id="keeps-focus" type="button" className="text-textTertiary" onMouseDown={(e) => e.preventDefault()}>
          a press here moves no focus
        </button>
      </Row>
      <dialog
        ref={dialog}
        id="dialog"
        className="m-auto w-[min(420px,calc(100vw-3rem))] border border-primaryStroke bg-backgroundSecondary p-6 text-base text-textPrimary backdrop:bg-black/60"
      >
        <Row>
          <Fixture id="dialoged" options={WORDS} first="alpha" className="w-full" />
        </Row>
      </dialog>
      <div style={{ position: 'fixed', left: 16, bottom: 8, display: 'flex' }} className="text-sm">
        <Fixture id="foot" options={WORDS} first="alpha" />
      </div>
      <div style={{ position: 'fixed', right: 4, top: 8, width: 90, display: 'flex' }} className="text-xs">
        <Fixture id="edge" options={CAMERAS} first="" className="min-w-0 flex-1" />
      </div>
    </div>
  );
}

createRoot(document.getElementById('probe')!).render(<Harness />);
