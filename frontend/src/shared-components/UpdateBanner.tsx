import { RiCloseLine } from '@remixicon/react';
import { useEffect, useState } from 'react';

import { type NativeUpdate, progressText, watchUpdates } from '@/infra/update-check';
import { Button } from '@/shared-components/Button';
import { Tooltip } from '@/shared-components/Tooltip';

type Install = { at: 'idle' } | { at: 'downloading'; text: string } | { at: 'failed' };

const ACTION = 'h-6 shrink-0 py-0 max-md:min-h-0';

const DISMISS =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-control border border-transparent text-background/80 hover:border-background/60 hover:text-background focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-background';

export function UpdateBanner() {
  const [build, setBuild] = useState<string | null>(null);
  const [native, setNative] = useState<NativeUpdate | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [install, setInstall] = useState<Install>({ at: 'idle' });

  useEffect(() => watchUpdates(__BUILD__, setBuild, setNative), []);

  const shown = native ? `native:${native.version}` : build ? `web:${build}` : null;
  if (!shown || shown === dismissed) return null;

  const update = async () => {
    if (!native) return;
    setInstall({ at: 'downloading', text: progressText(0, null) });
    try {
      await native.install((done, total) => setInstall({ at: 'downloading', text: progressText(done, total) }));
    } catch {
      setInstall({ at: 'failed' });
    }
  };

  const text = !native
    ? 'a new version is out'
    : install.at === 'downloading'
      ? install.text
      : install.at === 'failed'
        ? 'the update did not install'
        : `nodentity ${native.version} is out`;

  return (
    <div
      id="update-banner"
      className="fixed inset-x-0 top-0 z-40 flex min-h-8 w-full items-center gap-2 bg-primaryBlue pb-1 pl-[calc(0.75rem+env(safe-area-inset-left))] pr-[calc(0.75rem+env(safe-area-inset-right))] pt-[calc(0.25rem+env(safe-area-inset-top))] font-sans text-sm text-background"
    >
      <p role="status" className="min-w-0 flex-1 truncate font-medium">
        {text}
      </p>
      {!native && (
        <Button id="update-reload" size="sm" className={ACTION} onClick={() => location.reload()}>
          reload
        </Button>
      )}
      {native && install.at !== 'downloading' && (
        <Button id="update-install" size="sm" className={ACTION} onClick={() => void update()}>
          {install.at === 'failed' ? 'retry' : 'update and restart'}
        </Button>
      )}
      {install.at !== 'downloading' && (
        <Tooltip content="dismiss">
          <button id="update-dismiss" type="button" aria-label="dismiss" onClick={() => setDismissed(shown)} className={DISMISS}>
            <RiCloseLine aria-hidden size={16} />
          </button>
        </Tooltip>
      )}
    </div>
  );
}
