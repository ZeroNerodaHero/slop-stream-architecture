let timer: ReturnType<typeof setInterval> | null = null;

self.onmessage = (e: MessageEvent<number>) => {
  if (timer) clearInterval(timer);
  timer = e.data > 0 ? setInterval(() => self.postMessage(0), 1000 / e.data) : null;
};
