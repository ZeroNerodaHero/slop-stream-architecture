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
import { PicturePick } from '@/shared-components/PicturePick';
import { cn } from '@/utils/cn';

const INPUT = 'min-w-0 flex-1 border border-primaryStroke bg-background px-3 py-2 text-base text-textPrimary placeholder:text-textTertiary';

/** The api's caps, as the boxes know them. */
const MAX_BADGE_CHARS = 12;
const MAX_ABOUT_CHARS = 200;
/** The colours a new group starts from: discord's blurple, then the fake streams' box colours. The colour box takes any other. */
const SWATCHES = ['#5865f2', '#f85149', '#3fb950', '#f2cc60', '#bc8cff', '#ff9f43', '#39d2c0', '#ff6bcb'] as const;

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
  const [color, setColor] = useState<string>(SWATCHES[0]);
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
    dialog.querySelector<HTMLElement>('#groups-make-name')?.focus();
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

  return (
    <dialog
      ref={dialogRef}
      id="groups-make"
      aria-labelledby="groups-make-title"
      onPointerDown={onPointerDown}
      onClick={onClick}
      onClose={onClose}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(520px,calc(100vw-3rem))] overflow-y-auto border border-primaryStroke bg-backgroundSecondary p-6 text-base text-textPrimary backdrop:bg-black/60"
    >
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <h2 id="groups-make-title" className="text-sm font-semibold uppercase tracking-wider text-textTertiary">
          make a group
        </h2>
        {/* the banner and the picture as they will sit on the group: the whole picture is the click, as on the room */}
        <div className="relative mb-8">
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
        <p className="text-sm text-textTertiary">a banner and a picture, now or later on the group. without them the group wears its colour.</p>
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
            className={INPUT}
          />
          <input
            id="groups-make-badge"
            value={badge}
            onChange={(e) => setBadge(e.target.value)}
            placeholder="badge"
            maxLength={MAX_BADGE_CHARS}
            autoComplete="off"
            aria-label="badge"
            className={cn(INPUT, 'max-w-40')}
          />
        </div>
        <input
          id="groups-make-about"
          value={about}
          onChange={(e) => setAbout(e.target.value)}
          placeholder="about, optional"
          maxLength={MAX_ABOUT_CHARS}
          autoComplete="off"
          aria-label="about"
          className={INPUT}
        />
        <div className="flex flex-wrap items-center gap-2">
          {SWATCHES.map((swatch) => (
            <button
              key={swatch}
              type="button"
              aria-label={swatch}
              aria-pressed={swatch === color}
              onClick={() => setColor(swatch)}
              style={{ backgroundColor: swatch }}
              className={cn('h-8 w-8 border-2', swatch === color ? 'border-textPrimary' : 'border-transparent')}
            />
          ))}
          <input
            id="groups-make-color"
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            aria-label="any other colour"
            className="h-8 w-12 cursor-pointer border border-primaryStroke bg-background p-0.5"
          />
          <Badge group={{ name: clean || 'new', badge: badge.trim() || 'badge', color }} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            id="groups-make-public"
            type="button"
            aria-pressed={isPublic}
            onClick={() => setPublic(true)}
            className={cn('text-sm font-semibold', isPublic ? 'text-primaryBlue' : 'text-textTertiary')}
          >
            public
          </button>
          <button
            id="groups-make-private"
            type="button"
            aria-pressed={!isPublic}
            onClick={() => setPublic(false)}
            className={cn('text-sm font-semibold', !isPublic ? 'text-primaryBlue' : 'text-textTertiary')}
          >
            private
          </button>
          <p className="text-sm text-textTertiary">
            a private group is left off the lists. someone with the address can still open it and join. four digits are added, so the same name can be made twice. the
            owner can switch this later, under manage on the group.
          </p>
        </div>
        <div className="flex items-center justify-end gap-3">
          <button type="button" className="text-sm text-textTertiary" onClick={onClose}>
            cancel
          </button>
          <Button id="groups-make-submit" type="submit" variant="primary" className="px-3 py-1.5 text-sm" disabled={!ok || busy || sending}>
            {sending ? 'making…' : 'make it'}
          </Button>
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
