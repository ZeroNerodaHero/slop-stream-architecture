import { useAtomValue } from 'jotai';
import { useEffect, useMemo, useState } from 'react';

import { api } from '@/infra/api';
import { keptModelsAtom, type ModelChoice } from '@/infra/atoms/publish-atoms';
import { colorOf } from '@/shared-components/GeneratedAvatar';

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

export function KeptPicture({ picture }: { picture: Blob }) {
  const url = useMemo(() => URL.createObjectURL(picture), [picture]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <img src={url} alt="" draggable={false} className="block h-full w-full object-cover" />;
}

export function ModelPicture({ choice }: { choice: ModelChoice }) {
  const kept = useAtomValue(keptModelsAtom);
  const [missing, setMissing] = useState(false);
  if (choice.kind === 'demo' && !missing) {
    return <img src={api.demoModelThumbUrl(choice)} alt="" draggable={false} onError={() => setMissing(true)} className="block h-full w-full object-cover" />;
  }
  const thumb = choice.kind === 'kept' ? kept.find((model) => model.id === choice.id)?.thumb : null;
  return thumb ? <KeptPicture picture={thumb} /> : <LetterTile name={choice.name} />;
}
