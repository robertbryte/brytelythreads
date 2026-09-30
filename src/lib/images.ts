/** Client-safe image helpers (no server imports). */
export interface ProductImage { src: string; variantIds: number[]; position: string; isDefault: boolean; r2Key?: string }

/** Mirrored images are served from R2 via /media/…; otherwise the Printify CDN URL. */
export function imageUrl(img: Pick<ProductImage, "src" | "r2Key">): string {
  return img.r2Key ? `/media/${img.r2Key}` : img.src;
}
