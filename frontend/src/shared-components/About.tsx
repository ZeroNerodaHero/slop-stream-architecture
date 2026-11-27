import { useEffect, useState } from 'react';

import { type AboutPage, isBlank } from '@/infra/about-blocks';
import { api } from '@/infra/api';
import { useNarrow } from '@/shared-components/about/AboutGrid';
import { AboutEditor } from '@/shared-components/about/AboutEditor';
import { PageView } from '@/shared-components/about/PageView';

interface AboutProps {
  name: string;
  edit?: boolean;
  editing?: boolean;
  onEditing?: (on: boolean) => void;
  id?: string;
}

export function About({ name, edit = false, editing = false, onEditing, id }: AboutProps) {
  const box = id ?? `about-${name}`;
  const [page, setPage] = useState<AboutPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [tries, setTries] = useState(0);
  const [draft, setDraft] = useState<AboutPage | null>(null);
  const [status, setStatus] = useState('');
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const phone = useNarrow(frame);

  useEffect(() => {
    let live = true;
    api
      .aboutBlocks(name)
      .then((p) => {
        if (live) setPage(p);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [name, tries]);

  useEffect(() => {
    if (!editing) return;
    let live = true;
    api
      .aboutDraft(name)
      .then((d) => {
        if (!live) return;
        setStatus('');
        setDraft(d);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setStatus(err instanceof Error ? err.message : 'could not open the editor');
        onEditing?.(false);
      });
    return () => {
      live = false;
    };
  }, [editing, name, onEditing]);

  if (failed) {
    return (
      <p id={box} data-failed className="text-textSecondary">
        could not load the page.{' '}
        <button
          id="about-retry"
          type="button"
          className="text-primaryBlue hover:underline"
          onClick={() => {
            setFailed(false);
            setTries((n) => n + 1);
          }}
        >
          try again
        </button>
      </p>
    );
  }

  if (!page) return null;

  if (editing && draft) {
    return (
      <section id={box} aria-label={`edit about ${name}`}>
        <AboutEditor
          name={name}
          start={draft}
          meta={page}
          onClose={(live) => {
            setDraft(null);
            onEditing?.(false);
            if (live) setPage({ ...live, changed: undefined });
          }}
        />
      </section>
    );
  }

  const shown = page.blocks.filter((b) => !isBlank(b, page.socials.links.length));
  const statusLine = status && (
    <span role="status" className="text-sm text-textTertiary">
      {status}
    </span>
  );

  if (shown.length === 0) {
    if (!edit) {
      return (
        <p id={box} className="text-sm text-textSecondary">
          {name} hasn't made a page yet.
        </p>
      );
    }
    return (
      <div ref={setFrame} id={box} data-empty className="flex flex-col gap-3">
        <p className="text-sm text-textSecondary">nothing on your about yet.</p>
        {statusLine}
      </div>
    );
  }

  return (
    <div ref={setFrame} className="flex flex-col gap-3">
      <section id={box} aria-label={`about ${name}`}>
        <PageView blocks={page.blocks} meta={page} name={name} phone={phone} id={box} />
      </section>
      {edit && statusLine}
    </div>
  );
}
