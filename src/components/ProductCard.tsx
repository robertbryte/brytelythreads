import Link from "next/link";
import type { ProductSummary } from "@/lib/catalog";
import { formatMoney } from "@/lib/util";
import { Img } from "./Img";

export function ProductCard({ p, priority = false, badge }: { p: ProductSummary; priority?: boolean; badge?: string }) {
  const price = p.minPrice === p.maxPrice ? formatMoney(p.minPrice) : `from ${formatMoney(p.minPrice)}`;
  const sizes = "(min-width:1140px) 25vw, (min-width:820px) 33vw, 50vw";
  return (
    <Link href={`/products/${p.handle}`} className="card">
      <div className="card__media">
        <Img src={p.image} alt={p.title} sizes={sizes} priority={priority} maxWidth={828} />
        {p.hoverImage && <Img src={p.hoverImage} alt="" sizes={sizes} maxWidth={828} />}
        {badge && <span className="badge">{badge}</span>}
        <span className="hangtag">{price}</span>
      </div>
      <div className="card__title">{p.title}</div>
      {p.colors.length > 1 && (
        <div className="dots" aria-label={`${p.colors.length} colors`}>
          {p.colors.slice(0, 6).map((c) => <i key={c} style={{ background: c }} />)}
          {p.colors.length > 6 && <small>+{p.colors.length - 6}</small>}
        </div>
      )}
    </Link>
  );
}

export function ProductGrid({ products, badgeFor }: { products: ProductSummary[]; badgeFor?: (p: ProductSummary) => string | undefined }) {
  return (
    <div className="grid">
      {products.map((p, i) => <ProductCard key={p.id} p={p} priority={i < 4} badge={badgeFor?.(p)} />)}
    </div>
  );
}

export function WovenLabel({ href, name, count, current }: { href: string; name: string; count?: number; current?: boolean }) {
  return (
    <Link href={href} className="woven" aria-current={current ? "true" : undefined}>
      {name}
      {count !== undefined && <span className="woven__count">{String(count).padStart(2, "0")}</span>}
    </Link>
  );
}
