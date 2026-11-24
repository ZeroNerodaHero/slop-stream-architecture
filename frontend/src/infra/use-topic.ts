import { useEffect } from 'react';

import { holdTopic } from '@/infra/events';

export function useTopic(topic: string | null): void {
  useEffect(() => (topic ? holdTopic(topic) : undefined), [topic]);
}
