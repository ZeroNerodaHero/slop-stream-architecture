import { useAtomValue } from 'jotai';
import { Outlet, createBrowserRouter, useParams } from 'react-router-dom';

import { CrashPage } from '@/app/CrashPage';
import { NotFoundPage } from '@/app/NotFoundPage';
import { AdminPage } from '@/app/admin/AdminPage';
import { AuthPage } from '@/app/auth/AuthPage';
import { HomePage } from '@/app/home/HomePage';
import { ExplorePage, ChannelPage } from '@/app/explore/ExplorePage';
import { LivePage } from '@/app/live/LivePage';
import { WatchPage } from '@/app/watch/WatchPage';
import { panelSideAtom } from '@/infra/atoms/settings-atoms';
import { FriendChat } from '@/shared-components/FriendChat';
import { Inspector } from '@/shared-components/Inspector';
import { MiniPlayer } from '@/shared-components/MiniPlayer';
import { TopBar } from '@/shared-components/TopBar';
import { UserModal } from '@/shared-components/UserModal';
import { UserPanel } from '@/shared-components/UserPanel';
import { cn } from '@/utils/cn';

/**
 * Every page, plus the things that live outside pages: the sidebar (who you follow, and you at
 * the bottom of it; collapsed beside the page, open it covers the streams), the picture in picture players (bottom right
 * of the page: a stream you watch, your own while live), the centered search with go live and
 * the settings icon over the top of the page, and the user modal that icon opens.
 */
function Shell() {
  const side = useAtomValue(panelSideAtom);
  return (
    <div className={cn('flex min-h-screen items-start', side === 'right' && 'flex-row-reverse')}>
      <UserPanel />
      <div className="relative min-w-0 flex-1">
        <TopBar />
        <Outlet />
      </div>
      <MiniPlayer />
      <FriendChat />
      <UserModal />
      <Inspector />
    </div>
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
