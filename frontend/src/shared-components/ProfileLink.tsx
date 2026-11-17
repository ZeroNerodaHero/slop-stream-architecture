import { useAtomValue } from 'jotai';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { openProfilePopup, type ProfilePopupTarget } from '@/infra/atoms/profile-popup-atoms';
import { profilePopupEnabledAtom } from '@/infra/atoms/settings-atoms';

/** Their page (WatchPage.tsx). */
export const profilePath = (name: string) => `/watch/${encodeURIComponent(name)}`;

/** Streaming: the page holds the player's box from its first paint (WatchPage.tsx). */
const liveState = (live: boolean) => (live ? { live: true } : undefined);

/**
 * Somebody, from something that is not a link (a chat window's tab): them over the page
 * (ProfilePopup.tsx) while this browser's setting says so (settings.profilePopup), else their
 * page. `popup` is the setting, for an `aria-haspopup`.
 */
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
  /** They are streaming. */
  live?: boolean;
  id?: string;
  /** A second way to the same person right beside the first (a chat head's face by its name): for the pointer alone, no tab stop and nothing read out, so the name stays the one way for a key and a reader. */
  twin?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * A link to somebody's page (a group's roster, a direct chat's name). A click on it shows them
 * over the page instead (ProfilePopup.tsx), unless this browser turned that off
 * (settings.profilePopup): then the click is the link's, as is a click with a key held either
 * way (the browser's own: their page in a tab of its own).
 */
export function ProfileLink({ person, live = false, id, twin = false, className, children }: ProfileLinkProps) {
  const popup = useAtomValue(profilePopupEnabledAtom);
  return (
    <Link
      id={id}
      tabIndex={twin ? -1 : undefined}
      aria-hidden={twin || undefined}
      to={profilePath(person.name)}
      state={liveState(live)}
      // not draggable: the face must not lift off the row as a ghost link
      draggable={false}
      aria-haspopup={popup ? 'dialog' : undefined}
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
