import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';

import { applyStoredTextSize, applyStoredTheme } from '@/infra/atoms/settings-atoms';
import { startEvents } from '@/infra/events';
import { installReporting, report } from '@/infra/report';
import { router } from '@/router';

import '@/app/globals.css';

// one retry, not the default three with backoff (~7s of a dead api reading as "loading"). the
// pages that poll ask again on their own anyway, and admin turns retries off for itself.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root');

// the theme and the size this browser keeps, before anything renders. (index.html's inline script
// already painted them; this is the same answer from the atoms, and from here on they are in charge.)
applyStoredTheme();
applyStoredTextSize();

// failures go to /api/errors, see docs/debugging.md. window errors and rejections here. a
// render crash through the router's onError: once per crash, with the route pattern and
// react's component stack. react's own logging is left in place (it prints the error, and
// in dev the component stack); this only replaces react router's extra console line.
installReporting();

// the events socket (docs/status.md): one per browser, held in a shared worker, open on every
// page. here and not in a component: it is the page's for its whole life, and a crash that
// unmounts the Shell must not close it
startEvents();

// no picture lifts off as a ghost when dragged: nothing on these pages is a thing to drop
// anywhere. at the document, not on each <img>: that reaches the pre-react avatar card the api
// serves too (api/src/profile.rs), and works in firefox, which has no css for it
document.addEventListener('dragstart', (e) => {
  if (e.target instanceof HTMLImageElement) e.preventDefault();
});

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
