import { Link } from 'react-router-dom';

import { PageFrame } from '@/shared-components/PageFrame';

export function NotFoundPage() {
  return (
    <PageFrame title="not here" aside={<Link to="/">home</Link>}>
      <p className="text-textSecondary">that page does not exist.</p>
    </PageFrame>
  );
}
