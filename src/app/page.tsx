import Link from "next/link";
import { ProductGrid, WovenLabel } from "@/components/ProductCard";
import { getBestSellerIds, getCatalogIndex } from "@/lib/catalog";
import { getEnv } from "@/lib/cf";

export const dynamic = "force-dynamic";

function CareIcon({ kind }: { kind: "print" | "ship" | "design" }) {
  // Drawn in the style of garment care symbols.
  if (kind === "print")
    return (
      <svg className="care__icon" viewBox="0 0 34 34" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <path d="M5 11l6-5h12l6 5-3 4-3-2v15H11V13l-3 2z" /><circle cx="17" cy="18" r="3" strokeDasharray="2 2" />
      </svg>
    );
  if (kind === "ship")
    return (
      <svg className="care__icon" viewBox="0 0 34 34" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <rect x="5" y="9" width="24" height="17" rx="1" /><path d="M5 15h24M13 9v6M21 9v6" strokeDasharray="2 2" />
      </svg>
    );
  return (
    <svg className="care__icon" viewBox="0 0 34 34" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="17" cy="17" r="11" /><path d="M11 17h12M17 11v12" />
    </svg>
  );
}

export default async function Home() {
  const env = getEnv();
  const [index, bestIds] = await Promise.all([getCatalogIndex(env), getBestSellerIds(env, 8)]);
  const byId = new Map(index.products.map((p) => [p.id, p]));

  let best = bestIds.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
  if (best.length < 4) {
    // Not enough sales yet — fill with featured, then newest.
    const extra = index.products.filter((p) => !best.includes(p)).sort((a, b) => Number(b.featured) - Number(a.featured));
    best = [...best, ...extra].slice(0, 8);
  }
  const bestSet = new Set(bestIds);
  const newest = [...index.products]
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
    .filter((p) => !best.slice(0, 4).includes(p))
    .slice(0, 8);

  return (
    <>
      <section className="hero">
        <div className="wrap hero__grid">
          <div>
            <div className="hero__eyebrow mono rise">Brytely Threads · Original graphic tees</div>
            <h1 className="rise rise-2">
              A little <span className="hl">brighter</span>, thread by thread.
            </h1>
            <p className="hero__sub rise rise-3">
              Clean, original designs for the things you&apos;re into — the course, the coffee, and whatever&apos;s next.
              No trend-chasing. Each shirt is printed when you order it.
            </p>
            <div className="hero__actions rise rise-3">
              <Link href="/shop" className="btn">Shop all tees <span className="btn__arrow" aria-hidden="true">→</span></Link>
              <Link href="/orders" className="btn btn--ghost">Track an order</Link>
            </div>
          </div>

          {index.tags.length > 0 && (
            <div className="rack rise rise-3" aria-label="Shop by interest">
              <div className="rack__caption mono"><span>Shop by interest</span><span>{index.tags.length} collections</span></div>
              <div className="rack__labels">
                {index.tags.map((t) => <WovenLabel key={t.slug} href={`/shop?tag=${t.slug}`} name={t.name} count={t.count} />)}
              </div>
            </div>
          )}
        </div>
      </section>

      <div className="wrap">
        <div className="care">
          <div className="care__row">
            <div className="care__item"><CareIcon kind="print" /><div><strong>Printed to order</strong><span>Made when you buy it. No overstock.</span></div></div>
            <div className="care__item"><CareIcon kind="ship" /><div><strong>Tracked shipping</strong><span>Tracking emailed the day it ships.</span></div></div>
            <div className="care__item"><CareIcon kind="design" /><div><strong>Original designs</strong><span>Drawn in-house. Built to outlast trends.</span></div></div>
          </div>
        </div>
      </div>

      {index.products.length === 0 ? (
        <section className="section wrap">
          <div className="empty">New designs are on the way. Check back soon.</div>
        </section>
      ) : (
        <>
          <section className="section wrap">
            <div className="section__head">
              <h2>{bestIds.length >= 4 ? "Best sellers" : "Start here"}<sup>{String(best.length).padStart(2, "0")}</sup></h2>
              <Link href="/shop" className="link-arrow">See everything</Link>
            </div>
            <ProductGrid products={best} badgeFor={(p) => (bestSet.has(p.id) ? "Best seller" : undefined)} />
          </section>

          {newest.length > 0 && (
            <section className="section wrap" style={{ paddingTop: 0 }}>
              <div className="section__head">
                <h2>Fresh off the press<sup>{String(newest.length).padStart(2, "0")}</sup></h2>
                <Link href="/shop?sort=new" className="link-arrow">All new designs</Link>
              </div>
              <ProductGrid products={newest} badgeFor={(p) => (p.featured ? "Staff pick" : undefined)} />
            </section>
          )}
        </>
      )}
    </>
  );
}
