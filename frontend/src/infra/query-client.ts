import { QueryClient } from '@tanstack/react-query';

// one retry, not the default three with backoff (~7s of a dead api reading as "loading"). the
// pages that poll ask again on their own anyway, and admin turns retries off for itself. its own
// module so a fact can patch an answer the pages hold (groups-atoms.ts, a group's new colour).
export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
