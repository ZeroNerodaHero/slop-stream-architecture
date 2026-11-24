import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';

import { loadMe } from '@/infra/atoms/auth-atoms';
import { applyStoredTextSize, applyStoredTheme } from '@/infra/atoms/settings-atoms';
import { startEvents } from '@/infra/events';
import { installMobileKeyboard } from '@/infra/keyboard';
import { installPrefetch, loadFirstPage } from '@/infra/prefetch';
import { queryClient } from '@/infra/query-client';
import { installReporting, report } from '@/infra/report';
import { router } from '@/router';

import '@/infra/atoms/home-atoms';
import '@/app/globals.css';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root');

applyStoredTheme();
applyStoredTextSize();

installReporting();

void loadMe();

startEvents();

installPrefetch();

installMobileKeyboard();

document.addEventListener('dragstart', (e) => {
  if (e.target instanceof HTMLImageElement) e.preventDefault();
});

function crashedInRoute(error: unknown, info: { pattern: string; errorInfo?: { componentStack?: string | null } }) {
  report('crash', error, { componentStack: info.errorInfo?.componentStack ?? undefined, route: info.pattern });
}
function crashedOutsideRoutes(error: unknown, info: { componentStack?: string }) {
  console.error(error);
  report('crash', error, { componentStack: info.componentStack });
}

declare global {
  interface Window {
    __bootCss?: Promise<unknown>;
  }
}

const render = () =>
  createRoot(root, { onUncaughtError: crashedOutsideRoutes }).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} onError={crashedInRoute} />
    </QueryClientProvider>
  );

const waits = [loadFirstPage(), window.__bootCss].filter((wait) => wait !== null && wait !== undefined);
if (waits.length > 0) void Promise.allSettled(waits).then(render);
else render();
