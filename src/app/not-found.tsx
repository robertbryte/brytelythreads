import Link from "next/link";

export default function NotFound() {
  return (
    <div className="wrap page-head" style={{ textAlign: "center", paddingBlock: 100 }}>
      <div className="mono muted">Error 404</div>
      <h1 style={{ marginTop: 12 }}>Dropped <span className="hl">a stitch</span>.</h1>
      <p style={{ marginInline: "auto", marginTop: 16 }}>That page doesn&apos;t exist, or the design was retired.</p>
      <p style={{ marginTop: 28 }}><Link className="btn" href="/shop">Back to the shop</Link></p>
    </div>
  );
}
