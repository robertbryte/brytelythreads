"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { ProductDetail, ProductVariant } from "@/lib/catalog";
import { imageUrl } from "@/lib/images";
import { formatMoney } from "@/lib/util";
import { useCart } from "./CartProvider";
import { Img } from "./Img";

function matches(v: ProductVariant, selected: number[]) {
  return selected.every((id) => v.optionIds.includes(id));
}

export function ProductBuyBox({ product }: { product: ProductDetail }) {
  const { add } = useCart();
  const initial = product.variants.find((v) => v.isDefault && v.available) ?? product.variants.find((v) => v.available) ?? product.variants[0];
  const [selected, setSelected] = useState<number[]>(() =>
    product.options.map((o) => o.values.find((val) => initial?.optionIds.includes(val.id))?.id ?? o.values[0].id),
  );
  const [qty, setQty] = useState(1);
  const [imgIndex, setImgIndex] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  const variant = product.variants.find((v) => matches(v, selected));

  const images = useMemo(() => {
    const forVariant = variant ? product.images.filter((i) => i.variantIds.includes(variant.id)) : [];
    return forVariant.length ? forVariant : product.images;
  }, [variant, product.images]);

  useEffect(() => setImgIndex(0), [variant?.id]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  function choose(optIndex: number, valueId: number) {
    const next = [...selected];
    next[optIndex] = valueId;
    if (!product.variants.some((v) => matches(v, next))) {
      // Keep the new choice; pick the closest variant that has it.
      const fallback = product.variants.find((v) => v.available && v.optionIds.includes(valueId)) ?? product.variants.find((v) => v.optionIds.includes(valueId));
      if (fallback) {
        product.options.forEach((o, i) => {
          const hit = o.values.find((val) => fallback.optionIds.includes(val.id));
          if (hit) next[i] = hit.id;
        });
      }
    }
    setSelected(next);
  }

  /** Is value `valueId` of option `optIndex` purchasable given the other selections? */
  function state(optIndex: number, valueId: number): "ok" | "soldout" | "none" {
    const probe = [...selected];
    probe[optIndex] = valueId;
    const v = product.variants.find((x) => matches(x, probe));
    if (!v) return "none";
    return v.available ? "ok" : "soldout";
  }

  function onAdd() {
    if (!variant || !variant.available) return;
    const img = images[0] ?? product.images[0];
    add({
      productId: product.id, variantId: variant.id, quantity: qty, handle: product.handle, title: product.title,
      variantTitle: variant.title, price: variant.price, image: img ? imageUrl(img) : null,
    });
    setToast(`${product.title} (${variant.title}) added`);
  }

  const main = images[imgIndex] ?? images[0];
  const price = variant?.price ?? product.minPrice;

  return (
    <div className="pdp">
      <div className="gallery">
        <div className="gallery__main">
          {main && <Img src={imageUrl(main)} alt={`${product.title}${variant ? `, ${variant.title}` : ""}`} sizes="(min-width:900px) 55vw, 100vw" priority />}
        </div>
        {images.length > 1 && (
          <div className="gallery__thumbs" role="list">
            {images.map((img, i) => (
              <button key={img.src} type="button" aria-current={i === imgIndex ? "true" : undefined} aria-label={`View image ${i + 1} (${img.position})`} onClick={() => setImgIndex(i)}>
                <Img src={imageUrl(img)} alt="" maxWidth={320} />
              </button>
            ))}
          </div>
        )}
      </div>

      <div>
        <nav className="crumbs mono" aria-label="Breadcrumb">
          <Link href="/shop">Shop</Link>
          {product.tags[0] && (<><span aria-hidden="true">/</span><Link href={`/shop?tag=${product.tags[0].slug}`}>{product.tags[0].name}</Link></>)}
        </nav>
        <h1>{product.title}</h1>
        <div className="price num" aria-live="polite">{formatMoney(price)}</div>

        {product.options.map((opt, oi) => {
          const current = opt.values.find((v) => v.id === selected[oi]);
          const isColor = opt.type === "color";
          return (
            <fieldset key={opt.name} className="opt">
              <legend className="mono">
                <span>{opt.name.replace(/s$/, "")}</span>
                <b>{current?.title}</b>
              </legend>
              <div className={isColor ? "swatches" : "sizes"} role="radiogroup" aria-label={opt.name}>
                {opt.values.map((val) => {
                  const st = state(oi, val.id);
                  const checked = selected[oi] === val.id;
                  return isColor ? (
                    <button
                      key={val.id} type="button" role="radio" aria-checked={checked} aria-label={`${val.title}${st !== "ok" ? " (unavailable)" : ""}`}
                      title={val.title} className="swatch" data-unavailable={st !== "ok"}
                      style={{ background: val.colors?.[0] ?? "#ccc" }} onClick={() => choose(oi, val.id)}
                    />
                  ) : (
                    <button
                      key={val.id} type="button" role="radio" aria-checked={checked} className="size"
                      disabled={st === "none"} aria-label={`${val.title}${st === "soldout" ? " (sold out)" : ""}`}
                      onClick={() => choose(oi, val.id)}
                      style={st === "soldout" ? { textDecoration: "line-through", color: "var(--muted)" } : undefined}
                    >
                      {val.title}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          );
        })}

        <div className="buy">
          <div className="qty" aria-label="Quantity">
            <button type="button" aria-label="Decrease quantity" onClick={() => setQty((q) => Math.max(1, q - 1))}>−</button>
            <output aria-live="polite">{qty}</output>
            <button type="button" aria-label="Increase quantity" onClick={() => setQty((q) => Math.min(20, q + 1))}>+</button>
          </div>
          <button type="button" className="btn" disabled={!variant || !variant.available} onClick={onAdd}>
            {!variant ? "Choose options" : variant.available ? <>Add to cart <span className="btn__arrow" aria-hidden="true">→</span></> : "Sold out"}
          </button>
        </div>
        <p className="note">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeDasharray="2.5 2" /></svg>
          Printed when you order. Usually ships in 2–5 business days.
        </p>

        {product.description && <div className="prose" dangerouslySetInnerHTML={{ __html: product.description }} />}

        {product.tags.length > 0 && (
          <div className="tags-inline">
            {product.tags.map((t) => <Link key={t.slug} className="woven" href={`/shop?tag=${t.slug}`}>{t.name}</Link>)}
          </div>
        )}
      </div>

      {toast && (
        <div className="toast" role="status">
          {toast} <Link href="/cart">View cart</Link>
        </div>
      )}
    </div>
  );
}
