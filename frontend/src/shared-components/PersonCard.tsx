import { useAtomValue } from 'jotai';
import { type CSSProperties, type ReactNode, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';

import { api } from '@/infra/api';
import { BOT_GROUP } from '@/infra/atoms/chat-atoms';
import { homeStreamsAtom } from '@/infra/atoms/home-atoms';
import { loadPeek, peeksAtom } from '@/infra/atoms/follow-atoms';
import { PRESENCE_WORD } from '@/infra/atoms/presence-atoms';
import { profilePopupAtom } from '@/infra/atoms/profile-popup-atoms';
import { roleColorsAtom, roomAtom, rolesOf } from '@/infra/atoms/room-atoms';
import { type PanelSide, paletteAtom } from '@/infra/atoms/settings-atoms';
import { Badge } from '@/shared-components/Badge';
import { BlurredPicture } from '@/shared-components/BlurredPicture';
import { Face } from '@/shared-components/Face';
import { FollowButton } from '@/shared-components/FollowButton';
import { Who } from '@/shared-components/PersonRow';
import type { CardAction, CardPerson, CardSpot, PeekHold } from '@/shared-components/peek';
import { PresenceSquare } from '@/shared-components/PresenceSquare';
import { StreamStill } from '@/shared-components/StreamStill';
import { Tooltip } from '@/shared-components/Tooltip';
import { ViewerCount } from '@/shared-components/ViewerCount';
import { ensureContrast, fromHex, hex, isHex } from '@/infra/theme';
import { cn } from '@/utils/cn';

const CARD_W = 260;
const GAP = 4;
const ACTIONS_W = 30;

interface PersonCardProps {
  id?: string;
  person: CardPerson;
  at: CardSpot;
  side?: PanelSide;
  actions?: CardAction[] | null;
  below?: ReactNode;
  follow?: boolean;
  hold: PeekHold;
}

interface HeldRole {
  id: string;
  name: string;
  color?: string;
}

function useGroupRoles(name: string): { roles: HeldRole[]; tint?: string } | null {
  const { pathname } = useLocation();
  const room = useAtomValue(roomAtom);
  const { server, colors } = useAtomValue(roleColorsAtom);
  const card = useAtomValue(paletteAtom).backgroundSecondary;
  const slug = /^\/groups\/([^/]+)/.exec(pathname)?.[1];
  if (!room || !slug || decodeURIComponent(slug) !== room.name) return null;
  const roles = rolesOf(room, name).map((role) => ({
    id: role.id,
    name: role.name,
    color: isHex(role.color) ? hex(ensureContrast(fromHex(role.color), card, 4.5)) : undefined
  }));
  if (roles.length === 0) return null;
  return { roles, tint: server === room.name ? colors.get(name) : undefined };
}

export function PersonCard({ id, person, at, side, actions, below, follow, hold }: PersonCardProps) {
  const { setCard } = hold;
  const peek = useAtomValue(peeksAtom)[person.name]?.card;
  const covered = useAtomValue(profilePopupAtom) !== null;
  const held = useGroupRoles(person.name);
  useEffect(() => {
    void loadPeek(person.name);
  }, [person.name]);
  const viewers = useAtomValue(homeStreamsAtom)?.find((s) => s.name === person.name)?.viewers ?? null;
  if (covered) return null;
  const known = person.verified && peek && !peek.verified ? undefined : peek;
  const bio = person.bio ?? known?.bio ?? '';
  const presence = person.presence ?? known?.presence;
  const badge = known?.badge !== undefined ? known.badge : (person.groups?.find((g) => g.name !== BOT_GROUP) ?? null);
  const root = at.host.ownerDocument.documentElement;
  const w = root.clientWidth;
  const h = root.clientHeight;
  const edge = side ?? (at.column.left + at.column.width / 2 > w / 2 ? 'right' : 'left');
  const x = edge === 'right' ? at.column.left - GAP - CARD_W : at.column.right + GAP;
  const pressable = !!actions && actions.length > 0;
  const least = GAP + (pressable ? ACTIONS_W : 0);
  const left = Math.max(least, Math.min(x, w - CARD_W - GAP));
  const over = left < at.column.right && left + CARD_W > at.column.left;
  const style: CSSProperties = {
    width: CARD_W,
    left,
    ...(at.row.top < h / 2 ? { top: over ? at.row.bottom + GAP : at.row.top } : { bottom: over ? h - at.row.top + GAP : h - at.row.bottom })
  };
  return createPortal(
    <div
      ref={setCard}
      style={style}
      data-peek-hold
      onPointerEnter={hold.enter}
      onPointerLeave={hold.leave}
      onKeyDown={hold.keyDown}
      onBlur={hold.blur}
      className="pointer-events-auto fixed z-[70]"
    >
      {pressable && (
        <div
          id={id ? `${id}-mod` : undefined}
          role="toolbar"
          aria-orientation="vertical"
          aria-label={`moderate ${person.name}`}
          className="absolute right-full top-0 -mr-px flex flex-col overflow-hidden rounded-card border border-primaryStroke bg-backgroundSecondary"
        >
          {actions.map((a) => (
            <Tooltip key={a.key} content={a.label} at="left">
              <button
                type="button"
                aria-label={a.label}
                data-card-action={a.key}
                onClick={a.onPick}
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-control border border-transparent hover:border-primaryStroke focus-visible:border-primaryBlue focus-visible:outline-none',
                  a.danger ? 'text-decrease' : 'text-textSecondary hover:text-textPrimary'
                )}
              >
                {a.icon}
              </button>
            </Tooltip>
          ))}
        </div>
      )}
      <div
        id={id}
        role={pressable || below ? 'dialog' : 'tooltip'}
        aria-label={pressable || below ? person.name : undefined}
        data-presence={presence}
        data-tint={held?.tint}
        style={held?.tint ? { backgroundImage: `linear-gradient(${held.tint}1f, ${held.tint}1f)` } : undefined}
        className="flex flex-col gap-2.5 rounded-panel border border-primaryStroke bg-backgroundSecondary p-3 text-sm text-textPrimary"
      >
        <span className="flex items-center gap-2.5">
          <span className="relative flex shrink-0">
            <Face name={person.name} version={person.avatar} className="h-8 w-8 text-sm" />
            {presence && (
              <>
                <PresenceSquare status={presence} className="border-backgroundSecondary" />
                <span className="sr-only">{PRESENCE_WORD[presence]}</span>
              </>
            )}
          </span>
          <span className="flex h-8 min-w-0 flex-1 flex-col items-start justify-center">
            <Who
              name={person.name}
              verified={person.verified}
              oauthVerified={person.oauth_verified ?? known?.oauth_verified}
              className="max-w-full text-sm font-semibold leading-4"
            />
            {(badge || presence === 'streaming') && (
              <span className="flex min-w-0 max-w-full items-center gap-2 text-xs leading-4">
                {badge && <Badge group={badge} className="min-w-0" />}
                {presence === 'streaming' && <ViewerCount count={viewers} className="shrink-0 whitespace-nowrap text-textSecondary" />}
              </span>
            )}
          </span>
          {follow && <FollowButton id={`${id ?? `peek-${person.name}`}-follow`} name={person.name} icon />}
        </span>
        {held && (
          <span id={id ? `${id}-roles` : undefined} data-roles className="flex flex-wrap items-center gap-1 text-xs leading-4">
            <span className="text-textSecondary">role:</span>
            {held.roles.map((role) => (
              <span
                key={role.id}
                data-role={role.name}
                style={role.color ? { color: role.color } : undefined}
                className={cn(
                  'inline-flex max-w-full items-center truncate rounded-control border border-primaryStroke bg-backgroundSecondary px-1.5 font-semibold',
                  !role.color && 'text-textSecondary'
                )}
              >
                {role.name}
              </span>
            ))}
          </span>
        )}
        {presence === 'streaming' ? (
          <StreamStill name={person.name} className="w-full rounded-card" />
        ) : (
          <span
            id={id ? `${id}-thumb` : undefined}
            className="relative flex aspect-video w-full shrink-0 items-center justify-center overflow-hidden rounded-card border border-primaryStroke bg-backgroundTertiary"
          >
            {known?.thumbs?.[0] !== undefined ? (
              <img src={api.streamThumbUrl(person.name, known.thumbs[0])} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
            ) : (
              <>
                <BlurredPicture name={person.name} version={person.avatar} />
                <span className="relative text-sm font-semibold uppercase tracking-wider text-white">offline</span>
              </>
            )}
          </span>
        )}
        {bio && <span className="line-clamp-4 break-words text-sm leading-snug">{bio}</span>}
        {below}
      </div>
    </div>,
    at.host
  );
}
