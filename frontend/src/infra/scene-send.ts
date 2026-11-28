export interface SceneSendScheduler {
  schedule: () => void;
  cancel: () => void;
  pending: () => boolean;
}

export function sceneSendScheduler(ms: number, fire: () => void): SceneSendScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        fire();
      }, ms);
    },
    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    pending() {
      return timer !== null;
    }
  };
}
