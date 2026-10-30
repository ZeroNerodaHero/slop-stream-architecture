import type { ButtonHTMLAttributes } from 'react';

import { cn } from '@/utils/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primaryBlue border-primaryBlue text-background hover:bg-primaryBlueHover hover:border-primaryBlueHover',
  secondary: 'bg-backgroundSecondary border-primaryStroke text-textPrimary hover:border-primaryBlue',
  danger: 'bg-decrease border-decrease text-white hover:opacity-90'
};

/**
 * Shared classes so a router Link can look like a button: a border and a fill, and a hover that
 * changes a colour. No shadow and no press movement (no-box-shadow.mdc). Disabled: dim, and
 * hovering changes nothing.
 */
export function buttonClassName(variant: ButtonVariant = 'secondary', className?: string): string {
  return cn(
    'inline-flex items-center justify-center border px-5 py-3 font-semibold transition-colors duration-100',
    'disabled:cursor-default disabled:opacity-40 disabled:hover:border-primaryStroke disabled:hover:bg-backgroundSecondary',
    VARIANTS[variant],
    className
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = 'secondary', className, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={buttonClassName(variant, className)} {...props} />;
}
