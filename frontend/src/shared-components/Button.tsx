import type { ButtonHTMLAttributes } from 'react';

import { cn } from '@/utils/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'outline' | 'outline-danger';
export type ButtonSize = 'md' | 'sm';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primaryBlue border-primaryBlue text-background hover:bg-primaryBlueHover hover:border-primaryBlueHover',
  secondary: 'bg-backgroundSecondary border-primaryStroke text-textPrimary hover:border-primaryBlue',
  danger: 'bg-decrease border-decrease text-white hover:opacity-90',
  outline: 'bg-transparent border-primaryBlue text-primaryBlue hover:bg-primaryBlue/10',
  'outline-danger': 'bg-transparent border-decrease text-decrease hover:bg-decrease/10'
};

/** What a disabled button keeps on hover: its own resting colours, so hovering changes nothing. */
const DISABLED_HOVER: Record<ButtonVariant, string> = {
  primary: 'disabled:hover:border-primaryBlue disabled:hover:bg-primaryBlue',
  secondary: 'disabled:hover:border-primaryStroke disabled:hover:bg-backgroundSecondary',
  danger: '',
  outline: 'disabled:hover:border-primaryBlue disabled:hover:bg-transparent',
  'outline-danger': 'disabled:hover:border-decrease disabled:hover:bg-transparent'
};

const SIZES: Record<ButtonSize, string> = {
  md: 'px-5 py-3 disabled:cursor-default disabled:opacity-40',
  // A small action in a row (rename, add, kick, leave). Still a box, still 44px tall on a phone.
  sm: cn(
    'px-3 py-1.5 text-sm max-md:min-h-11',
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primaryBlue',
    'disabled:cursor-not-allowed disabled:opacity-50'
  )
};

/**
 * Shared classes so a router Link can look like a button: a border and a fill, and a hover that
 * changes a colour. No shadow and no press movement (no-box-shadow.mdc). Disabled: dim, and
 * hovering changes nothing.
 */
export function buttonClassName(variant: ButtonVariant = 'secondary', className?: string, size: ButtonSize = 'md'): string {
  return cn(
    'inline-flex items-center justify-center border font-semibold transition-colors duration-100',
    SIZES[size],
    VARIANTS[variant],
    // The small neutral box hovers to a lifted fill and a stronger stroke, not to blue.
    size === 'sm' && variant === 'secondary' && 'hover:border-secondaryStroke hover:bg-backgroundTertiary',
    DISABLED_HOVER[variant],
    className
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ variant = 'secondary', size = 'md', className, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={buttonClassName(variant, className, size)} {...props} />;
}
