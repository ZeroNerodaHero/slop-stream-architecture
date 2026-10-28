import { useAtomValue } from 'jotai';
import { useState } from 'react';

import { chars } from '@/infra/atoms/chat-atoms';
import { canEditProfileAtom, loadMyProfile, MAX_ABOUT_CHARS, profileAboutAtom, profileAboutStatusAtom, saveMyAbout, whyNotEditAtom } from '@/infra/atoms/profile-atoms';
import { store } from '@/infra/store';
import { buttonClassName } from '@/shared-components/Button';
import { INPUT, SECTION_TITLE, Status } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

interface AboutMeProps {
  /** The words as the grant gave them (watch-atoms' `aboutAtom`). '' for none. */
  text: string;
  /** My own page: the words offer the editor, which opens in their place. */
  mine: boolean;
}

/**
 * About me (docs/about.md): the words first on the about tab, a few paragraphs about them. On
 * my own page they are edited right here, in their place: `edit` (or `write it`, with none yet)
 * swaps the paragraph for the box, `save` keeps it and the paragraph has it the moment the
 * status says so, `done` folds the box away (the draft stays in profile-atoms for next time).
 * Opening it loads my profile, so the draft and the api's rule are the name's I am. Not my
 * page and nothing written: nothing here, the rest of the tab follows.
 */
export function AboutMe({ text, mine }: AboutMeProps) {
  const [opened, setOpened] = useState(false);
  const draft = useAtomValue(profileAboutAtom);
  const status = useAtomValue(profileAboutStatusAtom);
  const canEdit = useAtomValue(canEditProfileAtom);
  const whyNot = useAtomValue(whyNotEditAtom);
  // not my page any more (a log out, a new nick): the box goes with it
  const editing = opened && mine;

  const open = () => {
    // the page's words seed an untouched draft, so the box does not open empty while my profile loads
    if (!store.get(profileAboutAtom)) store.set(profileAboutAtom, text);
    void loadMyProfile();
    setOpened(true);
  };

  if (editing) {
    const left = MAX_ABOUT_CHARS - chars(draft);
    return (
      <div id="about-me-editor" className="mb-4 border border-primaryStroke bg-backgroundSecondary p-4">
        <fieldset disabled={!canEdit} className="m-0 border-0 p-0 disabled:opacity-60">
          <legend className={SECTION_TITLE}>about me</legend>
          <p className="mt-1 text-textSecondary">a few lines about you, first on this tab. paragraphs stay. nothing is kept until save; empty takes it off.</p>
          <label htmlFor="about-me-text" className="sr-only">
            about me
          </label>
          <textarea
            id="about-me-text"
            value={draft}
            onChange={(e) => {
              store.set(profileAboutAtom, e.target.value);
              if (store.get(profileAboutStatusAtom)) store.set(profileAboutStatusAtom, '');
            }}
            placeholder="who you are. what the stream is. when you are usually on."
            maxLength={MAX_ABOUT_CHARS}
            className={cn(INPUT, 'mt-4 min-h-[160px] resize-y')}
          />
        </fieldset>
        {/* outside the fieldset: `done` works whether or not the box is on */}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button id="about-me-save" type="button" className="text-base font-semibold text-primaryBlue disabled:opacity-40" disabled={!canEdit} onClick={() => void saveMyAbout()}>
            save
          </button>
          <button id="about-me-done" type="button" className="text-base font-semibold text-textTertiary" onClick={() => setOpened(false)}>
            done
          </button>
          <span id="about-me-count" className={cn('text-sm tabular-nums text-textTertiary', left < 100 && 'text-decrease')}>
            {left}
          </span>
          <Status id="about-me-status" text={status || (canEdit ? '' : whyNot)} />
        </div>
      </div>
    );
  }

  if (!text) {
    if (!mine) return null;
    return (
      <div id="about-me" data-empty className="mb-4 flex flex-wrap items-center gap-3 text-textSecondary">
        <p>nothing here yet. a few lines about you, first on this tab: who you are, what the stream is.</p>
        <button id="about-me-edit" type="button" onClick={open} className={buttonClassName('primary', 'px-3 py-1.5 text-sm', true)}>
          write it
        </button>
      </div>
    );
  }

  return (
    <div className="mb-4">
      <p id="about-me" className="whitespace-pre-wrap text-textSecondary [overflow-wrap:anywhere]">
        {text}
      </p>
      {mine && (
        <p className="mt-2 text-sm text-textTertiary">
          yours.{' '}
          <button id="about-me-edit" type="button" onClick={open} className="text-primaryBlue underline-offset-2 hover:underline">
            edit it
          </button>
        </p>
      )}
    </div>
  );
}
