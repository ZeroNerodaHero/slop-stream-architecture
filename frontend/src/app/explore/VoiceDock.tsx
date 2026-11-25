import { RiVolumeUpLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import type { ReactNode } from 'react';

import { ControlBar, Tile, type TileOf, useCallTiles, useVoiceView } from '@/app/explore/VoiceRoom';
import { type GroupRoom, isVoice } from '@/infra/api';
import { meAtom, openAuthDialog } from '@/infra/atoms/auth-atoms';
import { joinVoice, voiceSpeakingAtom } from '@/infra/atoms/voice-atoms';
import { voiceCallAtom } from '@/infra/atoms/voice-state';
import { Button } from '@/shared-components/Button';
import { cn } from '@/utils/cn';

const GRID = 'grid grid-cols-2 gap-1.5 p-2 max-h-[min(50vh,420px)] overflow-y-auto overscroll-contain';

function dockChannel(room: GroupRoom, call: { phase: string; server: string; channel: string }): string | null {
  const channels = (room.channels ?? []).filter(isVoice);
  if (call.phase !== 'idle' && call.server === room.name && channels.some((c) => c.name === call.channel)) return call.channel;
  let best: string | null = null;
  let most = 0;
  for (const c of channels) {
    const n = room.voice?.[c.name]?.length ?? 0;
    if (best === null || n > most) {
      best = c.name;
      most = n;
    }
  }
  return best;
}

export function VoiceDock({ room, className }: { room: GroupRoom; className?: string }) {
  const call = useAtomValue(voiceCallAtom);
  const channel = dockChannel(room, call);
  if (!channel) return null;
  const here = call.phase !== 'idle' && call.server === room.name && call.channel === channel;
  return here ? <InCall room={room} channel={channel} className={className} /> : <Outside room={room} channel={channel} className={className} />;
}

function Frame({ channel, count, className, children }: { channel: string; count: number; className?: string; children: ReactNode }) {
  return (
    <section
      id="voice-dock"
      aria-label={`voice: ${channel}`}
      className={cn('flex shrink-0 flex-col rounded-panel border border-primaryStroke bg-backgroundSecondary text-sm bubble:border-transparent', className)}
    >
      <header className="flex min-h-10 shrink-0 items-center gap-2 border-b border-primaryStroke px-3 bubble:border-transparent">
        <RiVolumeUpLine aria-hidden size={14} className="shrink-0 text-textTertiary" />
        <h3 id="voice-dock-channel" className="min-w-0 flex-1 truncate font-semibold text-textPrimary">
          {channel}
        </h3>
        <span id="voice-dock-count" className={cn('shrink-0 text-xs font-semibold tabular-nums', count > 0 ? 'text-increase' : 'text-textTertiary')}>
          {count} in
        </span>
      </header>
      {children}
    </section>
  );
}

function InCall({ room, channel, className }: { room: GroupRoom; channel: string; className?: string }) {
  const view = useVoiceView(room);
  const speaking = useAtomValue(voiceSpeakingAtom);
  const tiles = useCallTiles(room, channel);
  const avatarOf = (name: string) => room.roster?.find((m) => m.name === name)?.avatar ?? null;
  const people = tiles.filter((t) => t.kind === 'person').length;
  if (view.view === channel) {
    return (
      <Frame channel={channel} count={people} className={className}>
        <p id="voice-dock-shown" className="px-3 py-2.5 text-xs text-textTertiary">
          the call is open in the middle.
        </p>
      </Frame>
    );
  }
  return (
    <Frame channel={channel} count={people} className={className}>
      <div id="voice-dock-tiles" className={GRID}>
        {tiles.map((t) => (
          <Tile
            key={t.key}
            tile={t}
            size="grid"
            thin
            version={avatarOf(t.name)}
            talking={t.kind === 'person' && speaking.has(t.name)}
            focused={false}
            label={`open ${channel} in the middle`}
            onClick={() => view.open(channel)}
          />
        ))}
      </div>
      <ControlBar mobile={false} dock />
    </Frame>
  );
}

function Outside({ room, channel, className }: { room: GroupRoom; channel: string; className?: string }) {
  const me = useAtomValue(meAtom) ?? null;
  const view = useVoiceView(room);
  const people = room.voice?.[channel] ?? [];
  const avatarOf = (name: string) => room.roster?.find((m) => m.name === name)?.avatar ?? null;
  const join = () => {
    if (!me) return openAuthDialog('login');
    void joinVoice(room.name, channel, me);
  };
  const joinButton = (
    <Button id="voice-dock-join" size="sm" variant="outline" className="shrink-0" onClick={join}>
      {me ? 'join' : 'log in to join'}
    </Button>
  );
  if (people.length === 0) {
    return (
      <Frame channel={channel} count={0} className={className}>
        <div id="voice-dock-empty" className="flex items-center gap-2 px-3 py-2">
          <p className="min-w-0 flex-1 truncate text-textTertiary">nobody in voice</p>
          {joinButton}
        </div>
      </Frame>
    );
  }
  const tiles: TileOf[] = people.map((p) => ({
    key: p.uid,
    name: p.name,
    kind: 'person',
    stream: null,
    self: false,
    mute: !!p.muted,
    deaf: false,
    serverMuted: !!p.muted,
    uid: p.uid
  }));
  return (
    <Frame channel={channel} count={people.length} className={className}>
      <div id="voice-dock-tiles" className={GRID}>
        {tiles.map((t) => (
          <Tile
            key={t.key}
            tile={t}
            size="grid"
            thin
            version={avatarOf(t.name)}
            talking={false}
            focused={false}
            label={`open ${channel} in the middle`}
            onClick={() => view.open(channel)}
          />
        ))}
      </div>
      <div className="flex justify-end px-2 pb-2">{joinButton}</div>
    </Frame>
  );
}
