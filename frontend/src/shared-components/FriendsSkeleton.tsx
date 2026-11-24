import type { PanelSide } from '@/infra/atoms/settings-atoms';
import { Bone, Skeleton } from '@/shared-components/Skeleton';
import { cn } from '@/utils/cn';

const FACES_GUESS = 4;

export const INSET: Record<PanelSide, string> = {
  left: 'pl-[calc(0.75rem-1px)] pr-2 max-md:pl-[calc(1.25rem-1px)]',
  right: 'pr-[calc(0.75rem-1px)] pl-2 max-md:pr-[calc(1.25rem-1px)]'
};
export const RAIL_FACE = 'h-8 w-8 text-sm max-md:h-10 max-md:w-10 max-md:text-lg';
export const FACE_COLUMN_W = 'w-[calc(2rem+2px)] max-md:w-[calc(2.5rem+2px)]';
export const MIN_GAP = 4;
export const TOP_EXTRA_PX = 4;

export function FollowingSkeleton({ side, open }: { side: PanelSide; open: boolean }) {
  const mirrored = side === 'right';
  return (
    <Skeleton id="friends-loading" className="flex flex-col gap-2">
      {Array.from({ length: FACES_GUESS }, (_, i) => (
        <div key={i} className={cn('flex items-center gap-2', mirrored && 'flex-row-reverse', INSET[side])}>
          <Bone className={cn('h-[calc(2rem+2px)] shrink-0 max-md:h-11', FACE_COLUMN_W)} />
          {open && <Bone className="h-3.5 w-24" />}
        </div>
      ))}
    </Skeleton>
  );
}

export function FriendsSkeleton({ side, open }: { side: PanelSide; open: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className={cn('shrink-0', INSET[side])} style={{ paddingTop: MIN_GAP + TOP_EXTRA_PX, paddingBottom: MIN_GAP }}>
        <Bone className={cn('h-8 max-md:h-10', open ? 'w-full' : FACE_COLUMN_W, side === 'right' && 'ml-auto')} />
      </div>
      <FollowingSkeleton side={side} open={open} />
    </div>
  );
}
