import { isRouteErrorResponse, useRouteError } from 'react-router-dom';

import { Button } from '@/shared-components/Button';
import { HomeLink } from '@/shared-components/PageFrame';

/**
 * What a render crash shows instead of react router's default page. The report already
 * went out through the RouterProvider's onError in main.tsx. No PageFrame here on purpose:
 * if the header itself is what crashed, this page must not render it again.
 */
export function CrashPage() {
  const err = useRouteError();
  const message = isRouteErrorResponse(err) ? `${err.status} ${err.statusText}` : err instanceof Error ? err.message : String(err);
  return (
    <main className="mx-auto max-w-[960px] px-5 pb-16 pt-6">
      <header className="mb-6 flex flex-wrap items-center gap-4 border-b border-primaryStroke pb-4">
        <HomeLink reload />
        <h1 className="min-w-0 border-l-4 border-decrease pl-3 text-[1.75rem] font-semibold leading-tight">something broke</h1>
      </header>
      <p className="text-textSecondary">a report went out. a reload usually fixes it.</p>
      <pre id="crash" className="mt-3 whitespace-pre-wrap text-sm text-textTertiary [overflow-wrap:anywhere]">
        {message}
      </pre>
      <Button variant="primary" className="mt-5" onClick={() => location.reload()}>
        reload
      </Button>
    </main>
  );
}
