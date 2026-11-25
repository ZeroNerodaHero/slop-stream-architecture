import { useEffect, useRef, useState } from 'react';

import { api, messageOf } from '@/infra/api';
import { cropNamedPicture } from '@/infra/atoms/crop-atoms';
import { EMOTE_NAME, EMOTE_NAME_RULE, emoteSrc, type GroupEmote, loadMyEmotes, MAX_EMOTES } from '@/infra/emotes';
import { EMOTE_PICTURE } from '@/infra/picture';
import { Button } from '@/shared-components/Button';
import { ConfirmDialog } from '@/shared-components/ConfirmDialog';
import { INPUT } from '@/shared-components/input';
import { Section } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

export function cleanEmoteName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 32);
}

function nameFromFile(file: File): string {
  const name = cleanEmoteName(file.name.replace(/\.[^.]*$/, '')).replace(/^_+|_+$/g, '');
  return EMOTE_NAME.test(name) ? name : '';
}

function nameFault(name: string, taken: readonly GroupEmote[], self?: string): string | null {
  if (!EMOTE_NAME.test(name)) return `a name is ${EMOTE_NAME_RULE}`;
  if (taken.some((e) => e.name === name && e.id !== self)) return 'that name is taken in this group';
  return null;
}

export function EmotesSection({ server }: { server: string }) {
  const [emotes, setEmotes] = useState<GroupEmote[] | null>(null);
  const [max, setMax] = useState(MAX_EMOTES);
  const [error, setError] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<GroupEmote | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function load() {
    try {
      const answer = await api.groupEmotes(server);
      setEmotes(answer.emotes);
      setMax(answer.max);
    } catch (err) {
      setError(messageOf(err));
    }
  }

  useEffect(() => {
    let gone = false;
    api.groupEmotes(server).then(
      (answer) => {
        if (gone) return;
        setEmotes(answer.emotes);
        setMax(answer.max);
      },
      (err) => {
        if (!gone) setError(messageOf(err));
      }
    );
    return () => {
      gone = true;
    };
  }, [server]);

  async function act(work: () => Promise<unknown>) {
    setError('');
    try {
      await work();
      await Promise.all([load(), loadMyEmotes()]);
    } catch (err) {
      setError(messageOf(err));
    }
  }

  async function pick(file: File) {
    const list = emotes ?? [];
    const saved = await cropNamedPicture(file, EMOTE_PICTURE, {
      initial: nameFromFile(file),
      rule: `${EMOTE_NAME_RULE}. it is typed as :name: in the chat`,
      clean: cleanEmoteName,
      fault: (name) => nameFault(name, list),
      save: async (picture, name) => {
        await api.uploadEmote(server, picture, name);
      }
    });
    if (saved) await act(async () => undefined);
  }

  const count = emotes?.length ?? 0;
  const full = count >= max;

  return (
    <Section
      id="manage-emotes"
      title="emotes"
      description={`pictures anyone in the group can put in a line or react with, as :name:. png, jpeg or webp; it is cut square and made ${EMOTE_PICTURE.size?.width}px.`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={fileRef}
          id="emote-file"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void pick(file);
          }}
        />
        <Button id="emote-add" size="sm" variant="outline" disabled={emotes === null || full} onClick={() => fileRef.current?.click()}>
          add emote
        </Button>
        <span id="emote-count" className={cn('tabular-nums text-textSecondary', full && 'text-decrease')} aria-live="polite">
          {count}/{max}
        </span>
      </div>
      <p id="emote-error" aria-live="polite" className={cn('text-sm text-decrease', !error && 'sr-only')}>
        {error}
      </p>
      {emotes === null ? (
        <p className="text-textTertiary">{error ? '' : 'reading the emotes…'}</p>
      ) : emotes.length === 0 ? (
        <p className="text-textTertiary">no emotes yet.</p>
      ) : (
        <ul id="emote-list" className="flex flex-col divide-y divide-primaryStroke overflow-hidden rounded-card border border-primaryStroke">
          {emotes.map((emote) => {
            const editing = renaming?.id === emote.id ? renaming : null;
            const fault = editing ? nameFault(editing.name, emotes, emote.id) : null;
            return (
              <li key={emote.id} data-emote={emote.name} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <img src={emoteSrc(emote.id)} alt="" className="h-8 w-8 shrink-0 object-contain" />
                {editing ? (
                  <form
                    className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (fault) {
                        setError(fault);
                        return;
                      }
                      const name = editing.name;
                      setRenaming(null);
                      if (name !== emote.name) void act(() => api.renameEmote(server, emote.id, name));
                    }}
                  >
                    <label htmlFor={`emote-rename-${emote.id}`} className="sr-only">
                      new name for :{emote.name}:
                    </label>
                    <input
                      id={`emote-rename-${emote.id}`}
                      value={editing.name}
                      onChange={(e) => setRenaming({ id: emote.id, name: cleanEmoteName(e.target.value) })}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          e.stopPropagation();
                          setRenaming(null);
                        }
                      }}
                      placeholder="name"
                      maxLength={32}
                      autoComplete="off"
                      spellCheck={false}
                      autoFocus
                      aria-describedby={`emote-rename-${emote.id}-hint`}
                      className={cn(INPUT, 'w-48 min-w-0 flex-1')}
                    />
                    <Button type="submit" size="sm" variant="outline" disabled={fault !== null}>
                      save
                    </Button>
                    <Button size="sm" onClick={() => setRenaming(null)}>
                      cancel
                    </Button>
                    <p id={`emote-rename-${emote.id}-hint`} className={cn('w-full text-xs', fault ? 'text-decrease' : 'text-textTertiary')}>
                      {fault ?? EMOTE_NAME_RULE}
                    </p>
                  </form>
                ) : (
                  <>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">:{emote.name}:</span>
                      <span className="block truncate text-xs text-textTertiary">{emote.by ? `by ${emote.by}` : 'by a gone account'}</span>
                    </span>
                    <Button size="sm" data-emote-rename={emote.name} onClick={() => setRenaming({ id: emote.id, name: emote.name })}>
                      rename
                    </Button>
                    <Button size="sm" variant="outline-danger" data-emote-delete={emote.name} onClick={() => setDeleting(emote)}>
                      delete
                    </Button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {deleting && (
        <ConfirmDialog
          id="emote-delete-confirm"
          title={`delete :${deleting.name}:?`}
          message="the lines that used it show its :name: from now on, and its reactions go."
          yes="delete"
          onYes={() => {
            const emote = deleting;
            setDeleting(null);
            void act(() => api.deleteEmote(server, emote.id));
          }}
          onNo={() => setDeleting(null)}
        />
      )}
    </Section>
  );
}
