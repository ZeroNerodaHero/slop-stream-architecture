import { useAtomValue } from 'jotai';
import { useState } from 'react';

import { chars } from '@/infra/atoms/chat-atoms';
import {
  canEditProfileAtom,
  profileWelcomeAtom,
  profileWelcomeDraftAtom,
  profileWelcomeStatusAtom,
  saveMyWelcome,
  whyNotEditAtom
} from '@/infra/atoms/profile-atoms';
import { DEFAULT_WELCOME, MAX_WELCOME_CHARS } from '@/infra/atoms/welcome-atoms';
import { store } from '@/infra/store';
import { Button } from '@/shared-components/Button';
import { EquesLine } from '@/shared-components/ChatPanel';
import { INPUT } from '@/shared-components/input';
import { CHECKBOX, SECTION_TITLE, Status } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

/** What the welcome is, by its title in both places. */
export const WELCOME_TIP = 'Eques says it in your chat to each viewer who opens it. only they see it, and it is never sent';

/**
 * My chat welcome (welcome-atoms.ts), the editor: the bot Eques says it at the top of my chat to
 * whoever opens it, on their screen alone. The switch saves at once, with the words as saved; the
 * words save with the button. Under them, the line as Eques says it, the draft's words in the
 * chat's shape. In the profile tab and in my page's mod tab, the one set of atoms (profile-atoms.ts)
 * behind both, so a save in one shows in the other. `id` tells their elements apart; the caller
 * loads my profile (`loadMyProfile`) and draws the title.
 */
export function WelcomeEditor({ id }: { id: string }) {
  const welcome = useAtomValue(profileWelcomeAtom);
  const draft = useAtomValue(profileWelcomeDraftAtom);
  const status = useAtomValue(profileWelcomeStatusAtom);
  const canEdit = useAtomValue(canEditProfileAtom);
  const whyNot = useAtomValue(whyNotEditAtom);
  const left = MAX_WELCOME_CHARS - chars(draft.trim());
  const on = welcome?.on ?? true;
  const [at] = useState(() => Date.now());

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={`${id}-on`} className="flex items-center gap-2 py-1.5 text-sm font-semibold text-textPrimary max-md:min-h-11">
          <input
            id={`${id}-on`}
            type="checkbox"
            checked={on}
            disabled={!canEdit}
            onChange={(e) => void saveMyWelcome(e.target.checked, welcome?.message ?? DEFAULT_WELCOME)}
            className={CHECKBOX}
          />
          eques welcome
        </label>
        <span id={`${id}-count`} className={cn('text-sm tabular-nums text-textTertiary', left < 20 && 'text-decrease')}>
          {left}
        </span>
      </div>
      <textarea
        id={id}
        value={draft}
        onChange={(e) => {
          store.set(profileWelcomeDraftAtom, e.target.value);
          if (store.get(profileWelcomeStatusAtom)) store.set(profileWelcomeStatusAtom, '');
        }}
        aria-label="welcome message"
        placeholder="welcome"
        rows={3}
        maxLength={MAX_WELCOME_CHARS}
        disabled={!canEdit || !on}
        aria-describedby={`${id}-count`}
        className={cn(INPUT, 'mt-2 block w-full resize-y py-1.5')}
      />
      {/* the preview: an empty box is the default words, as the api keeps it; off, the line is dimmed and nobody sees it */}
      <div id={`${id}-preview`} className="mt-3 flex flex-col">
        <div className="flex items-center justify-between gap-3">
          <span className={SECTION_TITLE}>{on ? 'in your chat' : 'off: nobody sees it'}</span>
          <Button id={`${id}-save`} size="sm" variant="outline" disabled={!canEdit || !on} onClick={() => void saveMyWelcome(on, draft)}>
            save
          </Button>
        </div>
        <Status id={`${id}-status`} text={status || (canEdit ? '' : whyNot)} quiet />
        <div role="group" aria-label="preview" className={cn('mt-2 border border-primaryStroke bg-background px-2 py-1.5 text-sm leading-snug', !on && 'opacity-50')}>
          <EquesLine message={draft.trim() || DEFAULT_WELCOME} at={at} attrs={{ id: `${id}-line`, 'data-preview': true }} />
        </div>
      </div>
    </>
  );
}
