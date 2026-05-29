"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { OneShotButton } from "@/components/one-shot-button";
import { authedJsonFetch, fetchAuthSession } from "@/lib/browser-auth";
import { projectsNavHighlight } from "@/lib/projects-view-path";
import { DEFAULT_SITE_LOGO_URL, DEFAULT_SITE_TITLE, normalizeSiteLogoUrl, normalizeSiteTitle } from "@/lib/site-branding";

const THEME_KEY = "basecamp-clone-theme";

type Theme = "light" | "dark";
type SessionUser = { id: string; email?: string };
type SiteSettingsPayload = {
  siteTitle: string | null;
  logoUrl: string | null;
};

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.remove("light", "dark");
  root.classList.add(theme);
}

function IconGear() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.932 6.932 0 010 .255c-.007.378.138.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.37.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function IconEye() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

export default function SiteHeader() {
  const pathname = usePathname();
  const projectsNavActive = projectsNavHighlight(pathname);
  const clientsNavActive = pathname?.startsWith("/clients") ?? false;

  const [theme, setTheme] = useState<Theme>("light");
  const [user, setUser] = useState<SessionUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [billingStageCount, setBillingStageCount] = useState<number | null>(null);
  const [siteSettings, setSiteSettings] = useState<SiteSettingsPayload>({
    siteTitle: DEFAULT_SITE_TITLE,
    logoUrl: DEFAULT_SITE_LOGO_URL
  });
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") {
      setTheme(saved);
      applyTheme(saved);
      return;
    }
    const systemTheme: Theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    setTheme(systemTheme);
    applyTheme(systemTheme);
  }, []);

  useEffect(() => {
    if (!isAuthReady || !accessToken) {
      return;
    }

    let cancelled = false;

    async function loadSiteSettingsFromApi() {
      try {
        const response = await fetch("/site-settings", {
          cache: "no-store",
          credentials: "same-origin",
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (!response.ok) {
          return;
        }
        const payload = (await response.json().catch(() => null)) as
          | {
            siteSettings?: {
              siteTitle?: string | null;
              logoUrl?: string | null;
              site_title?: string | null;
              logo_url?: string | null;
            };
          }
          | null;
        const source = payload?.siteSettings ?? null;
        if (!source || cancelled) {
          return;
        }

        const rawTitle = source.siteTitle ?? source.site_title ?? null;
        const rawLogo = source.logoUrl ?? source.logo_url ?? null;

        setSiteSettings({
          siteTitle: normalizeSiteTitle(rawTitle),
          logoUrl: normalizeSiteLogoUrl(rawLogo)
        });
      } catch {
        /* Keep fallback branding if settings cannot be loaded. */
      }
    }

    void loadSiteSettingsFromApi();

    return () => {
      cancelled = true;
    };
  }, [isAuthReady, accessToken]);

  useEffect(() => {
    let cancelled = false;

    fetchAuthSession()
      .then((session) => {
        if (cancelled) return;
        setUser(session.user);
        setAccessToken(session.accessToken);
        setIsAuthReady(true);
        setIsSigningIn(false);
      })
      .catch(() => {
        if (cancelled) return;
        setUser(null);
        setAccessToken(null);
        setIsAuthReady(true);
        setIsSigningIn(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user || !accessToken) {
      setBillingStageCount(null);
      return;
    }

    let cancelled = false;

    async function loadBillingCount() {
      try {
        const { data } = await authedJsonFetch({
          accessToken,
          onToken: setAccessToken,
          path: "/projects/billing-count"
        });
        const raw = (data as { count?: unknown })?.count;
        const count = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
        if (!cancelled) {
          setBillingStageCount(count);
        }
      } catch {
        if (!cancelled) {
          setBillingStageCount(null);
        }
      }
    }

    void loadBillingCount();

    function onVisibility() {
      if (document.visibilityState === "visible") {
        void loadBillingCount();
      }
    }

    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [user, accessToken, pathname]);

  function toggleTheme() {
    const nextTheme: Theme = theme === "light" ? "dark" : "light";
    setTheme(nextTheme);
    localStorage.setItem(THEME_KEY, nextTheme);
    applyTheme(nextTheme);
  }

  async function signIn() {
    try {
      setIsSigningIn(true);
      window.location.href = "/auth/google/start";
    } catch {
      setIsSigningIn(false);
    }
  }

  async function signOut() {
    setUser(null);
    setAccessToken(null);
    window.location.href = "/auth/logout";
  }

  return (
    <div className="themeTopBar">
      <div className="brandCluster">
        <Link href="/" prefetch={false} className="brandHomeLink" aria-label="Go to home">
          <img src={siteSettings.logoUrl || DEFAULT_SITE_LOGO_URL} alt={`${siteSettings.siteTitle} logo`} className="brandLogo" />
        </Link>
        <Link href="/" prefetch={false} className="brandLink" aria-label={`${siteSettings.siteTitle} home`}>
          {siteSettings.siteTitle}
        </Link>
      </div>
      <div className="themeTopBarActions">
        {user && (
          <nav className="themeTopBarProjectsNav" aria-label="Projects views">
            <Link
              href="/"
              prefetch={false}
              className={`themeTopBarProjectsLink ${projectsNavActive === "list" ? "themeTopBarProjectsLinkActive" : ""}`}
              scroll={false}
            >
              Projects
            </Link>
            <Link
              href="/flow"
              prefetch={false}
              className={`themeTopBarProjectsLink ${projectsNavActive === "board" ? "themeTopBarProjectsLinkActive" : ""}`}
              scroll={false}
            >
              Project Board
            </Link>
            <Link
              href="/clients"
              prefetch={false}
              className={`themeTopBarProjectsLink ${clientsNavActive ? "themeTopBarProjectsLinkActive" : ""}`}
              scroll={false}
            >
              Clients
            </Link>
            <Link
              href="/billing"
              prefetch={false}
              className={`themeTopBarProjectsLink ${projectsNavActive === "billing" ? "themeTopBarProjectsLinkActive" : ""}`}
              scroll={false}
            >
              Billing
              {billingStageCount !== null && billingStageCount > 0 ? (
                <span className="themeTopBarProjectsBadge" aria-label={`${billingStageCount} in billing`}>
                  {billingStageCount > 99 ? "99+" : billingStageCount}
                </span>
              ) : null}
            </Link>
            <Link
              href="/archive"
              prefetch={false}
              className={`themeTopBarProjectsLink ${projectsNavActive === "archived" ? "themeTopBarProjectsLinkActive" : ""}`}
              scroll={false}
            >
              Archive
            </Link>
          </nav>
        )}
        {user && (
          <Link
            href="/settings"
            prefetch={false}
            className="themeHeaderButton themeHeaderButtonSecondary themeHeaderIconButton"
            aria-label="Settings"
            title="Settings"
          >
            <IconGear />
          </Link>
        )}
        <OneShotButton
          type="button"
          className="themeToggleButton"
          onClick={toggleTheme}
          aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
          title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
        >
          <IconEye />
        </OneShotButton>
        {isAuthReady && !user && (
          <OneShotButton
            type="button"
            className="themeHeaderButton themeHeaderButtonPrimary"
            onClick={signIn}
            disabled={isSigningIn}
          >
            {isSigningIn ? "Signing in..." : "Sign in"}
          </OneShotButton>
        )}
        {user && (
          <OneShotButton type="button" className="themeHeaderButton themeHeaderButtonGhost" onClick={signOut}>
            Sign out
          </OneShotButton>
        )}
      </div>
    </div>
  );
}
