/**
 * A people search of a box's own: the sidebar's way (follow-atoms.ts `setSearchQuery`) without
 * its atoms, so a box elsewhere (the mod tab's) does not drive the sidebar. The letters are
 * cleaned as the api cleans them (`cleanSearch`), `GET /api/search` is asked a beat after the
 * last one, and each answer is kept a short while: letters seen, or more letters than an answer
 * that was complete, are shown without asking. People only; groups are the sidebar's.
 */

import { useEffect, useState } from 'react';

import { api, cleanSearch, nameMatches, SEARCH_ANYWHERE_FROM, SEARCH_LIMIT, type SearchHit } from '@/infra/api';
import { PRESENCE_RANK } from '@/infra/atoms/presence-atoms';

/** The sidebar's wait and freshness (follow-atoms.ts). */
const SEARCH_WAIT_MS = 200;
const SEARCH_FRESH_MS = 30_000;

/** Answers by the letters asked, shared by every box using the hook. */
const answers = new Map<string, { hits: SearchHit[]; at: number }>();

export interface PeopleSearch {
  /** The cleaned letters the hits are for. */
  q: string;
  hits: SearchHit[];
  /** The api has answered these very letters (or there were none): no hits means nobody called that. */
  settled: boolean;
}

/** The sidebar's order: the exact name, whoever is here, names starting with the letters, accounts, then by name. */
function order(hits: SearchHit[], q: string): SearchHit[] {
  return hits.toSorted(
    (a, b) =>
      Number(b.name === q) - Number(a.name === q) ||
      PRESENCE_RANK[a.presence] - PRESENCE_RANK[b.presence] ||
      Number(b.name.startsWith(q)) - Number(a.name.startsWith(q)) ||
      Number(b.verified) - Number(a.verified) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  );
}

/** What is in hand for `q`: a fresh answer for it (settled), or a complete one for fewer letters cut down to it, or nothing yet. */
function recall(q: string): PeopleSearch {
  if (!q) return { q, hits: [], settled: true };
  const now = Date.now();
  const kept = answers.get(q);
  if (kept && now - kept.at < SEARCH_FRESH_MS) return { q, hits: order(kept.hits, q), settled: true };
  const anywhere = q.length >= SEARCH_ANYWHERE_FROM;
  for (const [letters, answer] of answers) {
    if (now - answer.at >= SEARCH_FRESH_MS || answer.hits.length >= SEARCH_LIMIT) continue;
    if (letters.length >= SEARCH_ANYWHERE_FROM !== anywhere) continue;
    if (anywhere ? q.includes(letters) : q.startsWith(letters)) {
      return {
        q,
        hits: order(
          answer.hits.filter((hit) => nameMatches(hit.name, q)),
          q
        ),
        settled: false
      };
    }
  }
  return { q, hits: [], settled: false };
}

/** The people a box's letters find, as they stand: what is in hand at once, the api's answer a beat after the last letter. */
export function usePeopleSearch(raw: string): PeopleSearch {
  const q = cleanSearch(raw);
  // bumped when an answer lands, so `recall` reads it; `failed` settles letters the api refused
  const [, setAnswered] = useState(0);
  const [failed, setFailed] = useState('');

  useEffect(() => {
    if (recall(q).settled) return;
    let gone = false;
    const timer = window.setTimeout(() => {
      api.search(q).then(
        (hits) => {
          const now = Date.now();
          for (const [letters, answer] of answers) {
            if (now - answer.at >= SEARCH_FRESH_MS) answers.delete(letters);
          }
          answers.set(q, { hits, at: now });
          if (!gone) setAnswered((n) => n + 1);
        },
        () => {
          if (!gone) setFailed(q);
        }
      );
    }, SEARCH_WAIT_MS);
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [q]);

  const now = recall(q);
  return failed === q && !now.settled ? { q, hits: [], settled: true } : now;
}
