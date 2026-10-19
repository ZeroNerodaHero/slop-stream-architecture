import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';

import { installReporting, report } from '@/infra/report';
import { router } from '@/router';

import '@/app/globals.css';

// one retry, not the default three with backoff (~7s of a dead api reading as "loading"). the
// pages that poll ask again on their own anyway, and admin turns retries off for itself.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root');

// failures go to /api/errors, see docs/debugging.md. window errors and rejections here. a
// render crash through the router's onError: once per crash, with the route pattern and
// react's component stack. react's own logging is left in place (it prints the error, and
// in dev the component stack); this only replaces react router's extra console line.
installReporting();
function crashedInRoute(error: unknown, info: { pattern: string; errorInfo?: { componentStack?: string | null } }) {
  report('crash', error, { componentStack: info.errorInfo?.componentStack ?? undefined, route: info.pattern });
}
// the last resort: a crash with no boundary above it (CrashPage itself). react logs nothing
// then, so the console line is ours.
function crashedOutsideRoutes(error: unknown, info: { componentStack?: string }) {
  console.error(error);
  report('crash', error, { componentStack: info.componentStack });
}

createRoot(root, { onUncaughtError: crashedOutsideRoutes }).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} onError={crashedInRoute} />
  </QueryClientProvider>
);
