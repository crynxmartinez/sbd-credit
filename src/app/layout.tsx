import type { Metadata, Viewport } from "next";
import { Barlow_Semi_Condensed, IBM_Plex_Mono, Inter } from "next/font/google";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { Providers } from "@/components/Providers";
import "./legacy-tokens.css";
import "./app.css";

export const metadata: Metadata = {
  title: "Credit Tracker — Steel Building Depot",
  description: "Credit applications, approvals, balances and payment reminders.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/** Sets data-theme before first paint so a dark-mode user never sees a white flash. Static text, no user data. */
const THEME_SCRIPT = `(function(){try{var p=localStorage.getItem('credit-theme')||'system';var d=p==='dark'||(p==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light')}catch(e){}})()`;

// Downloaded at build time and served from this site. The CSS variables are what the design tokens refer to.
const displayFont = Barlow_Semi_Condensed({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-display-face", display: "swap" });
const bodyFont = Inter({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-body-face", display: "swap" });
// Figures only: loaded when a page uses them rather than preloaded on every page (the sign-in page needs none).
const monoFont = IBM_Plex_Mono({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-mono-face", display: "swap", preload: false });

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // Set by src/proxy.ts for this request. The inline script below only runs because it carries it.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" className={`${displayFont.variable} ${bodyFont.variable} ${monoFont.variable}`} suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
