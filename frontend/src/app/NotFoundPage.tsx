import { PageFrame } from '@/shared-components/PageFrame';

export function NotFoundPage() {
  return (
    <PageFrame title="not here">
      <p className="text-textSecondary">that page does not exist.</p>
    </PageFrame>
  );
}
