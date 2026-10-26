import { Outlet, createBrowserRouter, useParams } from 'react-router-dom';

import { CrashPage } from '@/app/CrashPage';
import { NotFoundPage } from '@/app/NotFoundPage';
import { AdminPage } from '@/app/admin/AdminPage';
import { AuthPage } from '@/app/auth/AuthPage';
import { HomePage } from '@/app/home/HomePage';
import { ExplorePage, ChannelPage } from '@/app/explore/ExplorePage';
import { LivePage } from '@/app/live/LivePage';
import { WatchPage } from '@/app/watch/WatchPage';
import { Inspector } from '@/shared-components/Inspector';
import { MiniPlayer } from '@/shared-components/MiniPlayer';
import { UserModal } from '@/shared-components/UserModal';
import { UserPanel } from '@/shared-components/UserPanel';

/**
 * Every page, plus the things that live outside pages: who you are (bottom left), the picture
 * in picture players (bottom right: a stream you watch, your own while live), and the user
 * modal the panel opens (profile, security, settings, appearance).
 */
function Shell() {
  return (
    <>
      <Outlet />
      <UserPanel />
      <MiniPlayer />
      <UserModal />
      <Inspector />
    </>
  );
}

/** Keyed on the name, so going from one stream's page straight to another's (back, forward) starts over instead of keeping the first. */
function WatchRoute() {
  const { name } = useParams<{ name: string }>();
  return <WatchPage key={name} />;
}

/** Keyed on the channel, so moving from one room to another starts that room's chat. */
function ChannelRoute() {
  const { server, channel } = useParams<{ server: string; channel: string }>();
  return <ChannelPage key={`${server}/${channel}`} />;
}

export const router = createBrowserRouter([
  {
    // a pathless parent, so one error boundary covers every page. a crash renders CrashPage
    // (and the RouterProvider's onError in main.tsx reports it) instead of react router's default screen.
    element: <Shell />,
    errorElement: <CrashPage />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/explore', element: <ExplorePage /> },
      { path: '/explore/:server/:channel', element: <ChannelRoute /> },
      { path: '/live', element: <LivePage /> },
      { path: '/watch/:name', element: <WatchRoute /> },
      { path: '/login', element: <AuthPage mode="login" /> },
      { path: '/signup', element: <AuthPage mode="signup" /> },
      { path: '/admin', element: <AdminPage /> },
      { path: '*', element: <NotFoundPage /> }
    ]
  }
]);
