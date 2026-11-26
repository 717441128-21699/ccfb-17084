import { useEffect, useRef } from 'react';
import type { Raster } from '../core/types';

/** 把 RGBA 光栅画到 canvas 的通用组件(保持像素 1:1,容器内缩放) */
export function RasterCanvas({
  raster,
  className,
  onPointer,
  cursor,
}: {
  raster: Raster | null;
  className?: string;
  onPointer?: (e: { x: number; y: number; kind: 'down' | 'move' | 'up'; button: number }) => void;
  cursor?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !raster) return;
    if (canvas.width !== raster.width) canvas.width = raster.width;
    if (canvas.height !== raster.height) canvas.height = raster.height;
    const ctx = canvas.getContext('2d')!;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(raster.data), raster.width, raster.height), 0, 0);
  }, [raster]);

  return (
    <canvas
      ref={ref}
      className={className}
      style={{
        maxWidth: '100%',
        maxHeight: '100%',
        imageRendering: 'auto',
        cursor: cursor ?? 'default',
        touchAction: 'none',
      }}
      onPointerDown={(e) => {
        if (!onPointer || !ref.current) return;
        const p = toRaster(e, ref.current);
        onPointer({ ...p, kind: 'down', button: e.button });
      }}
      onPointerMove={(e) => {
        if (!onPointer || !ref.current) return;
        const p = toRaster(e, ref.current);
        onPointer({ ...p, kind: 'move', button: e.button });
      }}
      onPointerUp={(e) => {
        if (!onPointer || !ref.current) return;
        const p = toRaster(e, ref.current);
        onPointer({ ...p, kind: 'up', button: e.button });
      }}
    />
  );
}

function toRaster(e: React.PointerEvent<HTMLCanvasElement>, canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
  return { x, y };
}
