import { meAtom } from '@/infra/atoms/auth-atoms';
import { notificationsAtom } from '@/infra/atoms/notification-atoms';
import { voiceSeatsAtom } from '@/infra/atoms/voice-atoms';
import { voiceCallAtom } from '@/infra/atoms/voice-state';
import { onEvents } from '@/infra/events';
import { NO_ROSTER, NOTIFY_GAP_MS, stepOwnCall, stepRoster, throttle } from '@/infra/sound-logic';
import { installSoundUnlock, playSound } from '@/infra/sounds';
import { store } from '@/infra/store';

const SETTLE_MS = 1500;

let installed = false;

export function installSounds(): void {
  if (installed) return;
  installed = true;
  installSoundUnlock();
  watchNotifications();
  watchRoster();
}

function watchNotifications() {
  const may = throttle(NOTIFY_GAP_MS);
  let ready = false;
  let heard = 0;
  const baseline = () => {
    const list = store.get(notificationsAtom);
    ready = list !== undefined;
    heard = (list ?? []).reduce((top, n) => Math.max(top, n.id), 0);
  };
  baseline();
  store.sub(notificationsAtom, () => {
    if (!ready || store.get(notificationsAtom) === undefined) baseline();
  });
  onEvents((event) => {
    if (event.type !== 'notification' || !ready) return;
    const fresh = event.id > heard;
    heard = Math.max(heard, event.id);
    const row = store.get(notificationsAtom)?.find((n) => n.id === event.id);
    if (fresh && row && !row.read && may(performance.now())) playSound('notification');
  });
}

function watchRoster() {
  let roster = NO_ROSTER;
  let connectedAt = 0;
  let wasConnected = false;
  let inCall = false;
  const check = (seatsChanged: boolean) =>
    queueMicrotask(() => {
      const call = store.get(voiceCallAtom);
      const active = call.phase === 'joining' || call.phase === 'connected';
      const key = active ? `${call.server}/${call.channel}` : '';
      const settled = call.phase === 'connected' && performance.now() - connectedAt >= SETTLE_MS;
      const users = seatsChanged ? store.get(voiceSeatsAtom).map((s) => s.user) : null;
      const step = stepRoster(roster, key, settled, users, store.get(meAtom) ?? '');
      roster = step.state;
      if (step.joined.length > 0) playSound('voiceJoin');
      if (step.left.length > 0) playSound('voiceLeave');
    });
  store.sub(voiceSeatsAtom, () => check(true));
  store.sub(voiceCallAtom, () => {
    const connected = store.get(voiceCallAtom).phase === 'connected';
    if (connected && !wasConnected) connectedAt = performance.now();
    wasConnected = connected;
    const own = stepOwnCall(inCall, store.get(voiceCallAtom).phase);
    inCall = own.inCall;
    if (own.sound) playSound(own.sound);
    check(false);
  });
}
