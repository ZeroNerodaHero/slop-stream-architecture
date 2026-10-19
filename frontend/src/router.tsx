import { createBrowserRouter } from 'react-router-dom';

import { CrashPage } from '@/app/CrashPage';
import { NotFoundPage } from '@/app/NotFoundPage';
import { AdminPage } from '@/app/admin/AdminPage';
import { AuthPage } from '@/app/auth/AuthPage';
import { HomePage } from '@/app/home/HomePage';
import { LivePage } from '@/app/live/LivePage';
import { WatchPage } from '@/app/watch/WatchPage';

export const router = createBrowserRouter([
  {
    // a pathless parent, so one error boundary covers every page. a crash renders CrashPage
    // (and the RouterProvider's onError in main.tsx reports it) instead of react router's default screen.
    errorElement: <CrashPage />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/live', element: <LivePage /> },
      { path: '/watch/:name', element: <WatchPage /> },
      { path: '/login', element: <AuthPage mode="login" /> },
      { path: '/signup', element: <AuthPage mode="signup" /> },
      { path: '/admin', element: <AdminPage /> },
      { path: '*', element: <NotFoundPage /> }
    ]
  }
]);
