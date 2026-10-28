import { useAtomValue } from 'jotai';
import { Navigate, Outlet, createBrowserRouter, useParams } from 'react-router-dom';

import { CrashPage } from '@/app/CrashPage';
import { NotFoundPage } from '@/app/NotFoundPage';
import { AdminPage } from '@/app/admin/AdminPage';
import { AuthPage } from '@/app/auth/AuthPage';
import { HomePage } from '@/app/home/HomePage';
import { ExplorePage } from '@/app/explore/ExplorePage';
import { ServerPage } from '@/app/explore/ServerRoom';
import { LivePage } from '@/app/live/LivePage';
import { WatchPage } from '@/app/watch/WatchPage';
import { panelSideAtom } from '@/infra/atoms/settings-atoms';
import { CropDialog } from '@/shared-components/CropDialog';
import { FriendChat } from '@/shared-components/FriendChat';
import { Inspector } from '@/shared-components/Inspector';
import { MiniPlayer } from '@/shared-components/MiniPlayer';
import { Notifications } from '@/shared-components/Notifications';
import { UserModal } from '@/shared-components/UserModal';
import { UserPanel } from '@/shared-components/UserPanel';
import { cn } from '@/utils/cn';

/**
 * Every page, plus the things that live outside pages: the sidebar (the search, who you follow,
 * and you at the bottom of it, with the settings gear at the end of your line; collapsed beside the page, open it covers the
 * streams), the picture in picture players (bottom right of the page: a stream you watch, your own while live), the user
 * modal the gear opens, the notifications list the bell opens (the bell and go live are the right end of every page's
 * title row: PageFrame.tsx), and the crop dialog every picked picture passes through (CropDialog.tsx).
 */
function Shell() {
  const side = useAtomValue(panelSideAtom);
  return (
    <div className={cn('flex min-h-screen items-start', side === 'right' && 'flex-row-reverse')}>
      <UserPanel />
      <div className="relative min-w-0 flex-1">
        <Outlet />
      </div>
      <MiniPlayer />
      <FriendChat />
      <Notifications />
      <UserModal />
      <CropDialog />
      <Inspector />
    </div>
  );
}

/** Keyed on the name, so going from one stream's page straight to another's (back, forward) starts over instead of keeping the first. */
function WatchRoute() {
  const { name } = useParams<{ name: string }>();
  return <WatchPage key={name} />;
}

/** An old `/explore` link. The page is `/groups` now. */
function ExploreRedirect() {
  const { server, channel } = useParams<{ server?: string; channel?: string }>();
  const to = channel ? `/groups/${server}/${channel}` : server ? `/groups/${server}` : '/groups';
  return <Navigate to={to} replace />;
}

/**
 * Keyed on the server, and only the server: moving from one group to another starts that room,
 * while moving between its channels keeps the page, its room and its one chat socket, and
 * only changes what is shown (docs/groups.md). One route for both, so a channel is never a
 * different page.
 */
function ServerRoute() {
  const { server } = useParams<{ server: string }>();
  return <ServerPage key={server} />;
}

export const router = createBrowserRouter([
  {
    // a pathless parent, so one error boundary covers every page. a crash renders CrashPage
    // (and the RouterProvider's onError in main.tsx reports it) instead of react router's default screen.
    element: <Shell />,
    errorElement: <CrashPage />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/groups', element: <ExplorePage /> },
      { path: '/groups/:server/:channel?', element: <ServerRoute /> },
      { path: '/explore', element: <Navigate to="/groups" replace /> },
      { path: '/explore/:server', element: <ExploreRedirect /> },
      { path: '/explore/:server/:channel', element: <ExploreRedirect /> },
      { path: '/live', element: <LivePage /> },
      { path: '/watch/:name', element: <WatchRoute /> },
      { path: '/login', element: <AuthPage mode="login" /> },
      { path: '/signup', element: <AuthPage mode="signup" /> },
      { path: '/admin', element: <AdminPage /> },
      { path: '*', element: <NotFoundPage /> }
    ]
  }
]);
