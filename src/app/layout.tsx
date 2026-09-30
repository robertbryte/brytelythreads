import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Hanken_Grotesk, Martian_Mono } from "next/font/google";
import { CartProvider } from "@/components/CartProvider";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import "./globals.css";

const display = Bricolage_Grotesque({ subsets: ["latin"], weight: ["600", "700", "800"], variable: "--nf-display", display: "swap" });
const body = Hanken_Grotesk({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--nf-body", display: "swap" });
const mono = Martian_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--nf-mono", display: "swap" });

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://brytelythreads.shop";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "Brytely Threads — a little brighter, thread by thread", template: "%s · Brytely Threads" },
  description: "Original graphic tees for the things you're into. Clean designs, printed to order.",
  openGraph: { siteName: "Brytely Threads", type: "website" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f5f1" },
    { media: "(prefers-color-scheme: dark)", color: "#111215" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <CartProvider>
          <Header />
          <main id="main">{children}</main>
          <Footer />
        </CartProvider>
      </body>
    </html>
  );
}
