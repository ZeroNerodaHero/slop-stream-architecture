import { createBrowserRouter } from 'react-router-dom';

import { NotFoundPage } from '@/app/NotFoundPage';
import { HomePage } from '@/app/home/HomePage';
import { LivePage } from '@/app/live/LivePage';
import { WatchPage } from '@/app/watch/WatchPage';

export const router = createBrowserRouter([
  { path: '/', element: <HomePage /> },
  { path: '/live', element: <LivePage /> },
  { path: '/watch/:name', element: <WatchPage /> },
  { path: '*', element: <NotFoundPage /> }
]);
