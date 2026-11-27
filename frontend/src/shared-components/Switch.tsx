import { cn } from '@/utils/cn';

interface SwitchProps {
  id?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}

export function Switch({ id, checked, onChange, label, disabled, className }: SwitchProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-5 w-9 shrink-0 rounded-control border border-primaryStroke transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primaryBlue disabled:opacity-40',
        checked ? 'bg-primaryBlue' : 'bg-background',
        className
      )}
    >
      <span
        aria-hidden
        className={cn('absolute left-px top-px h-4 w-4 rounded-control transition-transform duration-150', checked ? 'translate-x-4 bg-background' : 'bg-textTertiary')}
      />
    </button>
  );
}
