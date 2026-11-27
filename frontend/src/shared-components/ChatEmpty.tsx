import type { ReactNode } from 'react';

export function ChatEmpty({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="mt-auto text-center text-textTertiary">
      {children}
    </p>
  );
}
