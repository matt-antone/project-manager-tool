import type { Metadata } from "next";
import { Instrument_Sans, Newsreader } from "next/font/google";
import Script from "next/script";
import { getSiteSettings } from "@/lib/repositories";
import { DEFAULT_SITE_TITLE, SITE_DESCRIPTION, normalizeSiteTitle } from "@/lib/site-branding";
import "./styles.css";
import SiteHeader from "./header";
import { SwrProvider } from "@/components/swr-provider";

export async function generateMetadata(): Promise<Metadata> {
  try {
    const siteSettings = await getSiteSettings();

    return {
      title: normalizeSiteTitle(siteSettings?.siteTitle),
      description: SITE_DESCRIPTION
    };
  } catch {
    return {
      title: DEFAULT_SITE_TITLE,
      description: SITE_DESCRIPTION
    };
  }
}

const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  display: "swap"
});

const newsreader = Newsreader({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display"
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" className="light" suppressHydrationWarning>
      <head>
        <Script id="theme-init" strategy="beforeInteractive">
          {`(() => {
            try {
              const key = "basecamp-clone-theme";
              const saved = window.localStorage.getItem(key);
              const theme =
                saved === "light" || saved === "dark"
                  ? saved
                  : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
              const root = document.documentElement;
              root.dataset.theme = theme;
              root.classList.remove("light", "dark");
              root.classList.add(theme);
            } catch {}
          })();`}
        </Script>
      </head>
      <body className={`${instrumentSans.className} ${newsreader.variable}`}>
        <SwrProvider>
          <SiteHeader />
          <div className="appFrame">{children}</div>
        </SwrProvider>
      </body>
    </html>
  );
}
