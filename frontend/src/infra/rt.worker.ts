/// <reference lib="webworker" />

import { openBrowserSocket, RtCore, type ToCore } from '@/infra/rt/core';
import { fetchTicket, rtSocketUrl } from '@/infra/rt/wire';

const scope = self as unknown as SharedWorkerGlobalScope;

const core = new RtCore({
  url: rtSocketUrl(self.location.href),
  build: __BUILD__,
  open: openBrowserSocket,
  ticket: () => fetchTicket(self.location.href)
});

scope.onconnect = (e: MessageEvent) => {
  const port = e.ports[0];
  if (!port) return;
  const handle = core.connect({ post: (msg) => port.postMessage(msg), close: () => port.close() });
  port.onmessage = (m: MessageEvent<ToCore>) => handle(m.data);
  port.start();
};
