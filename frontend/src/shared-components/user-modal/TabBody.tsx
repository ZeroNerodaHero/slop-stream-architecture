import { lazy, Suspense } from 'react';

import type { UserTab } from '@/infra/atoms/user-modal-atoms';
import { AdvancedTab } from '@/shared-components/user-modal/AdvancedTab';
import { AppearanceTab } from '@/shared-components/user-modal/AppearanceTab';
import { ChatTab } from '@/shared-components/user-modal/ChatTab';
import { GroupsTab } from '@/shared-components/user-modal/GroupsTab';
import { NotificationsTab } from '@/shared-components/user-modal/NotificationsTab';
import { ProfileTab } from '@/shared-components/user-modal/ProfileTab';
import { SecurityTab } from '@/shared-components/user-modal/SecurityTab';
import { SidebarTab } from '@/shared-components/user-modal/SidebarTab';
import { StatsTab } from '@/shared-components/user-modal/StatsTab';

const VoiceTab = lazy(() => import('@/shared-components/user-modal/VoiceTab').then((m) => ({ default: m.VoiceTab })));

export function TabBody({ tab }: { tab: UserTab }) {
  return (
    <>
      {tab === 'profile' && <ProfileTab />}
      {tab === 'stats' && <StatsTab />}
      {tab === 'groups' && <GroupsTab />}
      {tab === 'security' && <SecurityTab />}
      {tab === 'notifications' && <NotificationsTab />}
      {tab === 'appearance' && <AppearanceTab />}
      {tab === 'chat' && <ChatTab />}
      {tab === 'voice' && (
        <Suspense fallback={null}>
          <VoiceTab />
        </Suspense>
      )}
      {tab === 'sidebar' && <SidebarTab />}
      {tab === 'advanced' && <AdvancedTab />}
    </>
  );
}
