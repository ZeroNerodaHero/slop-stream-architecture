import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { type AuthMode, openAuthDialog } from '@/infra/atoms/auth-atoms';

interface AuthPageProps {
  mode: AuthMode;
}

/**
 * Where to go after. Only a path on this site, so the `next` param cannot send you
 * elsewhere: not `//host`, not `/\host` (browsers read a backslash there as a slash),
 * not a full url. The resolved origin is checked too, so the regex is not the only wall.
 */
function nextFrom(params: URLSearchParams): string {
  const next = params.get('next') ?? '/';
  if (!/^\/(?![/\\])/.test(next)) return '/';
  try {
    return new URL(next, location.origin).origin === location.origin ? next : '/';
  } catch {
    return '/';
  }
}

/**
 * /login and /signup, kept as links: not a page any more, but the auth dialog (AuthDialog.tsx)
 * opened over `next` (home without one). The address moves to `next` at once, so a login, a
 * close or a reload all leave you there.
 */
export function AuthPage({ mode }: AuthPageProps) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = nextFrom(params);

  useEffect(() => {
    openAuthDialog(mode);
    navigate(next, { replace: true });
  }, [mode, next, navigate]);

  return null;
}
