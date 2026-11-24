import { RiCameraLine } from '@remixicon/react';

import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

export function PicturePick({
  id,
  label,
  reveal,
  className,
  icon = 28,
  onPick
}: {
  id: string;
  label: string;
  reveal: string;
  className?: string;
  icon?: number;
  onPick: (file: File) => void;
}) {
  return (
    <Tooltip content={label}>
      <label className="group/pick absolute inset-0 cursor-pointer">
        <span
          aria-hidden
          className={cn(
            'absolute flex items-center justify-center bg-black/50 text-white opacity-0 transition-opacity duration-150 group-has-[:focus-visible]/pick:opacity-100',
            '[@media(hover:none)]:items-end [@media(hover:none)]:justify-end [@media(hover:none)]:bg-transparent [@media(hover:none)]:p-1 [@media(hover:none)]:opacity-100',
            reveal,
            className
          )}
        >
          <span className="flex [@media(hover:none)]:bg-black/60 [@media(hover:none)]:p-1">
            <RiCameraLine size={icon} />
          </span>
        </span>
        <input
          id={id}
          type="file"
          accept="image/*"
          aria-label={label}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) onPick(file);
          }}
        />
      </label>
    </Tooltip>
  );
}
