import { atom, useAtomValue } from 'jotai';
import { useEffect, useRef, useState } from 'react';

import { api } from '@/infra/api';
import { paletteAtom } from '@/infra/atoms/settings-atoms';
import { store } from '@/infra/store';
import { schemeOf } from '@/infra/theme';

interface TurnstileConfig {
  enabled: boolean;
  siteKey: string | null;
}

interface TurnstileApi {
  render: (el: HTMLElement, options: Record<string, unknown>) => string | undefined;
  reset: (id: string) => void;
  remove: (id: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

export const turnstileConfigAtom = atom<TurnstileConfig | undefined>(undefined);

let configAsked: Promise<void> | null = null;

function loadTurnstileConfig(): Promise<void> {
  if (!configAsked) {
    configAsked = api
      .turnstileConfig()
      .then((r) => store.set(turnstileConfigAtom, { enabled: r.enabled === true && !!r.siteKey, siteKey: r.siteKey }))
      .catch(() => {
        store.set(turnstileConfigAtom, { enabled: false, siteKey: null });
        configAsked = null;
      });
  }
  return configAsked;
}

let scriptLoaded: Promise<TurnstileApi> | null = null;

function loadScript(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!scriptLoaded) {
    scriptLoaded = new Promise<TurnstileApi>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SCRIPT_URL;
      script.async = true;
      script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('no turnstile')));
      script.onerror = () => {
        script.remove();
        reject(new Error('turnstile did not load'));
      };
      document.head.appendChild(script);
    }).catch((err: unknown) => {
      scriptLoaded = null;
      throw err;
    });
  }
  return scriptLoaded;
}

export function useTurnstileOn(): boolean {
  return useAtomValue(turnstileConfigAtom)?.enabled === true;
}

interface TurnstileProps {
  id: string;
  onToken: (token: string | null) => void;
  resetKey: number;
}

export function Turnstile({ id, onToken, resetKey }: TurnstileProps) {
  const config = useAtomValue(turnstileConfigAtom);
  const palette = useAtomValue(paletteAtom);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  const [failed, setFailed] = useState(false);
  const siteKey = config?.enabled ? config.siteKey : null;
  const theme = useRef(schemeOf(palette));

  useEffect(() => {
    onTokenRef.current = onToken;
  });

  useEffect(() => {
    void loadTurnstileConfig();
  }, []);

  useEffect(() => {
    const box = boxRef.current;
    if (!siteKey || !box) return;
    let gone = false;
    loadScript()
      .then((turnstile) => {
        if (gone) return;
        const say = (token: string | null) => onTokenRef.current(token);
        widgetRef.current =
          turnstile.render(box, {
            sitekey: siteKey,
            theme: theme.current,
            size: 'flexible',
            callback: (token: string) => say(token),
            'expired-callback': () => say(null),
            'timeout-callback': () => say(null),
            'error-callback': () => say(null)
          }) ?? null;
      })
      .catch(() => {
        if (!gone) setFailed(true);
      });
    return () => {
      gone = true;
      if (widgetRef.current) window.turnstile?.remove(widgetRef.current);
      widgetRef.current = null;
    };
  }, [siteKey]);

  useEffect(() => {
    if (resetKey === 0 || !widgetRef.current) return;
    onTokenRef.current(null);
    window.turnstile?.reset(widgetRef.current);
  }, [resetKey]);

  if (!siteKey) return null;
  return (
    <div className="flex flex-col gap-1">
      <div id={id} ref={boxRef} className="min-h-[65px]" />
      {failed && (
        <p role="alert" className="text-sm text-decrease">
          the human check did not load. reload the page, or let challenges.cloudflare.com through.
        </p>
      )}
    </div>
  );
}

export function useTurnstile(id: string) {
  const on = useTurnstileOn();
  const [token, setToken] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  return {
    token: token ?? undefined,
    ready: !on || token !== null,
    spent: () => {
      setToken(null);
      setRound((r) => r + 1);
    },
    widget: <Turnstile id={id} onToken={setToken} resetKey={round} />
  };
}
