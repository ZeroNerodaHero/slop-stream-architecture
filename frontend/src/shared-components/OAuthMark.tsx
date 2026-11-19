import { RiVerifiedBadgeFill } from '@remixicon/react';

import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

/** What the mark means, in the tooltip and the security tab. Any provider counts (api/src/oauth.rs `linked_sql!`). */
export const OAUTH_MARK_WORDS = 'verified: a Google or Discord login is linked to this account';

/**
 * The verified mark: the account has an outside login linked (Google, Discord, any provider the
 * api adds later). Beside the ✓, which says only that the name has an account. Blue, a badge,
 * so the two never read as one.
 */
export function OAuthMark({ className, size = 16, id }: { className?: string; size?: number; id?: string }) {
  return (
    <Tooltip content={OAUTH_MARK_WORDS}>
      <span id={id} role="img" aria-label="verified" data-oauth-verified className={cn('inline-flex shrink-0 items-center text-primaryBlue', className)}>
        <RiVerifiedBadgeFill aria-hidden size={size} />
      </span>
    </Tooltip>
  );
}
