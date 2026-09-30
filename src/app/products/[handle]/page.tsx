import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProductBuyBox } from "@/components/ProductBuyBox";
import { ProductGrid } from "@/components/ProductCard";
import { getCatalogIndex, getProductByHandle } from "@/lib/catalog";
import { getEnv } from "@/lib/cf";
import { stripHtml } from "@/lib/sanitize";

export const dynamic = "force-dynamic";

type Params = Promise<{ handle: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { handle } = await params;
  const p = await getProductByHandle(getEnv(), handle);
  if (!p) return { title: "Not found" };
  const description = stripHtml(p.description).slice(0, 155) || `${p.title} — original graphic tee from Brytely Threads.`;
  return { title: p.title, description, openGraph: { title: p.title, description, images: p.image ? [p.image] : [] } };
}

export default async function ProductPage({ params }: { params: Params }) {
  const { handle } = await params;
  const env = getEnv();
  const product = await getProductByHandle(env, handle);
  if (!product) notFound();

  const index = await getCatalogIndex(env);
  const tagSlugs = new Set(product.tags.map((t) => t.slug));
  const related = index.products
    .filter((p) => p.id !== product.id && p.tags.some((t) => tagSlugs.has(t)))
    .slice(0, 4);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    image: product.images.slice(0, 5).map((i) => i.src),
    description: stripHtml(product.description),
    brand: { "@type": "Brand", name: "Brytely Threads" },
    offers: {
      "@type": "AggregateOffer", priceCurrency: "USD",
      lowPrice: (product.minPrice / 100).toFixed(2), highPrice: (product.maxPrice / 100).toFixed(2),
      availability: product.variants.some((v) => v.available) ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
    },
  };

  return (
    <div className="wrap">
      <ProductBuyBox product={product} />
      {related.length > 0 && (
        <section className="section" style={{ paddingTop: 0 }}>
          <div className="section__head"><h2>More like this</h2></div>
          <ProductGrid products={related} />
        </section>
      )}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
    </div>
  );
}
