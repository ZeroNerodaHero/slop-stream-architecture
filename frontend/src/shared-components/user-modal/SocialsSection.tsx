import { RiArrowDownLine, RiArrowUpLine, RiCloseLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useMemo, useState } from 'react';

import {
  addSocial,
  editSocial,
  moveSocial,
  profileSocialsAtom,
  profileSocialsDirtyAtom,
  profileSocialsStatusAtom,
  removeSocial,
  saveMySocials,
  setSocialsLayout,
  setSocialsSize
} from '@/infra/atoms/profile-atoms';
import {
  cleanSocials,
  MAX_SOCIAL_LABEL_CHARS,
  MAX_SOCIAL_URL_CHARS,
  MAX_SOCIALS,
  SOCIAL_EXAMPLE,
  SOCIAL_KINDS,
  type SocialKind,
  type SocialLink,
  socialHref,
  type SocialsLayout,
  type SocialsSize
} from '@/infra/socials';
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
/** A small label over a group inside the section: Field's label type, since the section already wears the title. */
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
    <li id={`profile-social-${i}`} data-kind={link.kind} className="flex flex-wrap items-center gap-2 px-3 py-2 sm:flex-nowrap">
      <Tooltip content={link.kind}>
        <span role="img" aria-label={link.kind} className="flex h-9 w-9 shrink-0 items-center justify-center text-textSecondary">
          <Icon aria-hidden size={20} />
        </span>
      </Tooltip>
      <label htmlFor={`profile-social-url-${i}`} className="sr-only">
        link {i + 1}: the address
      </label>
      <input
        id={`profile-social-url-${i}`}
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
      <label htmlFor={`profile-social-label-${i}`} className="sr-only">
        link {i + 1}: the words on it
      </label>
      <input
        id={`profile-social-label-${i}`}
        value={link.label}
        onChange={(e) => editSocial(i, { label: e.target.value })}
        placeholder={link.kind}
        maxLength={MAX_SOCIAL_LABEL_CHARS}
        autoComplete="off"
        className={cn(INPUT, 'min-w-0 flex-1 basis-28 py-1.5 text-sm sm:max-w-[9rem]')}
      />
      <span className="flex shrink-0 items-center">
        <Tooltip content="up">
          <button
            id={`profile-social-up-${i}`}
            type="button"
            aria-label={`move ${word} up`}
            disabled={i === 0}
            onClick={() => moveSocial(i, 'up')}
            className={ICON_BUTTON}
          >
            <RiArrowUpLine aria-hidden size={16} />
          </button>
        </Tooltip>
        <Tooltip content="down">
          <button
            id={`profile-social-down-${i}`}
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
            id={`profile-social-remove-${i}`}
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

/**
 * The profile tab's `links` section (docs/socials.md): the rows, the places to add one from
 * (a square per kind: click it and a row of that kind appears with its url box focused), how
 * the links sit and how big, the strip as the page will draw it, and one `save links`. The
 * draft lives in profile-atoms, so the modal can close and open again on it; the presence
 * block's shape, one `disabled` over the whole thing with `whyNot` in the status.
 */
export function SocialsSection({ name, canEdit, whyNot }: { name: string; canEdit: boolean; whyNot: string }) {
  const draft = useAtomValue(profileSocialsAtom);
  const status = useAtomValue(profileSocialsStatusAtom);
  const dirty = useAtomValue(profileSocialsDirtyAtom);
  // the row added last: its url box takes focus as it appears
  const [focusRow, setFocusRow] = useState(-1);
  // the strip as the page will draw it: a row that is not a link yet is left out, as the page would
  const preview = useMemo(() => cleanSocials(draft), [draft]);
  const kinds = useMemo(() => draft.links.map((l) => l.kind), [draft]);
  const full = draft.links.length >= MAX_SOCIALS;

  return (
    <fieldset id="profile-socials" disabled={!canEdit} className="m-0 border-0 p-0 py-6 first:pt-0 last:pb-0 disabled:opacity-60">
      <legend className={SECTION_TITLE}>links</legend>
      <p className="mt-1 text-textSecondary">
        where else to find you: the <span className="font-semibold">socials</span> tab on your stream&apos;s page, under the player. pick a place, paste the link. up to{' '}
        {MAX_SOCIALS}.
      </p>
      <div className="mt-4 flex flex-col gap-5">
        {draft.links.length === 0 ? (
          <div className="flex items-center justify-center border border-dashed border-secondaryStroke p-4 text-center text-sm text-textTertiary">
            no links yet. pick a place below and a row appears here.
          </div>
        ) : (
          <ul id="profile-socials-list" className="m-0 list-none divide-y divide-primaryStroke border border-primaryStroke bg-background p-0">
            {draft.links.map((link, i) => (
              <LinkRow key={i} link={link} i={i} count={draft.links.length} focus={i === focusRow} />
            ))}
          </ul>
        )}

        {/* the places: a square per kind. not a form: a click makes a row, the row is where the typing goes */}
        <div className="flex flex-col gap-1.5">
          <span id="profile-social-kinds-label" className={GROUP_LABEL}>
            add a link
          </span>
          <div role="group" aria-labelledby="profile-social-kinds-label" className="flex flex-wrap gap-2">
            {SOCIAL_KINDS.map((kind) => {
              const Icon = SOCIAL_ICON[kind];
              return (
                <Tooltip key={kind} content={kind}>
                  <button
                    id={`profile-social-add-${kind}`}
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
                id={`profile-socials-layout-${layout}`}
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
                  id={`profile-socials-size-${size}`}
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

        {/* the strip as the page draws it, from the same component, live as you edit */}
        <div className="flex flex-col gap-1.5">
          <span className={GROUP_LABEL}>on your page</span>
          <div id="profile-socials-preview" className="border border-primaryStroke bg-background p-4">
            <Socials id="profile-socials-preview-links" name={name} doc={preview} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button id="profile-save-socials" variant="primary" className={BUTTON} disabled={!canEdit} onClick={() => void saveMySocials()}>
            save links
          </Button>
          <Status id="profile-socials-status" text={status || (canEdit ? (dirty ? 'changed. save to keep it.' : '') : whyNot)} />
        </div>
      </div>
    </fieldset>
  );
}
