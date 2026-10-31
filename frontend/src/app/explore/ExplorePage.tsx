import { useQuery } from '@tanstack/react-query';
import { useAtomValue } from 'jotai';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, mayMakeGroup, messageOf, type SearchHit, type Server } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { Button, buttonClassName } from '@/shared-components/Button';
import { GroupSquare } from '@/shared-components/GroupSquare';
import { MakeGroupDialog } from '@/shared-components/MakeGroupDialog';
import { PageFrame } from '@/shared-components/PageFrame';
import { PersonRow } from '@/shared-components/PersonRow';
import { Bone, Skeleton } from '@/shared-components/Skeleton';

const INPUT = 'min-w-0 flex-1 border border-primaryStroke bg-background px-3 py-2 text-base text-textPrimary placeholder:text-textTertiary';

const SQUARES = 'grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-3';
const SECTION_TITLE = 'mb-4 text-sm font-semibold uppercase tracking-wider text-textTertiary';
/** How many grey squares stand under each heading before the lists have answered. */
const SQUARES_GUESS = 4;

function matches(server: Server, query: string): boolean {
  if (!query) return true;
  const tag = server.tag == null ? '' : String(server.tag).padStart(4, '0');
  return `${server.title || ''} ${tag} ${tag ? `#${tag}` : ''} ${server.name} ${server.badge} ${server.about}`.toLowerCase().includes(query);
}

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
  const yours = (query.data?.yours ?? []).filter((server) => matches(server, q));
  const listed = (query.data?.discover ?? []).filter((server) => server.public !== false && matches(server, q));
  // a login may make one once the list has said how many it owns, and how many it may
  const canMake = !!me && !!query.data && mayMakeGroup(query.data);

  return (
    <PageFrame title="groups" titleId="groups-title">
      <div className="mb-8 flex items-center gap-3">
        <label htmlFor="groups-search" className="sr-only">
          search groups
        </label>
        <input id="groups-search" value={text} onChange={(e) => setText(e.target.value)} placeholder="search groups and people" autoComplete="off" className={INPUT} />
        {canMake && (
          <Button id="groups-create" variant="primary" className="shrink-0 px-4 py-2 text-sm" onClick={() => setMaking(true)}>
            create
          </Button>
        )}
        {me === null && (
          <Link id="groups-create" to="/login" className={buttonClassName('primary', 'shrink-0 px-4 py-2 text-sm')}>
            log in to create
          </Link>
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
              <div className={SQUARES}>
                {Array.from({ length: SQUARES_GUESS }, (_, i) => (
                  <Bone key={i} className="aspect-square" />
                ))}
              </div>
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
                  <PersonRow id={`person-${hit.name}`} name={hit.name} verified={hit.verified} avatar={hit.avatar} bio={hit.bio} presence={hit.presence} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {query.data && (
        <div id="groups" className="flex flex-col gap-10">
          <Section id="yours" title="yours" empty={q ? 'nothing in yours matches' : 'you are not in a group yet'} servers={yours} />
          <Section id="public" title="public" empty={q ? 'nothing public matches' : 'no public groups to find'} servers={listed} />
        </div>
      )}
    </PageFrame>
  );
}

function Section({ id, title, empty, servers }: { id: string; title: string; empty: string; servers: Server[] }) {
  return (
    <section id={id} aria-label={title}>
      <h2 className={SECTION_TITLE}>{title}</h2>
      {servers.length === 0 ? (
        <p className="text-textSecondary">{empty}</p>
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
