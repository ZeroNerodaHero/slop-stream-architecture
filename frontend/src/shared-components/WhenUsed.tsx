import { type ReactNode, Suspense, useState } from 'react';

export function WhenUsed({ on, fallback = null, children }: { on: boolean; fallback?: ReactNode; children: ReactNode }) {
  const [used, setUsed] = useState(on);
  if (on && !used) setUsed(true);
  if (!used) return null;
  return <Suspense fallback={fallback}>{children}</Suspense>;
}
