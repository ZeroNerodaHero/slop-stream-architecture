import { useQuery } from '@tanstack/react-query';
import { memo, useEffect } from 'react';

import { CARD, CARD_LINK } from '@/app/home/cards';
import { api, type Person } from '@/infra/api';
import { FollowButton } from '@/shared-components/FollowButton';
import { PageFrame } from '@/shared-components/PageFrame';
import { PersonRow } from '@/shared-components/PersonRow';
import { Bone, Skeleton } from '@/shared-components/Skeleton';
import { cn } from '@/utils/cn';

const POLL_MS = 10_000;
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3';
const GUESS = 8;

const PersonTile = memo(function PersonTile({ person: p }: { person: Person }) {
  return (
    <article id={`person-${p.name}`} data-presence={p.presence} className={cn(CARD_LINK, 'flex items-center gap-2 p-3')}>
      <PersonRow
        id={`person-link-${p.name}`}
        name={p.name}
        verified={p.verified}
        oauthVerified={p.oauth_verified}
        avatar={p.avatar}
        bio={p.bio}
        presence={p.presence}
        size="card"
      />
      <FollowButton id={`person-follow-${p.name}`} name={p.name} small className="self-start" />
    </article>
  );
});

function useNoIndex() {
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.append(meta);
    return () => meta.remove();
  }, []);
}

export function PeoplePage() {
  useNoIndex();
  const people = useQuery({ queryKey: ['people'], queryFn: api.people, refetchInterval: POLL_MS });
  const list = people.data ?? [];
  const here = list.filter((p) => p.presence !== 'offline').length;
  return (
    <PageFrame
      wide
      title="people"
      titleId="people-title"
      aside={
        people.data && (
          <span className="flex items-center gap-2 text-base text-textSecondary">
            <span id="people-count">{list.length}</span>
            {here > 0 && (
              <>
                <span aria-hidden>·</span>
                <span id="people-here" className="text-increase">
                  {here} here
                </span>
              </>
            )}
          </span>
        )
      }
    >
      <section id="people" aria-labelledby="people-title">
        {people.isPending ? (
          <Skeleton id="people-loading" className={GRID}>
            {Array.from({ length: GUESS }, (_, i) => (
              <div key={i} className={cn(CARD, 'flex items-center gap-3 p-3')}>
                <Bone className="h-12 w-12 shrink-0 rounded-avatar" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Bone className="h-4 w-1/2" />
                  <Bone className="h-3 w-1/3" />
                </div>
              </div>
            ))}
          </Skeleton>
        ) : list.length === 0 ? (
          <p id="people-empty" className="text-textSecondary">
            {people.isError ? 'could not load people.' : 'nobody here yet.'}
          </p>
        ) : (
          <div id="people-list" className={GRID}>
            {list.map((p) => (
              <PersonTile key={p.name} person={p} />
            ))}
          </div>
        )}
      </section>
    </PageFrame>
  );
}
