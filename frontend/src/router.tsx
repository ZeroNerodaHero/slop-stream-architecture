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

function Shell() {
  const side = useAtomValue(panelSideAtom);
  return (
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

function WatchRoute() {
  const { name } = useParams<{ name: string }>();
  return <WatchPage key={name} />;
}

function ExploreRedirect() {
  const { server, channel } = useParams<{ server?: string; channel?: string }>();
  const to = channel ? `/groups/${server}/${channel}` : server ? `/groups/${server}` : '/groups';
  return <Navigate to={to} replace />;
}

const ExplorePage = lazy(() => import('@/app/explore/ExplorePage').then((m) => ({ default: m.ExplorePage })));
const ServerPage = lazy(() => loadServerPage().then((m) => ({ default: m.ServerPage })));
const LivePage = lazy(() => import('@/app/live/LivePage').then((m) => ({ default: m.LivePage })));
const AuthPage = lazy(() => import('@/app/auth/AuthPage').then((m) => ({ default: m.AuthPage })));
const OAuthPage = lazy(() => import('@/app/auth/OAuthPage').then((m) => ({ default: m.OAuthPage })));
const AdminPage = lazy(() => import('@/app/admin/AdminPage').then((m) => ({ default: m.AdminPage })));

function ServerRoute() {
  const { server } = useParams<{ server: string }>();
  return <ServerPage key={server} />;
}

export const router = createBrowserRouter([
  {
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
