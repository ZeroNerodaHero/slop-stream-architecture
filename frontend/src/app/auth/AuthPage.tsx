import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { type AuthMode, openAuthDialog } from '@/infra/atoms/auth-atoms';

interface AuthPageProps {
  mode: AuthMode;
}

function nextFrom(params: URLSearchParams): string {
  const next = params.get('next') ?? '/';
  if (!/^\/(?![/\\])/.test(next)) return '/';
  try {
    return new URL(next, location.origin).origin === location.origin ? next : '/';
  } catch {
    return '/';
  }
}

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
