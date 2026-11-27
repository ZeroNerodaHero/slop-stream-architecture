import { type AboutBlock, isBlank } from '@/infra/about-blocks';

import { cellStyle, GridFrame, shownOn } from './AboutGrid';
import { BlockView, type PageMeta } from './BlockView';

export function PageView({ blocks, meta, name, phone, id }: { blocks: readonly AboutBlock[]; meta: PageMeta; name: string; phone: boolean; id?: string }) {
  const shown = blocks.filter((b) => shownOn(b, phone) && !isBlank(b, meta.socials.links.length));
  return (
    <GridFrame phone={phone}>
      {shown.map((b) => (
        <div key={b.id} id={id ? `${id}-${b.id}` : undefined} data-kind={b.kind} style={cellStyle(b, phone)} className="min-w-0">
          <BlockView b={b} name={name} meta={meta} phone={phone} />
        </div>
      ))}
    </GridFrame>
  );
}
