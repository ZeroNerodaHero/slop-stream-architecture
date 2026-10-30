import { RiCameraLine } from '@remixicon/react';

import { cn } from '@/utils/cn';

/**
 * The way to a new picture, on the picture itself: the whole picture is the click. Sits over a
 * picture in a `relative` parent with a named group (`group/x`). With the pointer over it
 * (`reveal`: the parent's `group-hover/x:opacity-100`), or the input in keyboard focus, the
 * picture greys and a camera sits in the middle of it. A screen with no hover gets the camera
 * small in the corner instead, all the time, and no grey. `label` is the input's name and the
 * tooltip. The crop dialog takes the file from here. The group's pictures, your own picture
 * and the offline picture are all changed this way; a remove, where there is one, is a word
 * beside the picture.
 */
export function PicturePick({ id, label, reveal, className, onPick }: { id: string; label: string; reveal: string; className?: string; onPick: (file: File) => void }) {
  return (
    <label className="group/pick absolute inset-0 cursor-pointer" title={label}>
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
          <RiCameraLine size={28} />
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
  );
}
