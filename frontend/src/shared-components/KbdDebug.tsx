import { useEffect, useState } from 'react';

const ON = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('kbddebug') === '1';

export function KbdDebug({ typing }: { typing: boolean }) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (!ON) return;
    let frame = 0;
    const read = () => {
      const vv = window.visualViewport;
      const video = document.querySelector('[data-kbd-video]')?.getBoundingClientRect();
      setText(
        [
          `typing ${typing} · focus #${document.activeElement?.id || document.activeElement?.tagName.toLowerCase() || '-'}`,
          `vv.height ${vv ? Math.round(vv.height) : '-'} · vv.offsetTop ${vv ? Math.round(vv.offsetTop) : '-'}`,
          `innerHeight ${window.innerHeight} · scrollY ${Math.round(window.scrollY)}`,
          `video ${video ? `${Math.round(video.width)}x${Math.round(video.height)}` : '-'}`
        ].join('\n')
      );
      frame = requestAnimationFrame(read);
    };
    read();
    return () => cancelAnimationFrame(frame);
  }, [typing]);
  if (!ON) return null;
  return (
    <pre
      id="kbd-debug"
      aria-hidden
      className="pointer-events-none fixed right-1 top-14 z-[100] m-0 whitespace-pre border border-primaryStroke bg-black/80 px-1.5 py-1 font-mono text-[10px] leading-tight text-white"
    >
      {text}
    </pre>
  );
}
