import { RiArrowDownLine, RiArrowUpLine, RiCloseLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useMemo, useState } from 'react';

import {
  addSocial,
  canEditProfileAtom,
  editSocial,
  loadMyProfile,
  moveSocial,
  profileSocialsAtom,
  profileSocialsDirtyAtom,
  profileSocialsStatusAtom,
  removeSocial,
  saveMySocials,
  setSocialsLayout,
  setSocialsSize,
  whyNotEditAtom
} from '@/infra/atoms/profile-atoms';
import {
  cleanSocials,
  EMPTY_SOCIALS,
  MAX_SOCIAL_LABEL_CHARS,
  MAX_SOCIAL_URL_CHARS,
  MAX_SOCIALS,
  SOCIAL_EXAMPLE,
  SOCIAL_KINDS,
  type SocialKind,
  type SocialLink,
  socialHref,
  type Socials as SocialsDoc,
  socialsKey,
  type SocialsLayout,
  type SocialsSize
} from '@/infra/socials';
import { store } from '@/infra/store';
import { Button } from '@/shared-components/Button';
import { ICON_BUTTON } from '@/shared-components/live/Collapsible';
import { SOCIAL_ICON, SOCIAL_ICON_PX, Socials } from '@/shared-components/Socials';
import { Tooltip } from '@/shared-components/Tooltip';
import { BUTTON, INPUT, OptionCard, SECTION_TITLE, Status } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

/** The two ways the links can sit. The card's picture is the strip in miniature. */
const LAYOUT_OPTIONS: readonly { layout: SocialsLayout; label: string; detail: string }[] = [
  { layout: 'row', label: 'a row', detail: 'the icon and the word side by side, in a line that wraps' },
  { layout: 'grid', label: 'a grid', detail: 'squares, the icon over the word, as many across as fit' }
];
/** The three sizes. The card's picture is an icon at that very size. */
const SIZE_OPTIONS: readonly { size: SocialsSize; label: string; detail: string }[] = [
  { size: 'small', label: 'small', detail: 'a line of text tall' },
  { size: 'medium', label: 'medium', detail: 'the usual' },
  { size: 'large', label: 'large', detail: 'buttons a thumb can hit' }
];
/** The kinds a sample strip shows while the list is empty. */
const SAMPLE_KINDS: readonly SocialKind[] = ['twitch', 'youtube', 'discord', 'x', 'web'];
/** A small label over a group inside the editor: Field's label type, since the box already wears the title. */
const GROUP_LABEL = 'text-sm font-semibold text-textSecondary';

/** The strip in miniature, for the layout cards: the owner's own kinds (or a sample), as a line or as squares. */
function LayoutPreview({ layout, kinds }: { layout: SocialsLayout; kinds: readonly SocialKind[] }) {
  const shown = (kinds.length > 0 ? kinds : SAMPLE_KINDS).slice(0, 6);
  return (
    <span
      aria-hidden
      className={cn(
        'flex min-w-0 flex-1 border border-primaryStroke bg-background p-2',
        layout === 'row' ? 'h-16 flex-wrap content-start gap-1' : 'grid grid-cols-3 gap-1'
      )}
    >
      {shown.map((kind, i) => {
        const Icon = SOCIAL_ICON[kind];
        return layout === 'row' ? (
          <span key={`${kind}-${i}`} className="flex h-5 items-center gap-1 border border-primaryStroke px-1">
            <Icon size={10} />
            <span className="h-1 w-5 bg-textTertiary" />
          </span>
        ) : (
          <span key={`${kind}-${i}`} className="flex flex-col items-center gap-0.5 border border-primaryStroke py-1">
            <Icon size={10} />
            <span className="h-1 w-4 bg-textTertiary" />
          </span>
        );
      })}
    </span>
  );
}

/**
 * One row of the draft: the kind's icon, the url and the words as typed, the arrows and ×.
 * All of it edits the draft; nothing here reaches the api until `save links`. A url that is
 * not a link is marked (red stroke) but kept: the save names the row instead of a 400.
 */
function LinkRow({ link, i, count, focus }: { link: SocialLink; i: number; count: number; focus: boolean }) {
  const Icon = SOCIAL_ICON[link.kind];
  const word = link.label.trim() || link.kind;
  const bad = link.url.trim() !== '' && socialHref(link.url) === null;
  return (
    <li id={`socials-row-${i}`} data-kind={link.kind} className="flex flex-wrap items-center gap-2 px-3 py-2 sm:flex-nowrap">
      <Tooltip content={link.kind}>
        <span role="img" aria-label={link.kind} className="flex h-9 w-9 shrink-0 items-center justify-center text-textSecondary">
          <Icon aria-hidden size={20} />
        </span>
      </Tooltip>
      <label htmlFor={`socials-url-${i}`} className="sr-only">
        link {i + 1}: the address
      </label>
      <input
        id={`socials-url-${i}`}
        value={link.url}
        onChange={(e) => editSocial(i, { url: e.target.value })}
        placeholder={SOCIAL_EXAMPLE[link.kind]}
        inputMode="url"
        maxLength={MAX_SOCIAL_URL_CHARS}
        autoFocus={focus}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-invalid={bad || undefined}
        className={cn(INPUT, 'min-w-0 flex-1 basis-48 py-1.5 text-sm', bad && 'border-decrease')}
      />
      <label htmlFor={`socials-label-${i}`} className="sr-only">
        link {i + 1}: the words on it
      </label>
      <input
        id={`socials-label-${i}`}
        value={link.label}
        onChange={(e) => editSocial(i, { label: e.target.value })}
        placeholder={link.kind}
        maxLength={MAX_SOCIAL_LABEL_CHARS}
        autoComplete="off"
        className={cn(INPUT, 'min-w-0 flex-1 basis-28 py-1.5 text-sm sm:max-w-[9rem]')}
      />
      <span className="flex shrink-0 items-center">
        <Tooltip content="up">
          <button id={`socials-up-${i}`} type="button" aria-label={`move ${word} up`} disabled={i === 0} onClick={() => moveSocial(i, 'up')} className={ICON_BUTTON}>
            <RiArrowUpLine aria-hidden size={16} />
          </button>
        </Tooltip>
        <Tooltip content="down">
          <button
            id={`socials-down-${i}`}
            type="button"
            aria-label={`move ${word} down`}
            disabled={i === count - 1}
            onClick={() => moveSocial(i, 'down')}
            className={ICON_BUTTON}
          >
            <RiArrowDownLine aria-hidden size={16} />
          </button>
        </Tooltip>
        <Tooltip content="remove">
          <button
            id={`socials-remove-${i}`}
            type="button"
            aria-label={`remove ${word}`}
            onClick={() => removeSocial(i)}
            className={cn(ICON_BUTTON, 'hover:border-decrease hover:text-decrease')}
          >
            <RiCloseLine aria-hidden size={16} />
          </button>
        </Tooltip>
      </span>
    </li>
  );
}

interface SocialsEditorProps {
  /** The api's rule, known before a save: a claimed name that is not my login, or a reserved one, has the boxes off. */
  canEdit: boolean;
  /** Why they are off, for the status. '' while they are on. */
  whyNot: string;
  /** `done`: the editor folds away. The draft stays where it is, saved or not. */
  onDone: () => void;
}

/**
 * The links' editor (docs/socials.md), on the owner's own page under the strip it edits: the
 * rows, the places to add one from (a square per kind: click it and a row of that kind appears
 * with its url box focused), how the links sit and how big, and one `save links`. The strip
 * above follows the draft as it is typed, so there is no preview of its own. The draft lives
 * in profile-atoms, so the editor can fold away and open again on it; one `disabled` over the
 * whole thing with `whyNot` in the status, the presence block's shape.
 */
export function SocialsEditor({ canEdit, whyNot, onDone }: SocialsEditorProps) {
  const draft = useAtomValue(profileSocialsAtom);
  const status = useAtomValue(profileSocialsStatusAtom);
  const dirty = useAtomValue(profileSocialsDirtyAtom);
  // the row added last: its url box takes focus as it appears
  const [focusRow, setFocusRow] = useState(-1);
  const kinds = useMemo(() => draft.links.map((l) => l.kind), [draft]);
  const full = draft.links.length >= MAX_SOCIALS;

  return (
    <div id="socials-editor" className="border border-primaryStroke bg-backgroundSecondary p-4">
      <fieldset disabled={!canEdit} className="m-0 border-0 p-0 disabled:opacity-60">
        <legend className={SECTION_TITLE}>your links</legend>
        <p className="mt-1 text-textSecondary">
          pick a place, paste the link. up to {MAX_SOCIALS}. the links above follow as you type; nothing is kept until <span className="font-semibold">save links</span>.
        </p>
        <div className="mt-4 flex flex-col gap-5">
          {draft.links.length === 0 ? (
            <div className="flex items-center justify-center border border-dashed border-secondaryStroke p-4 text-center text-sm text-textTertiary">
              no links yet. pick a place below and a row appears here.
            </div>
          ) : (
            <ul id="socials-list" className="m-0 list-none divide-y divide-primaryStroke border border-primaryStroke bg-background p-0">
              {draft.links.map((link, i) => (
                <LinkRow key={i} link={link} i={i} count={draft.links.length} focus={i === focusRow} />
              ))}
            </ul>
          )}

          {/* the places: a square per kind. not a form: a click makes a row, the row is where the typing goes */}
          <div className="flex flex-col gap-1.5">
            <span id="socials-kinds-label" className={GROUP_LABEL}>
              add a link
            </span>
            <div role="group" aria-labelledby="socials-kinds-label" className="flex flex-wrap gap-2">
              {SOCIAL_KINDS.map((kind) => {
                const Icon = SOCIAL_ICON[kind];
                return (
                  <Tooltip key={kind} content={kind}>
                    <button
                      id={`socials-add-${kind}`}
                      type="button"
                      aria-label={`add a ${kind} link`}
                      disabled={full}
                      onClick={() => setFocusRow(addSocial(kind))}
                      className="flex h-10 w-10 items-center justify-center border border-primaryStroke bg-background text-textSecondary transition-colors duration-150 hover:border-primaryBlue hover:text-primaryBlue focus-visible:border-primaryBlue focus-visible:outline-none disabled:cursor-default disabled:opacity-40 disabled:hover:border-primaryStroke disabled:hover:text-textSecondary"
                    >
                      <Icon aria-hidden size={20} />
                    </button>
                  </Tooltip>
                );
              })}
            </div>
            <p className="text-sm text-textTertiary">
              {full
                ? `${MAX_SOCIALS} at most. remove one first.`
                : `${draft.links.length} of ${MAX_SOCIALS}. the globe is any other site; a web row takes a place's icon when its link lands there.`}
            </p>
          </div>

          <fieldset className="m-0 border-0 p-0">
            <legend className={GROUP_LABEL}>how they sit</legend>
            <div role="presentation" className="mt-1.5 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {LAYOUT_OPTIONS.map(({ layout, label, detail }) => (
                <OptionCard
                  key={layout}
                  id={`socials-layout-${layout}`}
                  name="socials-layout"
                  checked={layout === draft.layout}
                  onChange={() => setSocialsLayout(layout)}
                  picture={<LayoutPreview layout={layout} kinds={kinds} />}
                  label={label}
                  detail={detail}
                />
              ))}
            </div>
          </fieldset>

          <fieldset className="m-0 border-0 p-0">
            <legend className={GROUP_LABEL}>how big</legend>
            <div role="presentation" className="mt-1.5 grid grid-cols-1 gap-4 sm:grid-cols-3">
              {SIZE_OPTIONS.map(({ size, label, detail }) => {
                const Icon = SOCIAL_ICON[kinds[0] ?? 'twitch'];
                return (
                  <OptionCard
                    key={size}
                    id={`socials-size-${size}`}
                    name="socials-size"
                    checked={size === draft.size}
                    onChange={() => setSocialsSize(size)}
                    picture={
                      <span className="flex h-10 items-center">
                        <Icon aria-hidden size={SOCIAL_ICON_PX[size]} />
                      </span>
                    }
                    label={label}
                    detail={detail}
                  />
                );
              })}
            </div>
          </fieldset>
        </div>
      </fieldset>

      {/* outside the fieldset: `done` works whether or not the boxes are on */}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button id="socials-save" variant="primary" flat className={BUTTON} disabled={!canEdit} onClick={() => void saveMySocials()}>
          save links
        </Button>
        <Button id="socials-done" flat className={BUTTON} onClick={onDone}>
          done
        </Button>
        <Status id="socials-status" text={status || (canEdit ? (dirty ? 'changed. save to keep it.' : '') : whyNot)} />
      </div>
    </div>
  );
}

/**
 * The draft as the strip draws it while the editor is open: every url as the save will send it
 * (`https://` in front of a bare host, `saveMySocials`'s rule), a row that is not a link yet
 * left out, then the page's own check, as for a document the api sent.
 */
function draftAsShown(draft: SocialsDoc): SocialsDoc {
  const links: SocialLink[] = [];
  for (const link of draft.links) {
    const url = socialHref(link.url);
    if (url) links.push({ kind: link.kind, url, label: link.label.trim() });
  }
  return cleanSocials({ ...draft, links });
}

interface SocialsTabProps {
  /** Whose page. */
  name: string;
  /** Their links as the grant gave them (watch-atoms), already through `cleanSocials`. */
  doc: SocialsDoc;
  /** My own page: the strip offers the editor, which opens under it. */
  mine: boolean;
}

/**
 * The socials tab under the player (docs/socials.md): the strip, and on my own page the
 * editor under it. While the editor is open the strip is the draft as the save will keep it
 * (a row that is not a link yet is left out), so what is being edited is what is on the page;
 * `done` folds the editor and the strip is the saved document again (the draft is kept for the
 * next time). Opening it loads my profile, so the draft and the api's rule are the name's I am.
 */
export function SocialsTab({ name, doc, mine }: SocialsTabProps) {
  const [opened, setOpened] = useState(false);
  const draft = useAtomValue(profileSocialsAtom);
  const canEdit = useAtomValue(canEditProfileAtom);
  const whyNot = useAtomValue(whyNotEditAtom);
  // not my page any more (a log out, a new nick): the editor goes with it
  const editing = opened && mine;
  const shown = useMemo(() => (editing ? draftAsShown(draft) : doc), [editing, draft, doc]);

  const open = () => {
    // the page's document seeds an untouched draft, so the strip does not blink out while my profile loads
    if (socialsKey(store.get(profileSocialsAtom)) === socialsKey(EMPTY_SOCIALS)) store.set(profileSocialsAtom, doc);
    void loadMyProfile();
    setOpened(true);
  };

  return (
    <div className="flex flex-col gap-5">
      {/* an empty draft while editing: the editor's own box says so, not two of them */}
      {(!editing || shown.links.length > 0) && <Socials name={name} doc={shown} onEdit={mine && !editing ? open : undefined} />}
      {editing && <SocialsEditor canEdit={canEdit} whyNot={whyNot} onDone={() => setOpened(false)} />}
    </div>
  );
}
