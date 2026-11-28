import { RiKickFill, RiTwitchFill } from '@remixicon/react';
import { useQuery } from '@tanstack/react-query';
import { useAtom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import { useCallback, useMemo } from 'react';

import { api } from '@/infra/api';
import { BADGE_WORDS, type ChatPick, type ChatPlatform, type ChatSourceLine, emoteUrlOk, picksOf, platformsOf, togglePick } from '@/infra/chat-source';
import { Button } from '@/shared-components/Button';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

const ICONS = { twitch: RiTwitchFill, kick: RiKickFill } as const;
const TINTS: Record<ChatPlatform, string> = { twitch: 'text-[#9146ff]', kick: 'text-[#53fc18]' };
const SLOP_LOGO = '/icon-192.png?v=3';
const SOURCES_POLL_MS = 60_000;

const storedPickAtom = atomWithStorage<unknown>('settings.chatSource', null, undefined, { getOnInit: true });
const PICK_WORDS: Record<ChatPick, string> = { slop: 'site chat', twitch: 'twitch chat', kick: 'kick chat' };

export function useChatSources(name: string, off = false): ChatPlatform[] {
  const answer = useQuery({
    queryKey: ['chat-sources', name],
    queryFn: () => api.chatSources(name),
    enabled: !off && !!name,
    refetchInterval: SOURCES_POLL_MS,
    staleTime: SOURCES_POLL_MS / 2
  });
  const raw = off ? undefined : answer.data?.sources;
  return useMemo(() => platformsOf(raw), [raw]);
}

export function useChatPicks(sources: readonly ChatPlatform[]): [ChatPick[], (pick: ChatPick) => void] {
  const [stored, setStored] = useAtom(storedPickAtom);
  const picks = useMemo(() => picksOf(stored, sources), [stored, sources]);
  const toggle = useCallback((pick: ChatPick) => setStored(togglePick(picks, pick, sources)), [picks, sources, setStored]);
  return [picks, toggle];
}

export function ChatSourcePicker({ name, className }: { name: string; className?: string }) {
  const sources = useChatSources(name);
  const [picks, toggle] = useChatPicks(sources);
  return <SourcePicker sources={sources} picks={picks} onToggle={toggle} className={className} />;
}

export function PlatformLogo({ platform, size = 16, className }: { platform: ChatPlatform; size?: number; className?: string }) {
  const Icon = ICONS[platform];
  return <Icon aria-hidden size={size} className={cn('shrink-0', TINTS[platform], className)} />;
}

export function PlatformFace({ platform, className }: { platform: ChatPlatform; className?: string }) {
  return (
    <span
      role="img"
      aria-label={`${platform} user`}
      data-platform-face={platform}
      className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-avatar border border-primaryStroke bg-backgroundTertiary', className)}
    >
      <PlatformLogo platform={platform} size={18} />
    </span>
  );
}

export function PlatformMark({ platform }: { platform: ChatPlatform }) {
  return (
    <Tooltip content={`from ${platform} chat`}>
      <span role="img" aria-label={`from ${platform}`} data-platform-mark={platform} className="flex">
        <PlatformLogo platform={platform} size={14} />
      </span>
    </Tooltip>
  );
}

export function PlatformBadges({ badges }: { badges: string[] }) {
  if (badges.length === 0) return null;
  return (
    <>
      {badges.map((badge) => (
        <span key={badge} data-platform-badge={badge} className="rounded-control border border-primaryStroke px-1 text-[10px] leading-4 text-textSecondary">
          {BADGE_WORDS[badge] ?? badge}
        </span>
      ))}
    </>
  );
}

export function PlatformWords({ source, text }: { source: ChatSourceLine; text: string }) {
  if (source.parts.length === 0) return <span className="whitespace-pre-wrap">{text}</span>;
  return (
    <span className="whitespace-pre-wrap">
      {source.parts.map((part, i) =>
        part.emote && emoteUrlOk(part.url) ? (
          <Tooltip key={i} content={part.emote}>
            <img src={part.url} alt={part.emote} draggable={false} loading="lazy" referrerPolicy="no-referrer" className="inline-block h-6 w-auto align-middle" />
          </Tooltip>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </span>
  );
}

function PickIcon({ pick, on }: { pick: ChatPick; on: boolean }) {
  if (pick === 'slop') return <img src={SLOP_LOGO} alt="" draggable={false} className={cn('h-4 w-4 rounded-avatar object-cover', !on && 'opacity-50 grayscale')} />;
  return <PlatformLogo platform={pick} className={cn(!on && 'opacity-50 grayscale')} />;
}

export function SourcePicker({
  sources,
  picks,
  onToggle,
  className
}: {
  sources: readonly ChatPlatform[];
  picks: readonly ChatPick[];
  onToggle: (pick: ChatPick) => void;
  className?: string;
}) {
  if (sources.length === 0) return null;
  const options: ChatPick[] = ['slop', ...sources];
  return (
    <span role="group" aria-label="chat source" data-chat-sources className={cn('flex shrink-0 items-center gap-1', className)}>
      {options.map((option) => {
        const on = picks.includes(option);
        const locked = on && picks.length <= 1;
        const words = PICK_WORDS[option];
        const tip = locked ? `${words} · one has to stay on` : `${on ? 'hide' : 'show'} ${words}`;
        return (
          <Tooltip key={option} content={tip}>
            <Button
              size="sm"
              variant="secondary"
              aria-label={words}
              aria-pressed={on}
              aria-disabled={locked || undefined}
              data-chat-source={option}
              data-on={on || undefined}
              data-locked={locked || undefined}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onToggle(option)}
              className={cn('h-7 w-7 p-0 max-md:min-h-0', on && 'border-primaryBlue bg-primaryBlue/10 text-primaryBlue hover:border-primaryBlue')}
            >
              <PickIcon pick={option} on={on} />
            </Button>
          </Tooltip>
        );
      })}
    </span>
  );
}
