import { useAtomValue } from 'jotai';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { openProfilePopup, type ProfilePopupTarget } from '@/infra/atoms/profile-popup-atoms';
import { profilePopupEnabledAtom } from '@/infra/atoms/settings-atoms';

export const profilePath = (name: string) => `/watch/${encodeURIComponent(name)}`;

const liveState = (live: boolean) => (live ? { live: true } : undefined);

export function useShowProfile() {
  const popup = useAtomValue(profilePopupEnabledAtom);
  const navigate = useNavigate();
  const show = (person: ProfilePopupTarget, live = false) => {
    if (popup) openProfilePopup(person);
    else void navigate(profilePath(person.name), { state: liveState(live) });
  };
  return { popup, show };
}

interface ProfileLinkProps {
  person: ProfilePopupTarget;
  live?: boolean;
  id?: string;
  twin?: boolean;
  label?: string;
  className?: string;
  children: ReactNode;
}

export function ProfileLink({ person, live = false, id, twin = false, label, className, children }: ProfileLinkProps) {
  const popup = useAtomValue(profilePopupEnabledAtom);
  return (
    <Link
      id={id}
      tabIndex={twin ? -1 : undefined}
      aria-hidden={twin || undefined}
      aria-label={label}
      to={profilePath(person.name)}
      state={liveState(live)}
      draggable={false}
      aria-haspopup={popup ? 'dialog' : undefined}
      data-prefetch={popup ? 'off' : undefined}
      onClick={(e) => {
        if (!popup || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        openProfilePopup(person);
      }}
      className={className}
    >
      {children}
    </Link>
  );
}
