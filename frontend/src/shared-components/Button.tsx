import type { ButtonHTMLAttributes } from 'react';

import { cn } from '@/utils/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primaryBlue border-primaryBlue text-background hover:bg-primaryBlueHover hover:border-primaryBlueHover',
  secondary: 'bg-backgroundSecondary border-primaryStroke text-textPrimary hover:border-primaryBlue',
  danger: 'bg-decrease border-decrease text-white hover:opacity-90'
};

/**
 * Shared classes so a router Link can look like a button. A square with a hard shadow; pressing
 * it moves it onto the shadow. Disabled: flat and dim.
 */
export function buttonClassName(variant: ButtonVariant = 'secondary', className?: string): string {
  return cn(
    'inline-flex items-center justify-center border px-5 py-3 font-semibold shadow-hard transition-[color,background-color,border-color,box-shadow,transform] duration-100',
    'active:translate-x-1 active:translate-y-1 active:shadow-none',
    'disabled:cursor-default disabled:opacity-40 disabled:shadow-none disabled:hover:border-primaryStroke disabled:hover:bg-backgroundSecondary disabled:active:translate-x-0 disabled:active:translate-y-0',
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
