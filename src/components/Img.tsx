/**
 * Image with Cloudflare Image Resizing.
 * When NEXT_PUBLIC_CF_IMAGE_RESIZING=true (zone has Images → Transformations
 * enabled), mockups are served resized + WebP/AVIF via /cdn-cgi/image/.
 * Otherwise the original URL is used unchanged.
 */
const RESIZE = process.env.NEXT_PUBLIC_CF_IMAGE_RESIZING === "true";
const WIDTHS = [320, 480, 640, 828, 1080, 1440];

export function cfImage(src: string, width: number, quality = 80): string {
  if (!RESIZE || !src) return src;
  const source = src.startsWith("/") ? src.slice(1) : src; // same-zone paths are relative
  return `/cdn-cgi/image/width=${width},quality=${quality},format=auto,fit=scale-down/${source}`;
}

export function Img({
  src, alt, sizes = "100vw", priority = false, className, maxWidth = 1440,
}: { src: string | null; alt: string; sizes?: string; priority?: boolean; className?: string; maxWidth?: number }) {
  if (!src) return null;
  const widths = WIDTHS.filter((w) => w <= maxWidth);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={cfImage(src, widths[widths.length - 1] ?? maxWidth)}
      srcSet={RESIZE ? widths.map((w) => `${cfImage(src, w)} ${w}w`).join(", ") : undefined}
      sizes={RESIZE ? sizes : undefined}
      alt={alt}
      className={className}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : "auto"}
      decoding="async"
    />
  );
}
