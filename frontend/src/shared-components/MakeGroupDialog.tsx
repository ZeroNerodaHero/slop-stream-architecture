import { useQueryClient } from '@tanstack/react-query';
import { useAtomValue } from 'jotai';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type MouseEvent, type PointerEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '@/infra/api';
import { cropPicture } from '@/infra/atoms/crop-atoms';
import { createGroup, groupsBusyAtom, groupsStatusAtom } from '@/infra/atoms/groups-atoms';
import { cleanName, isValidName } from '@/infra/names';
import { GROUP_BANNER, GROUP_ICON } from '@/infra/picture';
import { Badge } from '@/shared-components/Badge';
import { Button } from '@/shared-components/Button';
import { GroupMark } from '@/shared-components/GroupMark';
import { INPUT } from '@/shared-components/input';
import { SHEET_DIALOG, SheetGrab, focusOnOpen, useSheetBack } from '@/shared-components/MobileSheet';
import { PicturePick } from '@/shared-components/PicturePick';
import { Tooltip } from '@/shared-components/Tooltip';
import { VisibilityToggle } from '@/shared-components/VisibilityToggle';
import { cn } from '@/utils/cn';

/** The api's caps, as the boxes know them. */
const MAX_BADGE_CHARS = 12;
const MAX_ABOUT_CHARS = 200;
/** The colours a new group starts from, by name (the tooltip says the colour, not its hex): discord's blurple, then the fake streams' box colours. The colour box takes any other. */
const SWATCHES = [
  { hex: '#5865f2', name: 'blurple' },
  { hex: '#f85149', name: 'red' },
  { hex: '#3fb950', name: 'green' },
  { hex: '#f2cc60', name: 'yellow' },
  { hex: '#bc8cff', name: 'purple' },
  { hex: '#ff9f43', name: 'orange' },
  { hex: '#39d2c0', name: 'teal' },
  { hex: '#ff6bcb', name: 'pink' }
] as const;

/** A picture chosen before the group exists: the bytes the crop dialog made, and a url that shows them here. */
interface Picked {
  blob: Blob;
  url: string;
}

/**
 * The dialog that makes a group (docs/groups.md): the name, the word on the badge, a colour,
 * a line about it, public or private, and the banner and the picture, each through the crop
 * dialog and shown here as they will sit on the group. `make it` posts the group, puts the
 * pictures on it, and goes to the new room. Home and `/groups` open it, for a login under the
 * cap on owned groups (`groups_per_owner`, the api's); past it the api says so here.
 */
export function MakeGroupDialog({ onClose }: { onClose: () => void }) {
  const busy = useAtomValue(groupsBusyAtom);
  const status = useAtomValue(groupsStatusAtom);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const pressedBackdrop = useRef(false);
  const [name, setName] = useState('');
  const [badge, setBadge] = useState('');
  const [color, setColor] = useState<string>(SWATCHES[0].hex);
  const [about, setAbout] = useState('');
  const [isPublic, setPublic] = useState(true);
  const [icon, setIcon] = useState<Picked | null>(null);
  const [banner, setBanner] = useState<Picked | null>(null);
  /** From `make it` until the room: the group and then its pictures are going up. */
  const [sending, setSending] = useState(false);
  const [spoke, setSpoke] = useState(false);
  const clean = cleanName(name);
  const badgeChars = [...badge.trim()].length;
  const ok = isValidName(clean) && badgeChars >= 1 && badgeChars <= MAX_BADGE_CHARS;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    focusOnOpen(dialog, '#groups-make-name');
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  // a preview's url goes with the picture it showed: replaced, or the dialog gone
  useEffect(() => {
    if (!icon) return;
    return () => URL.revokeObjectURL(icon.url);
  }, [icon]);
  useEffect(() => {
    if (!banner) return;
    return () => URL.revokeObjectURL(banner.url);
  }, [banner]);

  /** A picture for the group: cut to its shape in the crop dialog (over this one), kept here until the group exists. */
  async function pick(file: File, kind: 'icon' | 'banner') {
    const blob = await cropPicture(file, kind === 'icon' ? GROUP_ICON : GROUP_BANNER);
    if (!blob) return;
    const picked = { blob, url: URL.createObjectURL(blob) };
    if (kind === 'icon') setIcon(picked);
    else setBanner(picked);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ok || busy || sending) return;
    setSpoke(true);
    setSending(true);
    const made = await createGroup({ name: clean, badge: badge.trim(), color, about: about.trim(), public: isPublic });
    if (!made) {
      setSending(false);
      return;
    }
    // the pictures, now that there is a group to put them on. one that does not go up is no
    // reason to stop: the group is made, and the room offers the pictures again
    try {
      if (icon) await api.saveGroupIcon(made.name, icon.blob);
      if (banner) await api.saveGroupBanner(made.name, banner.blob);
    } catch {
      // said nowhere: the room shows the picture missing, with the way to add it
    }
    await qc.invalidateQueries({ queryKey: ['explore'] });
    onClose();
    navigate(`/groups/${made.name}`);
  }

  const onPointerDown = (e: PointerEvent<HTMLDialogElement>) => {
    pressedBackdrop.current = e.target === e.currentTarget;
  };
  const onClick = (e: MouseEvent<HTMLDialogElement>) => {
    if (pressedBackdrop.current && e.target === e.currentTarget) onClose();
  };
  useSheetBack(onClose);

  return (
    <dialog
      ref={dialogRef}
      id="groups-make"
      data-sheet=""
      aria-labelledby="groups-make-title"
      onPointerDown={onPointerDown}
      onClick={onClick}
      onClose={onClose}
      // a phone's is a sheet up from the foot (MobileSheet.tsx)
      className={cn(
        'm-auto max-h-[calc(100dvh-2rem)] w-[min(520px,calc(100vw-3rem))] overflow-y-auto border border-primaryStroke bg-backgroundSecondary px-4 py-3 text-base text-textPrimary backdrop:bg-black/60',
        SHEET_DIALOG
      )}
    >
      <SheetGrab onDismiss={onClose} />
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        {/* the dialogs' title (CropDialog, ConfirmDialog): the blue bar, a size down to keep this one dense */}
        <h2 id="groups-make-title" className="border-l-4 border-primaryBlue pl-3 text-lg font-semibold leading-tight text-textPrimary">
          create group
        </h2>
        {/* the banner and the picture as they will sit on the group: the whole picture is the click, as on the room */}
        {/* the picture hangs 32px under the banner; the line under it sits 8px past that (28 here and the form's 12) */}
        <div className="relative mb-7">
          <div id="groups-make-banner" className="group/banner relative h-28 overflow-hidden border border-primaryStroke" style={{ backgroundColor: color }}>
            {banner && <img src={banner.url} alt="" className="h-full w-full object-cover" />}
            <PicturePick
              id="groups-make-banner-pick"
              label={banner ? 'change banner' : 'add a banner'}
              reveal="group-hover/banner:opacity-100"
              className="inset-0"
              onPick={(file) => void pick(file, 'banner')}
            />
          </div>
          <div className="group/icon absolute -bottom-8 left-4 flex">
            <GroupMark id="groups-make-icon" name={clean || 'new'} color={color} src={icon?.url} className="h-16 w-16 border-4 border-backgroundSecondary text-2xl" />
            <PicturePick
              id="groups-make-icon-pick"
              label={icon ? 'change picture' : 'add a picture'}
              reveal="group-hover/icon:opacity-100"
              className="inset-1"
              icon={22}
              onPick={(file) => void pick(file, 'icon')}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="groups-make-name"
            value={name}
            onChange={(e) =>
              setName(
                e.target.value
                  .toLowerCase()
                  .replace(/[^a-z0-9_-]/g, '')
                  .slice(0, 32)
              )
            }
            placeholder="name"
            maxLength={32}
            autoComplete="off"
            aria-label="group name"
            className={cn(INPUT, 'min-w-0 flex-1')}
          />
          <input
            id="groups-make-badge"
            value={badge}
            onChange={(e) => setBadge(e.target.value)}
            placeholder="badge"
            maxLength={MAX_BADGE_CHARS}
            autoComplete="off"
            aria-label="badge"
            className={cn(INPUT, 'min-w-0 max-w-40 flex-1')}
          />
        </div>
        <input
          id="groups-make-about"
          value={about}
          onChange={(e) => setAbout(e.target.value)}
          placeholder="about"
          maxLength={MAX_ABOUT_CHARS}
          autoComplete="off"
          aria-label="about"
          className={INPUT}
        />
        {/* the swatches and the square for any other colour on the left, the badge as it will read pushed to the right: one 24px line */}
        <div className="flex flex-wrap items-center gap-1.5">
          {SWATCHES.map(({ hex, name }) => (
            <Tooltip key={hex} content={name}>
              <button
                type="button"
                aria-label={name}
                aria-pressed={hex === color}
                onClick={() => setColor(hex)}
                style={{ backgroundColor: hex }}
                // the chosen one's ring is an outline: no box-shadow on this site
                className={cn('h-6 w-6 shrink-0 focus-visible:outline-primaryBlue', hex === color && 'outline outline-2 outline-offset-1 outline-textPrimary')}
              />
            </Tooltip>
          ))}
          <Tooltip content="more colors">
            {/* the native picker, unseen over a square of the colour; it opens on the click */}
            <label className="relative h-6 w-6 shrink-0 cursor-pointer border border-primaryStroke focus-within:border-primaryBlue" style={{ backgroundColor: color }}>
              <input
                id="groups-make-color"
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                aria-label="more colors"
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              />
            </label>
          </Tooltip>
          <Badge group={{ name: clean || 'new', badge: badge.trim() || 'badge', color }} src={icon?.url} size="md" className="ml-auto" />
        </div>
        {/* public or private on the left, the two answers on the right */}
        <div className="flex items-center justify-between gap-3">
          <VisibilityToggle isPublic={isPublic} onChange={setPublic} ids={['groups-make-public', 'groups-make-private']} />
          <span className="flex items-center gap-3">
            <Button size="sm" onClick={onClose}>
              cancel
            </Button>
            <Button id="groups-make-submit" type="submit" variant="primary" className="px-3 py-1.5 text-sm" disabled={!ok || busy || sending}>
              {sending ? 'making…' : 'make it'}
            </Button>
          </span>
        </div>
        {spoke && status && (
          <p id="groups-make-status" className="text-sm text-textSecondary">
            {status}
          </p>
        )}
      </form>
    </dialog>
  );
}
