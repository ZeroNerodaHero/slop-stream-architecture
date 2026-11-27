import { type ReactNode, useMemo } from 'react';

import { httpUrl } from '@/infra/about-blocks';
import { ExternalLink } from '@/shared-components/ExternalLink';
import { cn } from '@/utils/cn';

export const FROM = 'the streamer put this link on their page, not this site.';

const TAGS: Record<string, string> = {
  p: '',
  h2: 'text-base font-bold text-textPrimary',
  h3: 'text-sm font-bold text-textPrimary',
  ul: 'list-disc pl-5',
  ol: 'list-decimal pl-5',
  li: '',
  blockquote: 'border-l-2 border-primaryStroke pl-3 text-textSecondary',
  strong: 'font-bold text-textPrimary',
  b: 'font-bold text-textPrimary',
  em: 'italic',
  i: 'italic',
  u: 'underline underline-offset-2',
  s: 'line-through'
};

function render(node: Node, key: string): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (!(node instanceof Element)) return null;
  const tag = node.tagName.toLowerCase();
  const kids = Array.from(node.childNodes, (child, i) => render(child, `${key}.${i}`));
  if (tag === 'br') return <br key={key} />;
  if (tag === 'a') {
    const href = httpUrl(node.getAttribute('href') ?? '');
    if (!href) return <span key={key}>{kids}</span>;
    return (
      <ExternalLink key={key} href={href} from={FROM} className="text-primaryBlue underline-offset-2 hover:underline">
        {kids}
      </ExternalLink>
    );
  }
  const cls = TAGS[tag];
  if (cls === undefined) return <span key={key}>{kids}</span>;
  const Tag = tag as 'p';
  return (
    <Tag key={key} className={cls || undefined}>
      {kids}
    </Tag>
  );
}

export function HtmlView({ html, className }: { html: string; className?: string }) {
  const nodes = useMemo(() => {
    if (!html) return [];
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return Array.from(doc.body.childNodes, (child, i) => render(child, String(i)));
  }, [html]);
  return <div className={cn('about-md flex flex-col gap-1.5 text-sm leading-relaxed text-textSecondary [overflow-wrap:anywhere]', className)}>{nodes}</div>;
}
