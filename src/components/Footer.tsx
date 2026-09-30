import Link from "next/link";

export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="footer">
      <div className="wrap footer__grid">
        <div>
          <h3>Brytely Threads</h3>
          <p style={{ maxWidth: "36ch", opacity: 0.85 }}>
            Original graphic tees for the things you&apos;re into. Clean designs that won&apos;t look dated next year,
            printed one at a time when you order.
          </p>
        </div>
        <div>
          <h3>Shop</h3>
          <ul>
            <li><Link href="/shop">All tees</Link></li>
            <li><Link href="/cart">Cart</Link></li>
          </ul>
        </div>
        <div>
          <h3>Help</h3>
          <ul>
            <li><Link href="/orders">Order status</Link></li>
            <li><Link href="/shop">Sizing is on each product page</Link></li>
          </ul>
        </div>
      </div>
      <div className="wrap" aria-hidden="true">
        <div className="footer__big">Brytely<span>.</span></div>
      </div>
      <div className="wrap footer__legal mono">
        <span>© {year} Brytely Threads</span>
        <span>A little brighter, thread by thread</span>
      </div>
    </footer>
  );
}
