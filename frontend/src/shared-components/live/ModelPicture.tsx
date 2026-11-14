import { useAtomValue } from 'jotai';
import { useEffect, useMemo, useState } from 'react';

import { api } from '@/infra/api';
import { keptModelsAtom, type ModelChoice } from '@/infra/atoms/publish-atoms';
import { colorOf } from '@/shared-components/GeneratedAvatar';

/** A model with no picture of its own: the letter its name starts with, on the colour its name makes. */
export function LetterTile({ name }: { name: string }) {
  const key = name.trim().toLowerCase();
  return (
    <svg viewBox="0 0 100 100" aria-hidden className="block h-full w-full" style={{ backgroundColor: colorOf(key || 'model') }}>
      <text x="50" y="50" textAnchor="middle" dominantBaseline="central" fontSize="48" fontWeight="600" fill="white">
        {key ? [...key][0]!.toUpperCase() : '?'}
      </text>
    </svg>
  );
}

/** A kept model's picture: bytes out of this browser, shown through a url that lives as long as this does. */
export function KeptPicture({ picture }: { picture: Blob }) {
  const url = useMemo(() => URL.createObjectURL(picture), [picture]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <img src={url} alt="" draggable={false} className="block h-full w-full object-cover" />;
}

/**
 * A model's picture from what was picked, for where there is no card to take it from: a demo
 * model's thumbnail off the api (the letter when it has none, or the server is away), one of
 * their own's off this browser's shelf. Keyed by the model where it is used: what it learnt
 * about one model's picture is not true of the next.
 */
export function ModelPicture({ choice }: { choice: ModelChoice }) {
  const kept = useAtomValue(keptModelsAtom);
  const [missing, setMissing] = useState(false);
  if (choice.kind === 'demo' && !missing) {
    return <img src={api.demoModelThumbUrl(choice)} alt="" draggable={false} onError={() => setMissing(true)} className="block h-full w-full object-cover" />;
  }
  const thumb = choice.kind === 'kept' ? kept.find((model) => model.id === choice.id)?.thumb : null;
  return thumb ? <KeptPicture picture={thumb} /> : <LetterTile name={choice.name} />;
}
