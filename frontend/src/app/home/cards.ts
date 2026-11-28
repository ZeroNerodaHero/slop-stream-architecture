import { cn } from '@/utils/cn';

export const CARD = 'overflow-hidden rounded-card border border-primaryStroke bg-backgroundSecondary bubble:border-transparent';
export const CARD_LINK = cn(
  CARD,
  'group transition-[border-color] duration-150 hover:border-primaryBlue focus-within:border-primaryBlue bubble:hover:bg-backgroundTertiary bubble:focus-within:border-primaryBlue'
);
