import type { ButtonHTMLAttributes } from 'react';

import { cn } from '@/utils/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'success' | 'danger' | 'outline' | 'outline-danger';
export type ButtonSize = 'md' | 'sm';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primaryBlue border-primaryBlue text-background hover:bg-primaryBlueHover hover:border-primaryBlueHover',
  secondary: 'bg-backgroundSecondary border-primaryStroke text-textPrimary hover:border-primaryBlue',
  success: 'bg-increase border-increase text-background hover:bg-increaseHover hover:border-increaseHover',
  danger: 'bg-decrease border-decrease text-white hover:opacity-90',
  outline: 'bg-transparent border-primaryBlue text-primaryBlue hover:bg-primaryBlue/10',
  'outline-danger': 'bg-transparent border-decrease text-decrease hover:bg-decrease/10'
};

const DISABLED_HOVER: Record<ButtonVariant, string> = {
  primary: 'disabled:hover:border-primaryBlue disabled:hover:bg-primaryBlue',
  secondary: 'disabled:hover:border-primaryStroke disabled:hover:bg-backgroundSecondary',
  success: 'disabled:hover:border-increase disabled:hover:bg-increase',
  danger: '',
  outline: 'disabled:hover:border-primaryBlue disabled:hover:bg-transparent',
  'outline-danger': 'disabled:hover:border-decrease disabled:hover:bg-transparent'
};

const SIZES: Record<ButtonSize, string> = {
  md: 'px-5 py-3 disabled:cursor-default disabled:opacity-40',
  sm: cn(
    'px-3 py-1.5 text-sm max-md:min-h-11',
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primaryBlue',
    'disabled:cursor-not-allowed disabled:opacity-50'
  )
};

export function buttonClassName(variant: ButtonVariant = 'secondary', className?: string, size: ButtonSize = 'md'): string {
  return cn(
    'inline-flex items-center justify-center border font-semibold transition-colors duration-100',
    SIZES[size],
    VARIANTS[variant],
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
