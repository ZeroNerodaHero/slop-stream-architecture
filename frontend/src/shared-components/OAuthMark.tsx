import { RiVerifiedBadgeFill } from '@remixicon/react';

import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

export const OAUTH_MARK_WORDS = 'verified: a Google or Discord login is linked to this account';

export function OAuthMark({ className, size = 16, id }: { className?: string; size?: number; id?: string }) {
  return (
    <Tooltip content={OAUTH_MARK_WORDS}>
      <span id={id} role="img" aria-label="verified" data-oauth-verified className={cn('inline-flex shrink-0 items-center text-primaryBlue', className)}>
        <RiVerifiedBadgeFill aria-hidden size={size} />
      </span>
    </Tooltip>
  );
}
