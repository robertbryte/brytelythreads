"use client";

import Link from "next/link";
import { useCart } from "./CartProvider";

export function Wordmark() {
  return (
    <Link href="/" className="wordmark" aria-label="Brytely Threads, home">
      Brytely Threads<span className="wordmark__dot" aria-hidden="true" />
    </Link>
  );
}

export function Seam({ sew = false }: { sew?: boolean }) {
  return (
    <svg className={`seam${sew ? " seam--sew" : ""}`} viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" y1="3" x2="100" y2="3" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Header() {
  const { count, ready } = useCart();
  return (
    <>
      <div className="announce">
        <div className="wrap mono">Printed to order · Tracked shipping · Free US shipping over $75</div>
      </div>
      <header className="site-header">
        <div className="wrap site-header__row">
          <Wordmark />
          <nav className="nav" aria-label="Main">
            <Link className="nav__link" href="/shop">Shop</Link>
            <Link className="nav__link nav__link--hide-sm" href="/orders">Order status</Link>
            <Link className="cart-btn" href="/cart" aria-label={`Cart, ${count} items`}>
              Cart <span className="cart-btn__count">{ready ? count : 0}</span>
            </Link>
          </nav>
        </div>
        <div className="wrap"><Seam sew /></div>
      </header>
    </>
  );
}
