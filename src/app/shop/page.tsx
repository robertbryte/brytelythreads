import type { Metadata } from "next";
import { ProductGrid, WovenLabel } from "@/components/ProductCard";
import { getCatalogIndex, type ProductSummary } from "@/lib/catalog";
import { getEnv } from "@/lib/cf";
import { SortSelect } from "@/components/SortSelect";

export const dynamic = "force-dynamic";

type Search = Promise<{ tag?: string; sort?: string }>;

export async function generateMetadata({ searchParams }: { searchParams: Search }): Promise<Metadata> {
  const { tag } = await searchParams;
  if (!tag) return { title: "Shop all tees" };
  const index = await getCatalogIndex(getEnv());
  const t = index.tags.find((x) => x.slug === tag);
  return { title: t ? `${t.name} tees` : "Shop" };
}

const SORTS: Record<string, { label: string; fn: (a: ProductSummary, b: ProductSummary) => number }> = {
  featured: { label: "Featured", fn: () => 0 },
  new: { label: "Newest", fn: (a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") },
  "price-asc": { label: "Price: low to high", fn: (a, b) => a.minPrice - b.minPrice },
  "price-desc": { label: "Price: high to low", fn: (a, b) => b.minPrice - a.minPrice },
};

export default async function Shop({ searchParams }: { searchParams: Search }) {
  const { tag, sort = "featured" } = await searchParams;
  const index = await getCatalogIndex(getEnv());
  const active = tag ? index.tags.find((t) => t.slug === tag) : undefined;
  const sorter = SORTS[sort] ?? SORTS.featured;
  const products = index.products.filter((p) => !tag || p.tags.includes(tag)).sort(sorter.fn);
  const qs = (next: { tag?: string; sort?: string }) => {
    const p = new URLSearchParams();
    const t = "tag" in next ? next.tag : tag;
    const s = "sort" in next ? next.sort : sort;
    if (t) p.set("tag", t);
    if (s && s !== "featured") p.set("sort", s);
    const str = p.toString();
    return `/shop${str ? `?${str}` : ""}`;
  };

  return (
    <div className="wrap">
      <header className="page-head">
        <div className="mono muted" style={{ marginBottom: 12 }}>{active ? "Collection" : "The whole rack"}</div>
        <h1>{active ? active.name : "All tees"}</h1>
        <p>{products.length} {products.length === 1 ? "design" : "designs"}{active ? ` tagged ${active.name}` : ""}. Every shirt printed to order.</p>
      </header>

      <nav className="filters" aria-label="Filter by collection">
        <WovenLabel href={qs({ tag: undefined })} name="Everything" count={index.products.length} current={!tag} />
        {index.tags.map((t) => <WovenLabel key={t.slug} href={qs({ tag: t.slug })} name={t.name} count={t.count} current={t.slug === tag} />)}
      </nav>

      <div className="toolbar">
        <span className="mono muted">Sort</span>
        <SortSelect tag={tag} value={SORTS[sort] ? sort : "featured"} options={Object.entries(SORTS).map(([value, v]) => ({ value, label: v.label }))} />
      </div>

      {products.length ? <ProductGrid products={products} /> : <div className="empty">Nothing here yet. Try another collection.</div>}
      <div style={{ height: 40 }} />
    </div>
  );
}

