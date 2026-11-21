import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

/** The colours a group picks from, by name (the tooltip says the colour, not its hex): discord's blurple, then the fake streams' box colours. The colour box takes any other. */
export const GROUP_SWATCHES = [
  { hex: '#5865f2', name: 'blurple' },
  { hex: '#f85149', name: 'red' },
  { hex: '#3fb950', name: 'green' },
  { hex: '#f2cc60', name: 'yellow' },
  { hex: '#bc8cff', name: 'purple' },
  { hex: '#ff9f43', name: 'orange' },
  { hex: '#39d2c0', name: 'teal' },
  { hex: '#ff6bcb', name: 'pink' }
] as const;

/**
 * A group's colour: the swatches, then a square of the colour that is the browser's own picker
 * for any other. 24px squares, laid into the caller's flex row; the create dialog's and the
 * manage dialog's `color` section. `id` is the picker's.
 */
export function GroupColorPick({ id, value, onChange }: { id: string; value: string; onChange: (hex: string) => void }) {
  const color = value.toLowerCase();
  return (
    <>
      {GROUP_SWATCHES.map(({ hex, name }) => (
        <Tooltip key={hex} content={name}>
          <button
            type="button"
            aria-label={name}
            aria-pressed={hex === color}
            data-swatch={hex}
            onClick={() => onChange(hex)}
            style={{ backgroundColor: hex }}
            // the chosen one's ring is an outline: no box-shadow on this site
            className={cn('h-6 w-6 shrink-0 focus-visible:outline-primaryBlue', hex === color && 'outline outline-2 outline-offset-1 outline-textPrimary')}
          />
        </Tooltip>
      ))}
      <Tooltip content="more colors">
        {/* the native picker, unseen over a square of the colour; it opens on the click */}
        <label className="relative h-6 w-6 shrink-0 cursor-pointer border border-primaryStroke focus-within:border-primaryBlue" style={{ backgroundColor: color }}>
          <input
            id={id}
            type="color"
            value={color}
            onChange={(e) => onChange(e.target.value)}
            aria-label="more colors"
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </label>
      </Tooltip>
    </>
  );
}
