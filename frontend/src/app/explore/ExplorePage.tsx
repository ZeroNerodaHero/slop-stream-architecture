import { useQuery } from '@tanstack/react-query';
import { useAtomValue } from 'jotai';
import { type ReactNode, useEffect, useState } from 'react';

import { api, groupMatches, mayMakeGroup, messageOf, type SearchHit, type Server } from '@/infra/api';
import { meAtom, openAuthDialog } from '@/infra/atoms/auth-atoms';
import { Button } from '@/shared-components/Button';
import { GROUP_SQUARE_BOX, GroupSquare } from '@/shared-components/GroupSquare';
import { MakeGroupDialog } from '@/shared-components/MakeGroupDialog';
import { PageFrame } from '@/shared-components/PageFrame';
import { PersonRow } from '@/shared-components/PersonRow';
import { Skeleton } from '@/shared-components/Skeleton';
import { cn } from '@/utils/cn';

const INPUT = 'min-w-0 flex-1 border border-primaryStroke bg-background px-3 py-2 text-base text-textPrimary placeholder:text-textTertiary';

const SQUARES = 'grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-3';
const SECTION_TITLE = 'mb-4 text-sm font-semibold uppercase tracking-wider text-textTertiary';
/** How many stand-in squares are drawn; the row shows as many as fit across and hides the rest. */
const SQUARES_GUESS = 6;

/**
 * The groups you are in, then the public ones you are not. `bot` is a badge, not one of these.
 * `create` is for a login under the cap on owned groups (the api's `groups_per_owner`), so
 * one at the cap is not offered another.
 */
export function ExplorePage() {
  const query = useQuery({ queryKey: ['explore'], queryFn: api.explore });
  const me = useAtomValue(meAtom);
  const [text, setText] = useState('');
  const [making, setMaking] = useState(false);
  // the letters the lists and the people query actually use: a beat after the last key
  const [q, setQ] = useState('');
  const [people, setPeople] = useState<SearchHit[] | null>([]);

  useEffect(() => {
    const t = window.setTimeout(() => setQ(text.trim().toLowerCase()), 200);
    return () => window.clearTimeout(t);
  }, [text]);

  useEffect(() => {
    if (!q) {
      setPeople([]);
      return;
    }
    let gone = false;
    setPeople(null);
    api
      .search(q)
      .then((hits) => {
        if (!gone) setPeople(hits);
      })
      .catch(() => {
        if (!gone) setPeople([]);
      });
    return () => {
      gone = true;
    };
  }, [q]);
  const yours = (query.data?.yours ?? []).filter((server) => groupMatches(server, q));
  const listed = (query.data?.discover ?? []).filter((server) => server.public !== false && groupMatches(server, q));
  // a login may make one once the list has said how many it owns, and how many it may
  const canMake = !!me && !!query.data && mayMakeGroup(query.data);

  return (
    <PageFrame title="groups" titleId="groups-title">
      <div className="mb-8 flex items-center gap-3">
        <label htmlFor="groups-search" className="sr-only">
          search groups
        </label>
        <input id="groups-search" value={text} onChange={(e) => setText(e.target.value)} placeholder="search" autoComplete="off" className={INPUT} />
        {canMake && (
          <Button id="groups-create" variant="primary" className="shrink-0 px-4 py-2 text-sm" onClick={() => setMaking(true)}>
            create
          </Button>
        )}
        {me === null && (
          <Button id="groups-create" variant="primary" className="shrink-0 px-4 py-2 text-sm" onClick={() => openAuthDialog('login')}>
            log in to create
          </Button>
        )}
      </div>
      {making && <MakeGroupDialog onClose={() => setMaking(false)} />}
      {query.error && (
        <p className="border border-decrease/40 bg-decrease/10 px-5 py-4 text-textSecondary" aria-live="polite">
          {messageOf(query.error)}
        </p>
      )}
      {/* before the first answer: both headings, each over a row of grey squares, so the page has its shape and the squares land where the grey was */}
      {!query.data && !query.error && (
        <Skeleton id="groups-loading" className="flex flex-col gap-10">
          {['yours', 'public'].map((title) => (
            <section key={title}>
              <h2 className={SECTION_TITLE}>{title}</h2>
              <SquaresRow pulse />
            </section>
          ))}
        </Skeleton>
      )}
      {q && (
        <section id="people" aria-label="people" className="mb-10">
          <h2 className={SECTION_TITLE}>people</h2>
          {people === null ? (
            <p className="text-textSecondary">looking</p>
          ) : people.length === 0 ? (
            <p className="text-textSecondary">nobody</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {people.map((hit) => (
                <li key={hit.name}>
                  <PersonRow id={`person-${hit.name}`} name={hit.name} verified={hit.verified} oauthVerified={hit.oauth_verified} avatar={hit.avatar} bio={hit.bio} presence={hit.presence} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {query.data && (
        <div id="groups" className="flex flex-col gap-10">
          <Section
            id="yours"
            title="yours"
            empty={
              q ? (
                'nothing in yours matches'
              ) : canMake ? (
                <>
                  you are not in a group yet,{' '}
                  <button id="groups-empty-make" type="button" className="font-semibold text-primaryBlue hover:underline" onClick={() => setMaking(true)}>
                    make one
                  </button>
                </>
              ) : (
                'you are not in a group yet'
              )
            }
            servers={yours}
          />
          <Section id="public" title="public" empty={q ? 'nothing public matches' : 'no public groups to find'} servers={listed} />
        </div>
      )}
    </PageFrame>
  );
}

/**
 * One row of stand-in squares on the real squares' grid and box: as many as fit across, the
 * rest cut off (extra rows are 0 tall, with no gap between rows). Still when a list is empty;
 * breathing, where motion is welcome, while the lists are on their way.
 */
function SquaresRow({ pulse = false }: { pulse?: boolean }) {
  return (
    <div aria-hidden className={cn(SQUARES, 'grid-rows-1 auto-rows-[0] gap-y-0 overflow-hidden')}>
      {Array.from({ length: SQUARES_GUESS }, (_, i) => (
        <span key={i} className={cn(GROUP_SQUARE_BOX, pulse && 'motion-safe:animate-pulse')} />
      ))}
    </div>
  );
}

function Section({ id, title, empty, servers }: { id: string; title: string; empty: ReactNode; servers: Server[] }) {
  return (
    <section id={id} aria-label={title}>
      <h2 className={SECTION_TITLE}>{title}</h2>
      {servers.length === 0 ? (
        // the words over the middle of the empty row
        <div className="relative">
          <SquaresRow />
          <p className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-textSecondary">
            <span>{empty}</span>
          </p>
        </div>
      ) : (
        <ul className={SQUARES}>
          {servers.map((server) => (
            <GroupSquare key={server.name} server={server} id={`server-open-${server.name}`} />
          ))}
        </ul>
      )}
    </section>
  );
}
