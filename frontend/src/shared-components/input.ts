/**
 * A box to type in, everywhere: 30px tall (16px text on a snug line, 3px above and below), on the
 * page colour so it stands off a pane. A phone keeps the 16px text (globals.css): ios zooms in on
 * a smaller box when it takes focus. Add width extras with cn(INPUT, 'min-w-0 flex-1').
 */
export const INPUT =
  'w-full border border-primaryStroke bg-background px-2.5 py-[3px] text-base leading-snug text-textPrimary placeholder:text-textTertiary focus:border-primaryBlue disabled:opacity-40';

/** A button in a row beside an INPUT (search, send, join): the same 30px, so the row stays flush. */
export const INPUT_BUTTON = 'px-3 py-[3px] text-base leading-snug';
