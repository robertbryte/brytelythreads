"use client";

import { useRouter } from "next/navigation";

export function SortSelect({ options, value, tag }: { options: { value: string; label: string }[]; value: string; tag?: string }) {
  const router = useRouter();
  return (
    <>
      <label htmlFor="sort" className="sr-only">Sort products</label>
      <select
        id="sort" className="select" value={value}
        onChange={(e) => {
          const p = new URLSearchParams();
          if (tag) p.set("tag", tag);
          if (e.target.value !== "featured") p.set("sort", e.target.value);
          router.push(`/shop${p.size ? `?${p}` : ""}`);
        }}
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </>
  );
}
