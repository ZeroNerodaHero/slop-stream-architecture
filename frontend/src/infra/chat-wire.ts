import { audioOf } from './chat-audio.ts';
import { videoOf } from './chat-video.ts';
import { linkEmbedOf } from './link-embed.ts';
import { reactionsOf } from '../shared-components/reaction-list.ts';

export function picturesOf(line: { image?: string | null; images?: unknown }): string[] {
  if (Array.isArray(line.images)) {
    const ids = line.images.filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (ids.length > 0) return ids;
  }
  return typeof line.image === 'string' && line.image ? [line.image] : [];
}

export interface WireLine {
  groups?: unknown;
  avatar?: unknown;
  image?: string | null;
  images?: unknown;
  video?: unknown;
  audio?: unknown;
  reply?: unknown;
  reactions?: unknown;
  embed?: unknown;
}

export function fromWire<T extends WireLine>(line: T): T {
  const images = picturesOf(line);
  return {
    ...line,
    groups: Array.isArray(line.groups) ? line.groups : [],
    avatar: typeof line.avatar === 'number' ? line.avatar : null,
    image: images[0] ?? null,
    images,
    video: videoOf(line.video),
    audio: audioOf(line.audio),
    reply: line.reply && typeof line.reply === 'object' && typeof (line.reply as { id?: unknown }).id === 'string' ? line.reply : undefined,
    reactions: reactionsOf(line.reactions),
    embed: linkEmbedOf(line.embed)
  };
}