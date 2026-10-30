import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAtomValue } from 'jotai';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type MouseEvent, type PointerEvent } from 'react';
import { Link } from 'react-router-dom';

import { api, messageOf, type SearchHit, type Server } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { createGroup, groupsBusyAtom, groupsStatusAtom } from '@/infra/atoms/groups-atoms';
import { cleanName, isValidName } from '@/infra/names';
import { Badge } from '@/shared-components/Badge';
import { Button, buttonClassName } from '@/shared-components/Button';
import { GroupSquare } from '@/shared-components/GroupSquare';
import { PageFrame } from '@/shared-components/PageFrame';
import { PersonRow } from '@/shared-components/PersonRow';
import { Bone, Skeleton } from '@/shared-components/Skeleton';
import { cn } from '@/utils/cn';

const INPUT = 'min-w-0 flex-1 border border-primaryStroke bg-background px-3 py-2 text-base text-textPrimary placeholder:text-textTertiary';

const SQUARES = 'grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-3';
const SECTION_TITLE = 'mb-4 text-sm font-semibold uppercase tracking-wider text-textTertiary';
/** How many grey squares stand under each heading before the lists have answered. */
const SQUARES_GUESS = 4;

/** The colours a new group starts from. The colour box takes any other. Same eight as the groups tab. */
const SWATCHES = ['#5865f2', '#f85149', '#3fb950', '#f2cc60', '#bc8cff', '#ff9f43', '#39d2c0', '#ff6bcb'] as const;

function matches(server: Server, query: string): boolean {
  if (!query) return true;
  const tag = server.tag == null ? '' : String(server.tag).padStart(4, '0');
  return `${server.title || ''} ${tag} ${tag ? `#${tag}` : ''} ${server.name} ${server.badge} ${server.about}`.toLowerCase().includes(query);
}

/** The groups you are in, then the public ones you are not. `bot` is a badge, not one of these. */
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

  return (
    <PageFrame title="groups" titleId="groups-title">
      <div className="mb-8 flex items-center gap-3">
        <label htmlFor="groups-search" className="sr-only">
          search groups
        </label>
        <input
          id="groups-search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="search groups and people"
          autoComplete="off"
          className={INPUT}
        />
        {me ? (
          <Button id="groups-create" variant="primary" className="shrink-0 px-4 py-2 text-sm" onClick={() => setMaking(true)}>
            create
          </Button>
        ) : (
          me === null && (
            <Link id="groups-create" to="/login" className={buttonClassName('primary', 'shrink-0 px-4 py-2 text-sm')}>
              log in to create
            </Link>
          )
        )}
      </div>
      {making && <MakeGroup onClose={() => setMaking(false)} />}
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

function MakeGroup({ onClose }: { onClose: () => void }) {
  const busy = useAtomValue(groupsBusyAtom);
  const status = useAtomValue(groupsStatusAtom);
  const qc = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const pressedBackdrop = useRef(false);
  const [name, setName] = useState('');
  const [badge, setBadge] = useState('');
  const [color, setColor] = useState<string>(SWATCHES[0]);
  const [about, setAbout] = useState('');
  const [isPublic, setPublic] = useState(true);
  const [spoke, setSpoke] = useState(false);
  const clean = cleanName(name);
  const badgeChars = [...badge.trim()].length;
  const ok = isValidName(clean) && badgeChars >= 1 && badgeChars <= 12;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('#groups-make-name')?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ok || busy) return;
    setSpoke(true);
    const made = await createGroup({ name: clean, badge: badge.trim(), color, about: about.trim(), public: isPublic });
    if (!made) return;
    await qc.invalidateQueries({ queryKey: ['explore'] });
    onClose();
  }

  const onPointerDown = (e: PointerEvent<HTMLDialogElement>) => {
    pressedBackdrop.current = e.target === e.currentTarget;
  };
  const onClick = (e: MouseEvent<HTMLDialogElement>) => {
    if (pressedBackdrop.current && e.target === e.currentTarget) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      id="groups-make"
      aria-labelledby="groups-make-title"
      onPointerDown={onPointerDown}
      onClick={onClick}
      onClose={onClose}
      className="m-auto w-[min(520px,calc(100vw-3rem))] border border-primaryStroke bg-backgroundSecondary p-6 text-base text-textPrimary backdrop:bg-black/60"
    >
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <h2 id="groups-make-title" className="text-sm font-semibold uppercase tracking-wider text-textTertiary">
          make a group
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="groups-make-name"
            value={name}
            onChange={(e) =>
              setName(
                e.target.value
                  .toLowerCase()
                  .replace(/[^a-z0-9_-]/g, '')
                  .slice(0, 32)
              )
            }
            placeholder="name"
            maxLength={32}
            autoComplete="off"
            aria-label="group name"
            className={INPUT}
          />
          <input
            id="groups-make-badge"
            value={badge}
            onChange={(e) => setBadge(e.target.value)}
            placeholder="badge"
            maxLength={12}
            autoComplete="off"
            aria-label="badge"
            className={cn(INPUT, 'max-w-40')}
          />
        </div>
        <input
          id="groups-make-about"
          value={about}
          onChange={(e) => setAbout(e.target.value)}
          placeholder="about, optional"
          maxLength={200}
          autoComplete="off"
          aria-label="about"
          className={INPUT}
        />
        <div className="flex flex-wrap items-center gap-2">
          {SWATCHES.map((swatch) => (
            <button
              key={swatch}
              type="button"
              aria-label={swatch}
              aria-pressed={swatch === color}
              onClick={() => setColor(swatch)}
              style={{ backgroundColor: swatch }}
              className={cn('h-8 w-8 border-2', swatch === color ? 'border-textPrimary' : 'border-transparent')}
            />
          ))}
          <input id="groups-make-color" type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="any other colour" className="h-8 w-12 cursor-pointer border border-primaryStroke bg-background p-0.5" />
          <Badge group={{ name: clean || 'new', badge: badge.trim() || 'badge', color }} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            id="groups-make-public"
            type="button"
            aria-pressed={isPublic}
            onClick={() => setPublic(true)}
            className={cn('text-sm font-semibold', isPublic ? 'text-primaryBlue' : 'text-textTertiary')}
          >
            public
          </button>
          <button
            id="groups-make-private"
            type="button"
            aria-pressed={!isPublic}
            onClick={() => setPublic(false)}
            className={cn('text-sm font-semibold', !isPublic ? 'text-primaryBlue' : 'text-textTertiary')}
          >
            private
          </button>
          <p className="text-sm text-textTertiary">a private group is left off the lists. someone with the address can still open it and join. four digits are added, so the same name can be made twice. the owner can switch this later, on the group.</p>
        </div>
        <div className="flex items-center justify-end gap-3">
          <button type="button" className="text-sm text-textTertiary" onClick={onClose}>
            cancel
          </button>
          <Button id="groups-make-submit" type="submit" variant="primary" className="px-3 py-1.5 text-sm" disabled={!ok || busy}>
            make it
          </Button>
        </div>
        {spoke && status && (
          <p id="groups-make-status" className="text-sm text-textSecondary">
            {status}
          </p>
        )}
      </form>
    </dialog>
  );
}
