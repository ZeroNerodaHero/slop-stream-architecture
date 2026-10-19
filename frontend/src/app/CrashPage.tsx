import { Link, isRouteErrorResponse, useRouteError } from 'react-router-dom';

import { Button } from '@/shared-components/Button';

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
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-[28px] font-semibold">something broke</h1>
        <Link to="/" reloadDocument>
          home
        </Link>
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
