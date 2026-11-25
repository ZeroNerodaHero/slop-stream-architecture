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
import { GROUP_SWATCHES, GroupColorPick } from '@/shared-components/GroupColorPick';
import { GroupMark } from '@/shared-components/GroupMark';
import { INPUT } from '@/shared-components/input';
import { SHEET_DIALOG, SheetGrab, focusOnOpen, useSheetBack } from '@/shared-components/MobileSheet';
import { PicturePick } from '@/shared-components/PicturePick';
import { VisibilityToggle } from '@/shared-components/VisibilityToggle';
import { cn } from '@/utils/cn';

const MAX_BADGE_CHARS = 12;
const MAX_ABOUT_CHARS = 200;

interface Picked {
  blob: Blob;
  url: string;
}

export function MakeGroupDialog({ onClose }: { onClose: () => void }) {
  const busy = useAtomValue(groupsBusyAtom);
  const status = useAtomValue(groupsStatusAtom);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const pressedBackdrop = useRef(false);
  const [name, setName] = useState('');
  const [badge, setBadge] = useState('');
  const [color, setColor] = useState<string>(GROUP_SWATCHES[0].hex);
  const [about, setAbout] = useState('');
  const [isPublic, setPublic] = useState(true);
  const [icon, setIcon] = useState<Picked | null>(null);
  const [banner, setBanner] = useState<Picked | null>(null);
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

  useEffect(() => {
    if (!icon) return;
    return () => URL.revokeObjectURL(icon.url);
  }, [icon]);
  useEffect(() => {
    if (!banner) return;
    return () => URL.revokeObjectURL(banner.url);
  }, [banner]);

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
    try {
      if (icon) await api.saveGroupIcon(made.name, icon.blob);
      if (banner) await api.saveGroupBanner(made.name, banner.blob);
    } catch {
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
      className={cn(
        'm-auto max-h-[calc(100dvh-2rem)] w-[min(520px,calc(100vw-3rem))] overflow-y-auto md:rounded-panel border border-primaryStroke bg-backgroundSecondary px-4 py-3 text-base text-textPrimary backdrop:bg-black/60',
        SHEET_DIALOG
      )}
    >
      <SheetGrab onDismiss={onClose} />
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <h2 id="groups-make-title" className="border-l-4 border-primaryBlue pl-3 text-lg font-semibold leading-tight text-textPrimary">
          create group
        </h2>
        <div className="relative mb-7">
          <div id="groups-make-banner" className="group/banner relative h-28 overflow-hidden rounded-card border border-primaryStroke" style={{ backgroundColor: color }}>
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
            <GroupMark id="groups-make-icon" name={clean || 'new'} color={color} src={icon?.url} className="h-16 w-16 rounded-avatar border-4 border-backgroundSecondary text-2xl" />
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
        <div className="flex flex-wrap items-center gap-1.5">
          <GroupColorPick id="groups-make-color" value={color} onChange={setColor} />
          <Badge group={{ name: clean || 'new', badge: badge.trim() || 'badge', color }} src={icon?.url} preview size="md" className="ml-auto" />
        </div>
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
