import { useAtomValue } from 'jotai';
import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Outlet, createBrowserRouter, useParams } from 'react-router-dom';

import { CrashPage } from '@/app/CrashPage';
import { NotFoundPage } from '@/app/NotFoundPage';
import { authDialogAtom } from '@/infra/atoms/auth-atoms';
import { cropRequestAtom } from '@/infra/atoms/crop-atoms';
import { dmOpenAtom } from '@/infra/atoms/dm-atoms';
import { dmCallAtom, dmRingAtom } from '@/infra/atoms/dm-call-atoms';
import { inspectorOpenAtom, qualityOpenAtom, timingsOpenAtom } from '@/infra/atoms/inspector-atoms';
import { notificationsOpenAtom } from '@/infra/atoms/notification-atoms';
import { profilePopupAtom } from '@/infra/atoms/profile-popup-atoms';
import { panelSideAtom, perfModeAtom } from '@/infra/atoms/settings-atoms';
import { userModalOpenAtom } from '@/infra/atoms/user-modal-atoms';
import { voiceCallAtom } from '@/infra/atoms/voice-state';
import { loadHomePage, loadServerPage, loadWatchPage } from '@/infra/prefetch';
import { MiniPlayer } from '@/shared-components/MiniPlayer';
import { UpdateBanner } from '@/shared-components/UpdateBanner';
import { UserPanel } from '@/shared-components/UserPanel';
import { WhenUsed } from '@/shared-components/WhenUsed';
import { cn } from '@/utils/cn';

const FriendChat = lazy(() => import('@/shared-components/FriendChat').then((m) => ({ default: m.FriendChat })));
const Notifications = lazy(() => import('@/shared-components/Notifications').then((m) => ({ default: m.Notifications })));
const Inspector = lazy(() => import('@/shared-components/Inspector').then((m) => ({ default: m.Inspector })));
const TimingsWindow = lazy(() => import('@/shared-components/debug/TimingsWindow').then((m) => ({ default: m.TimingsWindow })));
const QualityWindow = lazy(() => import('@/shared-components/debug/QualityWindow').then((m) => ({ default: m.QualityWindow })));
const PerfHud = lazy(() => import('@/shared-components/debug/PerfHud').then((m) => ({ default: m.PerfHud })));
const UserModal = lazy(() => import('@/shared-components/UserModal').then((m) => ({ default: m.UserModal })));
const AuthDialog = lazy(() => import('@/shared-components/AuthDialog').then((m) => ({ default: m.AuthDialog })));
const ProfilePopup = lazy(() => import('@/shared-components/ProfilePopup').then((m) => ({ default: m.ProfilePopup })));
const VoicePip = lazy(() => import('@/app/explore/VoicePip').then((m) => ({ default: m.VoicePip })));
const CallRing = lazy(() => import('@/shared-components/CallRing').then((m) => ({ default: m.CallRing })));
const CropDialog = lazy(() => import('@/shared-components/CropDialog').then((m) => ({ default: m.CropDialog })));

function FriendChatWhenUsed() {
  const open = useAtomValue(dmOpenAtom);
  return (
    <WhenUsed on={open}>
      <FriendChat />
    </WhenUsed>
  );
}

function NotificationsWhenUsed() {
  const open = useAtomValue(notificationsOpenAtom);
  return (
    <WhenUsed on={open}>
      <Notifications />
    </WhenUsed>
  );
}

function InspectorWhenUsed() {
  const open = useAtomValue(inspectorOpenAtom);
  return (
    <WhenUsed on={open}>
      <Inspector />
    </WhenUsed>
  );
}

function TimingsWhenUsed() {
  const open = useAtomValue(timingsOpenAtom);
  return (
    <WhenUsed on={open}>
      <TimingsWindow />
    </WhenUsed>
  );
}

function QualityWhenUsed() {
  const open = useAtomValue(qualityOpenAtom);
  return (
    <WhenUsed on={open}>
      <QualityWindow />
    </WhenUsed>
  );
}

function UserModalWhenUsed() {
  const open = useAtomValue(userModalOpenAtom);
  return (
    <WhenUsed on={open}>
      <UserModal />
    </WhenUsed>
  );
}

function AuthDialogWhenUsed() {
  const mode = useAtomValue(authDialogAtom);
  return (
    <WhenUsed on={mode !== null}>
      <AuthDialog />
    </WhenUsed>
  );
}

function ProfilePopupWhenUsed() {
  const target = useAtomValue(profilePopupAtom);
  return (
    <WhenUsed on={target !== null}>
      <ProfilePopup />
    </WhenUsed>
  );
}

function CropDialogWhenUsed() {
  const request = useAtomValue(cropRequestAtom);
  return (
    <WhenUsed on={request !== null}>
      <CropDialog />
    </WhenUsed>
  );
}

function VoicePipWhenUsed() {
  const call = useAtomValue(voiceCallAtom);
  const dm = useAtomValue(dmCallAtom);
  return (
    <WhenUsed on={call.phase !== 'idle' || dm !== null}>
      <VoicePip />
    </WhenUsed>
  );
}

function CallRingWhenUsed() {
  const ring = useAtomValue(dmRingAtom);
  return (
    <WhenUsed on={ring !== null}>
      <CallRing />
    </WhenUsed>
  );
}

function Shell() {
  const side = useAtomValue(panelSideAtom);
  const perf = useAtomValue(perfModeAtom);
  return (
    <>
      <UpdateBanner />
      <div
        className={cn(
          'flex min-h-[calc(100vh-var(--banner-h,0px))] items-start pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]',
          side === 'right' && 'flex-row-reverse'
        )}
      >
        <UserPanel />
        <div className="relative min-w-0 flex-1">
          <Suspense fallback={null}>
            <Outlet />
          </Suspense>
        </div>
        <MiniPlayer />
        <FriendChatWhenUsed />
        <NotificationsWhenUsed />
        <UserModalWhenUsed />
        <AuthDialogWhenUsed />
        <ProfilePopupWhenUsed />
        <CropDialogWhenUsed />
        <VoicePipWhenUsed />
        <CallRingWhenUsed />
        <InspectorWhenUsed />
        <TimingsWhenUsed />
        <QualityWhenUsed />
        {perf !== 'off' && (
          <Suspense fallback={null}>
            <PerfHud mode={perf} />
          </Suspense>
        )}
      </div>
    </>
  );
}

function WatchRoute() {
  const { name } = useParams<{ name: string }>();
  return <WatchPage key={name} />;
}

function ExploreRedirect() {
  const { server, channel } = useParams<{ server?: string; channel?: string }>();
  const to = channel ? `/groups/${server}/${channel}` : server ? `/groups/${server}` : '/groups';
  return <Navigate to={to} replace />;
}

const HomePage = lazy(() => loadHomePage().then((m) => ({ default: m.HomePage })));
const ActivePage = lazy(() => loadHomePage().then((m) => ({ default: m.ActivePage })));
const WatchPage = lazy(() => loadWatchPage().then((m) => ({ default: m.WatchPage })));
const ExplorePage = lazy(() => import('@/app/explore/ExplorePage').then((m) => ({ default: m.ExplorePage })));
const ServerPage = lazy(() => loadServerPage().then((m) => ({ default: m.ServerPage })));
const LivePage = lazy(() => import('@/app/live/LivePage').then((m) => ({ default: m.LivePage })));
const AuthPage = lazy(() => import('@/app/auth/AuthPage').then((m) => ({ default: m.AuthPage })));
const OAuthPage = lazy(() => import('@/app/auth/OAuthPage').then((m) => ({ default: m.OAuthPage })));
const PeoplePage = lazy(() => import('@/app/people/PeoplePage').then((m) => ({ default: m.PeoplePage })));
const AdminPage = lazy(() => import('@/app/admin/AdminPage').then((m) => ({ default: m.AdminPage })));

function ServerRoute() {
  const { server } = useParams<{ server: string }>();
  useEffect(() => {
    const root = document.documentElement;
    root.style.scrollSnapType = 'y mandatory';
    return () => {
      root.style.scrollSnapType = '';
    };
  }, []);
  return <ServerPage key={server} />;
}

export const router = createBrowserRouter([
  {
    element: <Shell />,
    errorElement: <CrashPage />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/active', element: <ActivePage /> },
      { path: '/groups', element: <ExplorePage /> },
      { path: '/groups/:server/:channel?', element: <ServerRoute /> },
      { path: '/explore', element: <Navigate to="/groups" replace /> },
      { path: '/explore/:server', element: <ExploreRedirect /> },
      { path: '/explore/:server/:channel', element: <ExploreRedirect /> },
      { path: '/live', element: <LivePage /> },
      { path: '/watch/:name', element: <WatchRoute /> },
      { path: '/login', element: <AuthPage mode="login" /> },
      { path: '/signup', element: <AuthPage mode="signup" /> },
      { path: '/oauth', element: <OAuthPage /> },
      { path: '/people', element: <PeoplePage /> },
      { path: '/admin', element: <AdminPage /> },
      { path: '*', element: <NotFoundPage /> }
    ]
  }
]);
