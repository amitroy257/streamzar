/**
 * Image loader that also plays animated GIF / WebP / APNG using the ImageDecoder API.
 * Falls back to a static <img> when ImageDecoder is unavailable or the image is not animated.
 */
export class AnimatedImage {
  width = 0;
  height = 0;
  version = 0;
  error: string | null = null;
  private frames: { bitmap: ImageBitmap; durationMs: number }[] = [];
  private staticImg: HTMLImageElement | null = null;
  private totalMs = 0;
  private current: TexImageSource | null = null;
  private currentIndex = -1;
  private disposed = false;
  private startTime = performance.now();
  readonly ready: Promise<void>;

  constructor(
    readonly url: string,
    private readonly onChange: () => void = () => undefined,
  ) {
    this.ready = this.load().catch((e: Error) => {
      this.error = e.message;
      this.onChange();
    });
  }

  private async load() {
    const ImageDecoderCtor = (globalThis as unknown as { ImageDecoder?: new (init: { data: ReadableStream | ArrayBuffer; type: string }) => ImageDecoderLike }).ImageDecoder;
    const res = await fetch(this.url);
    if (!res.ok) throw new Error(`Could not load image (${res.status})`);
    const type = (res.headers.get('content-type') ?? '').split(';')[0];
    const animatedType = type === 'image/gif' || type === 'image/webp' || type === 'image/png' || type === 'image/apng';
    const buf = await res.arrayBuffer();
    if (this.disposed) return;
    if (ImageDecoderCtor && animatedType) {
      try {
        const dec = new ImageDecoderCtor({ data: buf, type });
        await dec.tracks.ready;
        const track = dec.tracks.selectedTrack;
        const count = track?.frameCount ?? 1;
        if (track?.animated && count > 1) {
          const n = Math.min(count, 600);
          for (let i = 0; i < n; i++) {
            const { image } = await dec.decode({ frameIndex: i });
            const bitmap = await createImageBitmap(image);
            const durationMs = Math.max(20, (image.duration ?? 100000) / 1000);
            image.close();
            if (this.disposed) {
              bitmap.close();
              return;
            }
            this.frames.push({ bitmap, durationMs });
            this.totalMs += durationMs;
          }
          dec.close();
          this.width = this.frames[0].bitmap.width;
          this.height = this.frames[0].bitmap.height;
          this.startTime = performance.now();
          this.onChange();
          return;
        }
        dec.close();
      } catch {
        // fall back to <img>
      }
    }
    const blobUrl = URL.createObjectURL(new Blob([buf], { type: type || 'image/png' }));
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = blobUrl;
      await img.decode();
      if (this.disposed) return;
      this.staticImg = img;
      this.width = img.naturalWidth || 1;
      this.height = img.naturalHeight || 1;
      this.current = img;
      this.version++;
      this.onChange();
    } finally {
      // The decoded image keeps its pixels; the blob URL is no longer needed.
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    }
  }

  get animated(): boolean {
    return this.frames.length > 1;
  }

  restart(): void {
    this.startTime = performance.now();
  }

  /** Current frame for time `now`. */
  frame(now: number, loop = true): TexImageSource | null {
    if (this.frames.length) {
      let t = now - this.startTime;
      if (loop) t = this.totalMs > 0 ? t % this.totalMs : 0;
      let idx = 0;
      let acc = 0;
      for (; idx < this.frames.length - 1; idx++) {
        acc += this.frames[idx].durationMs;
        if (t < acc) break;
      }
      if (idx !== this.currentIndex) {
        this.currentIndex = idx;
        this.current = this.frames[idx].bitmap;
        this.version++;
      }
      return this.current;
    }
    return this.staticImg;
  }

  get durationMs(): number {
    return this.totalMs;
  }

  dispose(): void {
    this.disposed = true;
    for (const f of this.frames) f.bitmap.close();
    this.frames = [];
    this.staticImg = null;
    this.current = null;
  }
}

interface ImageDecoderLike {
  tracks: { ready: Promise<void>; selectedTrack: { frameCount: number; animated: boolean } | null };
  decode(opts: { frameIndex: number }): Promise<{ image: VideoFrame }>;
  close(): void;
}
