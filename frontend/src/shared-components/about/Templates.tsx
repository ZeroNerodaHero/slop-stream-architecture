import { TEMPLATES, type Template } from '@/infra/about-blocks';
import { cn } from '@/utils/cn';

import { NEUTRAL } from './BlockView';

const BAR = 'h-2.5 rounded-control bg-backgroundTertiary';

function Mini({ k }: { k: Template['key'] }) {
  if (k === 'panels')
    return (
      <div className="grid grid-cols-3 gap-1">
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className="h-4 rounded-control bg-backgroundTertiary" />
        ))}
      </div>
    );
  if (k === 'bio')
    return (
      <div className="flex flex-col gap-1">
        <span className={cn(BAR, 'bg-[#2a3a6a]')} />
        <span className={BAR} />
        <span className={BAR} />
        <span className={BAR} />
      </div>
    );
  if (k === 'banner')
    return (
      <div className="flex flex-col gap-1">
        <span className="h-4 rounded-control" style={{ backgroundImage: NEUTRAL }} />
        <div className="grid grid-cols-2 gap-1">
          <span className={BAR} />
          <span className={BAR} />
        </div>
      </div>
    );
  return <span className="block h-9 rounded-control border border-dashed border-secondaryStroke" />;
}

export function TemplatePicker({ onPick, id = 'about-templates' }: { onPick: (key: Template['key']) => void; id?: string }) {
  return (
    <ul id={id} className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-4">
      {TEMPLATES.map((t) => (
        <li key={t.key} className="min-w-0">
          <button
            id={`${id}-${t.key}`}
            type="button"
            onClick={() => onPick(t.key)}
            className="flex h-full w-full flex-col gap-2.5 rounded-card border border-primaryStroke bg-backgroundSecondary p-2.5 text-left transition-colors hover:border-primaryBlue focus-visible:border-primaryBlue focus-visible:outline-none"
          >
            <div className="flex h-9 flex-col justify-center">
              <Mini k={t.key} />
            </div>
            <span className="text-sm font-bold text-textPrimary">{t.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
