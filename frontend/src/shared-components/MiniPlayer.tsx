import { useAtomValue } from 'jotai';
import { Component, type ErrorInfo, lazy, type ReactNode, useRef } from 'react';
import { useLocation } from 'react-router-dom';

import { friendsOpenAtom } from '@/infra/atoms/follow-atoms';
import { publishPipAtom } from '@/infra/atoms/publish-state';
import { panelSideAtom } from '@/infra/atoms/settings-atoms';
import { pipAtom, watchNameAtom } from '@/infra/atoms/watch-state';
import { useIsMobile } from '@/infra/mobile';
import { report } from '@/infra/report';
import { cn } from '@/utils/cn';
import { isLivePage } from '@/shared-components/corner-chat';
import { useStackedWindow } from '@/shared-components/useStackedWindow';
import { WhenUsed } from '@/shared-components/WhenUsed';

class CornerCatch extends Component<{ at: string; children: ReactNode }, { failed: boolean; at: string }> {
  state = { failed: false, at: this.props.at };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: { at: string }, state: { failed: boolean; at: string }) {
    return props.at === state.at ? null : { failed: false, at: props.at };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    report('crash', error, { componentStack: info.componentStack ?? undefined });
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const LiveCorner = lazy(() => import('@/shared-components/LiveCorner').then((m) => ({ default: m.LiveCorner })));
const WatchCorner = lazy(() => import('@/shared-components/WatchCorner').then((m) => ({ default: m.WatchCorner })));

function LiveCornerWhenUsed({ pathname }: { pathname: string }) {
  const pip = useAtomValue(publishPipAtom);
  return (
    <WhenUsed on={pip || isLivePage(pathname)}>
      <LiveCorner />
    </WhenUsed>
  );
}

function WatchCornerWhenUsed() {
  const pip = useAtomValue(pipAtom);
  const name = useAtomValue(watchNameAtom);
  return (
    <WhenUsed on={pip && name !== ''}>
      <WatchCorner />
    </WhenUsed>
  );
}

export function MiniPlayer() {
  const side = useAtomValue(panelSideAtom);
  const sidebarOpen = useAtomValue(friendsOpenAtom);
  const mobile = useIsMobile();
  const { pathname } = useLocation();
  const ref = useRef<HTMLDivElement | null>(null);
  useStackedWindow(ref, 'corner');
  return (
    <div
      ref={ref}
      id="corner-players"
      className={cn(
        'pointer-events-none fixed bottom-6 flex flex-col items-end gap-3',
        side === 'right' && !mobile ? (sidebarOpen ? 'right-[324px]' : 'right-20') : 'right-6'
      )}
    >
      <CornerCatch at={pathname}>
        <WatchCornerWhenUsed />
      </CornerCatch>
      <CornerCatch at={pathname}>
        <LiveCornerWhenUsed pathname={pathname} />
      </CornerCatch>
    </div>
  );
}
