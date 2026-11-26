import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

export interface MenuItem {
  key: string;
  label: string;
  onPick: () => void;
  danger?: boolean;
  divider?: boolean;
  icon?: ReactNode;
  id?: string;
}

type DataAttrs = Record<`data-${string}`, string | boolean | undefined>;

export function MenuButton({
  label,
  items,
  className,
  children,
  id,
  menuId,
  boxed = false,
  hideOnPress = false,
  buttonAttrs,
  menuAttrs
}: {
  label: string;
  items: MenuItem[];
  className: string;
  children: ReactNode;
  id?: string;
  menuId?: string;
  boxed?: boolean;
  hideOnPress?: boolean;
  buttonAttrs?: DataAttrs;
  menuAttrs?: DataAttrs;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLUListElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const el = menu.current;
    if (!open || !el) return;
    const place = () => {
      const a = button.current?.getBoundingClientRect();
      if (!a) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const right = boxed ? a.left + w : a.right;
      el.style.left = `${Math.max(4, Math.min(right - w, document.documentElement.clientWidth - w - 4))}px`;
      el.style.top = `${a.bottom + h <= document.documentElement.clientHeight - 4 ? a.bottom : Math.max(4, a.top - h)}px`;
    };
    place();
    el.querySelector<HTMLButtonElement>('button')?.focus();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    const outside = (e: PointerEvent) => {
      if (e.target instanceof Node && (menu.current?.contains(e.target) || button.current?.contains(e.target))) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [open, boxed]);

  function walk(e: KeyboardEvent<HTMLUListElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const rows = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[(i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus();
  }

  if (items.length === 0) return null;
  return (
    <>
      <Tooltip content={open ? null : label} hideOnPress={hideOnPress}>
        <button
          ref={button}
          id={id}
          type="button"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          {...buttonAttrs}
          onClick={() => {
            setHost(button.current?.closest<HTMLElement>('dialog:modal') ?? document.body);
            setOpen((was) => !was);
          }}
          className={className}
        >
          {children}
        </button>
      </Tooltip>
      {open &&
        host &&
        createPortal(
          <ul
            ref={menu}
            id={menuId}
            role="menu"
            aria-label={label}
            {...menuAttrs}
            onKeyDown={walk}
            onBlur={(e) => {
              const to = e.relatedTarget;
              if (to instanceof Node && (menu.current?.contains(to) || button.current === to)) return;
              setOpen(false);
            }}
            className={cn(
              'fixed left-0 top-0 z-[60] flex min-w-32 flex-col overflow-hidden rounded-panel border border-primaryStroke bg-backgroundSecondary text-sm',
              boxed ? 'gap-1 p-1' : 'py-1'
            )}
          >
            {items.map((item) => (
              <li key={item.key} role="none" className={item.divider ? 'mt-1 border-t border-primaryStroke pt-1' : undefined}>
                <button
                  role="menuitem"
                  type="button"
                  id={item.id}
                  data-pick={item.key}
                  className={cn(
                    'flex w-full items-center gap-2 text-left focus-visible:outline-none max-md:min-h-11',
                    boxed
                      ? 'rounded-control border border-primaryStroke bg-background px-3 py-1.5 hover:border-primaryBlue hover:bg-backgroundTertiary focus-visible:border-primaryBlue'
                      : 'px-3 py-1 hover:bg-primaryStroke/20 focus-visible:bg-primaryStroke/20',
                    item.danger ? 'text-decrease' : 'text-textPrimary'
                  )}
                  onClick={() => {
                    setOpen(false);
                    item.onPick();
                  }}
                >
                  {item.icon}
                  {item.label}
                </button>
              </li>
            ))}
          </ul>,
          host
        )}
    </>
  );
}
