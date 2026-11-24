import { useState } from 'react';

import { Face } from '@/shared-components/Face';
import { cn } from '@/utils/cn';

const BLURRED = 'absolute inset-0 h-full w-full scale-125 object-cover blur-xl';

interface BlurredPictureProps {
  name: string;
  version: number | null;
  src?: string | null;
  className?: string;
}

export function BlurredPicture({ name, version, src = null, className }: BlurredPictureProps) {
  const [broken, setBroken] = useState<string | null>(null);
  const picture = src !== broken ? src : null;
  return (
    <span aria-hidden className={cn('absolute inset-0 overflow-hidden', className)}>
      {picture ? (
        <img src={picture} alt="" draggable={false} className={BLURRED} onError={() => setBroken(picture)} />
      ) : (
        <Face name={name} version={version} className={cn(BLURRED, 'text-6xl')} />
      )}
      <span className="absolute inset-0 bg-black/40" />
    </span>
  );
}
