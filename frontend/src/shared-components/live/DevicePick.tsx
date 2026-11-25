import type { RemixiconComponentType } from '@remixicon/react';
import { useEffect } from 'react';

import { Select } from '@/shared-components/Select';

interface DevicePickProps {
  id: string;
  label: string;
  icon: RemixiconComponentType;
  value: string;
  devices: readonly { id: string; label: string }[];
  fallback: string;
  on: boolean;
  refresh: () => void;
  onPick: (deviceId: string) => void;
}

export function DevicePick({ id, label, icon: Icon, value, devices, fallback, on, refresh, onPick }: DevicePickProps) {
  useEffect(() => {
    if (!on) return;
    const media = navigator.mediaDevices;
    refresh();
    media?.addEventListener('devicechange', refresh);
    return () => media?.removeEventListener('devicechange', refresh);
  }, [on, refresh]);
  const options = devices.map((d) => ({ value: d.id, label: d.label }));
  if (!options.some((o) => o.value === value)) options.unshift({ value, label: fallback });
  return (
    <div id={`${id}-pick`} className="flex min-w-0 items-center gap-2 text-sm">
      <Icon aria-hidden size={16} className="shrink-0 text-textTertiary" />
      <Select id={id} label={label} value={value} options={options} onChange={onPick} className="min-w-0 flex-1" />
    </div>
  );
}
