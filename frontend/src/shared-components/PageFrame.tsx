import { RiArrowLeftSLine, RiHome5Line } from '@remixicon/react';
import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { useIsMobile } from '@/infra/mobile';
import { buttonClassName } from '@/shared-components/Button';
import { NotificationsBell } from '@/shared-components/NotificationsBell';
import { DrawerOpener } from '@/shared-components/UserPanel';
import { cn } from '@/utils/cn';

interface PageFrameProps {
  title?: ReactNode;
  titleId?: string;
  aside?: ReactNode;
  wide?: boolean;
  fluid?: boolean;
  mobileTitle?: ReactNode;
  mobileSub?: ReactNode;
  mobileEnd?: ReactNode;
  mobileStart?: ReactNode;
  bleed?: boolean;
  fill?: boolean;
  person?: boolean;
  children: ReactNode;
}

export function HomeLink({ reload = false, square = false, className }: { reload?: boolean; square?: boolean; className?: string }) {
  return (
    <Link
      id="home"
      to="/"
      aria-label="home"
      reloadDocument={reload || undefined}
      data-prefetch={reload ? 'off' : undefined}
      className={buttonClassName('secondary', cn('shrink-0 gap-1 text-sm', square ? 'h-10 w-10 p-0' : 'px-3 py-1.5', className))}
    >
      <RiArrowLeftSLine aria-hidden size={square ? 20 : 18} />
    </Link>
  );
}

function MobileHomeLink({ caret = false }: { caret?: boolean }) {
  return (
    <Link
      id="home"
      to="/"
      aria-label="home"
      className="flex h-11 w-11 shrink-0 items-center justify-center border border-transparent text-textSecondary focus-visible:border-primaryBlue focus-visible:outline-none"
    >
      {caret ? <RiArrowLeftSLine aria-hidden size={24} /> : <RiHome5Line aria-hidden size={22} />}
    </Link>
  );
}

const BUBBLE_HEADER =
  'bubble:border-transparent bubble:px-3 bubble:pt-4 bubble:before:absolute bubble:before:inset-x-0 bubble:before:bottom-0 bubble:before:top-2 bubble:before:-z-10 bubble:before:rounded-panel bubble:before:bg-backgroundSecondary';

function useOnLivePage(): boolean {
  const { pathname } = useLocation();
  return pathname.replace(/\/$/, '') === '/live';
}

function TopActions({ bell = true, home = false }: { bell?: boolean; home?: boolean }) {
  const onLivePage = useOnLivePage();
  return (
    <div className={cn('ml-auto flex shrink-0 items-center', home ? 'gap-1' : 'gap-2')}>
      {bell && <NotificationsBell />}
      {home && <MobileHomeLink />}
      {!onLivePage && (
        <Link id="go-live" to="/live" className={buttonClassName('primary', 'px-3 py-1.5 text-sm max-md:h-11')}>
          go live
        </Link>
      )}
    </div>
  );
}

function useCurrentPart(on: boolean, main: RefObject<HTMLElement | null>, row: RefObject<HTMLElement | null>): string | null {
  const [part, setPart] = useState<string | null>(null);
  useEffect(() => {
    const page = main.current;
    if (!on || !page) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const foot = row.current?.getBoundingClientRect().bottom ?? 0;
      let at: string | null = null;
      for (const section of page.querySelectorAll<HTMLElement>(':scope > section[data-title]')) {
        if (at !== null && section.getBoundingClientRect().top > foot + 1) break;
        at = section.dataset.title ?? null;
      }
      setPart(at);
    };
    const soon = () => {
      if (!frame) frame = window.requestAnimationFrame(read);
    };
    read();
    window.addEventListener('scroll', soon, { passive: true });
    window.addEventListener('resize', soon);
    const parts = new MutationObserver(soon);
    parts.observe(page, { childList: true });
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', soon);
      window.removeEventListener('resize', soon);
      parts.disconnect();
    };
  }, [on, main, row]);
  return on ? part : null;
}

export function PageFrame({
  title,
  titleId,
  aside,
  wide = false,
  fluid = false,
  mobileTitle,
  mobileSub,
  mobileEnd,
  mobileStart,
  bleed = false,
  fill = false,
  person = false,
  children
}: PageFrameProps) {
  const titled = Boolean(title || aside);
  const mobile = useIsMobile();
  const onLivePage = useOnLivePage();
  const mainRef = useRef<HTMLElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const part = useCurrentPart(mobile && !titled, mainRef, headerRef);

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!(titled || mobile) || !header) return;
    const root = document.documentElement;
    const measure = () => root.style.setProperty('--title-row', `${header.getBoundingClientRect().height}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--title-row');
    };
  }, [titled, mobile]);

  const width = fluid ? undefined : wide ? 'max-w-[1360px]' : 'max-w-[960px]';

  if (mobile) {
    const named = mobileTitle ?? title;
    const headed = mobileTitle !== undefined || title !== undefined;
    const homeByGoLive = Boolean(title) && mobileEnd === undefined && !onLivePage;
    const homeByEnd = Boolean(title) && mobileEnd !== undefined;
    return (
      <main ref={mainRef} className={cn('mx-auto', bleed ? 'px-0' : 'px-4 pb-8', width, fill && 'flex h-full min-h-0 w-full flex-col')}>
        <header
          ref={headerRef}
          className={cn(
            'sticky top-0 z-30 flex min-h-[calc(4rem+env(safe-area-inset-top))] items-center gap-1 border-b border-primaryStroke bg-background pb-2.5 pt-[calc(0.625rem+env(safe-area-inset-top))]',
            bleed ? 'px-4' : titled && 'mb-4'
          )}
        >
          <DrawerOpener />
          {mobileStart}
          {title && !homeByGoLive && !homeByEnd && <MobileHomeLink />}
          {mobileSub !== undefined ? (
            <div className="ml-1 min-w-0 flex-1">
              <h1 id={titleId} className="truncate text-base font-medium leading-tight">
                {named}
              </h1>
              <p className="truncate text-xs leading-4 text-textSecondary">{mobileSub}</p>
            </div>
          ) : headed ? (
            <h1 id={titleId} className="min-w-0 flex-1 truncate text-xl font-semibold leading-tight">
              {named}
            </h1>
          ) : (
            <p aria-hidden className="min-w-0 flex-1 truncate text-xl font-semibold leading-tight">
              {part}
            </p>
          )}
          {aside && <div className="shrink-0">{aside}</div>}
          {mobileEnd !== undefined ? (
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {homeByEnd && <MobileHomeLink caret />}
              {mobileEnd}
            </div>
          ) : (
            <TopActions bell={false} home={homeByGoLive} />
          )}
        </header>
        {children}
      </main>
    );
  }

  if (person) {
    return (
      <main ref={mainRef} className={cn('mx-auto px-5 pb-10 bubble:px-2 [--page-top:calc(var(--title-row,3.5rem)+0.5rem)]', width)}>
        <header ref={headerRef} className={cn('sticky top-0 z-30 mb-2 flex min-h-14 items-center gap-3 border-b border-primaryStroke bg-background py-2', BUBBLE_HEADER)}>
          <HomeLink square />
          {mobileStart}
          <div className="min-w-0 flex-1">
            <h1 id={titleId} className="truncate text-base font-medium leading-tight">
              {mobileTitle ?? title}
            </h1>
            {mobileSub && <p className="truncate text-xs leading-4 text-textSecondary">{mobileSub}</p>}
          </div>
          {aside && <div className="shrink-0">{aside}</div>}
          {mobileEnd !== undefined && <div className="flex shrink-0 items-center gap-2">{mobileEnd}</div>}
          <TopActions />
        </header>
        {children}
      </main>
    );
  }

  return (
    <main ref={mainRef} className={cn('mx-auto px-5 pb-10 bubble:px-2', titled && '[--page-top:calc(var(--title-row,4rem)+1.5rem)]', width)}>
      <header
        ref={headerRef}
        className={cn(
          'sticky top-0 z-30 flex items-center gap-4 bg-background py-3',
          titled ? cn('mb-6 min-h-16 flex-wrap border-b border-primaryStroke', BUBBLE_HEADER) : 'h-16 -mb-16'
        )}
      >
        {title && (
          <div className="flex min-w-0 items-center gap-4">
            <HomeLink />
            <h1 id={titleId} className="min-w-0 border-l-4 border-primaryBlue pl-3 text-[1.75rem] font-semibold leading-tight [overflow-wrap:anywhere]">
              {title}
            </h1>
          </div>
        )}
        {aside && <div className="max-w-full shrink-0">{aside}</div>}
        <TopActions />
      </header>
      {children}
    </main>
  );
}
