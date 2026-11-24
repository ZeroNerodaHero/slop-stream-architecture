import { cn } from '@/utils/cn';

interface OfflinePictureProps {
  id: string;
  src: string;
  className?: string;
}

export function OfflinePicture({ id, src, className }: OfflinePictureProps) {
  return (
    <span className={cn('relative block aspect-video overflow-hidden border border-primaryStroke bg-black', className)}>
      <img id={id} src={src} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover opacity-80 [filter:grayscale(25%)]" />
      <span aria-hidden className="absolute inset-0 bg-black/10" />
      <span className="absolute inset-0 flex items-center justify-center p-3">
        <span className="border border-white/10 bg-black/70 px-3 py-1 text-sm font-semibold uppercase tracking-wide text-white backdrop-blur-sm">
          not streaming yet
        </span>
      </span>
    </span>
  );
}
