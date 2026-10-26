import { RiSettings3Line } from '@remixicon/react';
import { Link, useLocation } from 'react-router-dom';

import { openUserModal } from '@/infra/atoms/user-modal-atoms';
import { buttonClassName } from '@/shared-components/Button';

/**
 * Go live and the settings icon at the right edge of the page column. Sticky: they stay at the
 * top of the window while the page scrolls under them (the page's own colour, so what scrolls
 * under is hidden). The negative margin takes the bar out of the flow, so the page is not
 * pushed down by it: every page leaves it the first 4rem (PageFrame's `pt-16`), and
 * globals.css keeps scrolled-to things from landing under it. Go live is absent on its own
 * page. The icon opens the user modal on settings. Search is the sidebar's (Friends.tsx).
 */
export function TopBar() {
  const { pathname } = useLocation();
  const onLivePage = pathname.replace(/\/$/, '') === '/live';

  return (
    <div className="sticky top-0 z-30 -mb-16 flex h-16 items-center justify-end gap-2 bg-background px-5">
      {!onLivePage && (
        <Link id="go-live" to="/live" className={buttonClassName('primary', 'px-3 py-2 text-sm')}>
          go live
        </Link>
      )}
      <button
        id="settings"
        type="button"
        aria-label="settings"
        title="settings"
        onClick={() => openUserModal('settings')}
        className={buttonClassName('secondary', 'px-2 py-2')}
      >
        <RiSettings3Line aria-hidden size={18} />
      </button>
    </div>
  );
}
