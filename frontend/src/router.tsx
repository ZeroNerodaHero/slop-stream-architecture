import { useAtomValue } from 'jotai';
import { lazy, Suspense } from 'react';
import { Navigate, Outlet, createBrowserRouter, useParams } from 'react-router-dom';

import { CrashPage } from '@/app/CrashPage';
import { NotFoundPage } from '@/app/NotFoundPage';
import { HomePage } from '@/app/home/HomePage';
import { WatchPage } from '@/app/watch/WatchPage';
import { panelSideAtom } from '@/infra/atoms/settings-atoms';
import { loadServerPage } from '@/infra/prefetch';
import { AuthDialog } from '@/shared-components/AuthDialog';
import { CropDialog } from '@/shared-components/CropDialog';
import { FriendChat } from '@/shared-components/FriendChat';
import { Inspector } from '@/shared-components/Inspector';
import { MiniPlayer } from '@/shared-components/MiniPlayer';
import { Notifications } from '@/shared-components/Notifications';
import { ProfilePopup } from '@/shared-components/ProfilePopup';
import { UserModal } from '@/shared-components/UserModal';
import { UserPanel } from '@/shared-components/UserPanel';
import { cn } from '@/utils/cn';

/**
 * Every page, plus the things that live outside pages: the sidebar (the search, who you follow,
 * and you at the bottom of it, with the settings gear at the end of your line; collapsed beside the page, open it covers the
 * streams), the picture in picture players (bottom right of the page: a stream you watch, your own while live), the user
 * modal the gear opens, the log in / sign up dialog (AuthDialog.tsx), the notifications list the bell opens (the bell and go live are the right end of every page's
 * title row: PageFrame.tsx), the profile popup a click on a group's member or a chat's speaker opens (ProfilePopup.tsx),
 * and the crop dialog every picked picture passes through (CropDialog.tsx).
 */
function Shell() {
  const side = useAtomValue(panelSideAtom);
  return (
    // the safe areas at the sides (a phone on its side, its notch): 0 everywhere else, so nothing moves
    <div className={cn('flex min-h-screen items-start pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]', side === 'right' && 'flex-row-reverse')}>
      <UserPanel />
      <div className="relative min-w-0 flex-1">
        <Suspense fallback={null}>
          <Outlet />
        </Suspense>
      </div>
      <MiniPlayer />
      <FriendChat />
      <Notifications />
      <UserModal />
      <AuthDialog />
      <ProfilePopup />
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
 * The pages in chunks of their own, loaded when their route first renders (the Suspense in Shell
 * shows the frame meanwhile; a navigation keeps the page it leaves until the chunk is here): a
 * stream's page opened cold downloads and parses only the bundle it needs (docs/debugging.md
 * "Watch startup timings"). Home and the watch page stay in the main bundle: they are the pages
 * people land on. A press on a way to a group loads its chunk with its data (prefetch.ts `prefetchRoute`).
 */
const ExplorePage = lazy(() => import('@/app/explore/ExplorePage').then((m) => ({ default: m.ExplorePage })));
const ServerPage = lazy(() => loadServerPage().then((m) => ({ default: m.ServerPage })));
const LivePage = lazy(() => import('@/app/live/LivePage').then((m) => ({ default: m.LivePage })));
const AuthPage = lazy(() => import('@/app/auth/AuthPage').then((m) => ({ default: m.AuthPage })));
const OAuthPage = lazy(() => import('@/app/auth/OAuthPage').then((m) => ({ default: m.OAuthPage })));
const AdminPage = lazy(() => import('@/app/admin/AdminPage').then((m) => ({ default: m.AdminPage })));

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
      { path: '/oauth', element: <OAuthPage /> },
      { path: '/admin', element: <AdminPage /> },
      { path: '*', element: <NotFoundPage /> }
    ]
  }
]);
