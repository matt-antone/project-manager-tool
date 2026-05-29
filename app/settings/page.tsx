"use client";

import React from "react";
import { PageLoadingState } from "@/components/loading-shells";
import { authedJsonFetch, fetchAuthSession } from "@/lib/browser-auth";
import { createClientResource } from "@/lib/client-resource";
import { DEFAULT_HOURLY_RATE_USD, formatUsdInput } from "@/lib/project-financials";
import {
  DEFAULT_SITE_LOGO_URL,
  DEFAULT_SITE_TITLE,
  normalizeSiteLogoUrl,
  normalizeSiteTitle
} from "@/lib/site-branding";
import type { ClientRecord } from "@/lib/types/client-record";
import { useEffect, useState } from "react";
import {
  type ProfileForm,
  type SiteSettingsForm,
  type SettingsBootstrap,
  EMPTY_PROFILE,
  SettingsPageContent
} from "./_settings-page-content";

type UserProfileRecord = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
  job_title: string | null;
  timezone: string | null;
  bio: string | null;
};

const settingsBootstrapResource = createClientResource(loadSettingsBootstrap, () => "settings");

export default function SettingsPage() {
  const [initial, setInitial] = useState<SettingsBootstrap | null>(null);

  useEffect(() => {
    let cancelled = false;

    settingsBootstrapResource.read("settings").then((nextState) => {
      if (!cancelled) {
        setInitial(nextState);
      }
    });

    return () => {
      cancelled = true;
      settingsBootstrapResource.clear();
    };
  }, []);

  if (!initial) {
    return (
      <PageLoadingState
        label="Loading settings"
        message="Getting your profile and preferences ready."
      />
    );
  }

  return <SettingsPageContent initial={initial} />;
}

function profileRecordToForm(data: UserProfileRecord | null): ProfileForm {
  if (!data) {
    return EMPTY_PROFILE;
  }

  return {
    email: data.email ?? "",
    firstName: data.first_name ?? "",
    lastName: data.last_name ?? "",
    avatarUrl: data.avatar_url ?? "",
    jobTitle: data.job_title ?? "",
    timezone: data.timezone ?? "",
    bio: data.bio ?? ""
  };
}

async function loadSettingsBootstrap(): Promise<SettingsBootstrap> {
  try {
    const session = await fetchAuthSession();
    const accessToken = session.accessToken;
    const googleAvatarUrl = session.googleAvatarUrl;
    const siteSettings = await loadSiteSettings(accessToken);

    if (!accessToken) {
      return {
        token: null,
        googleAvatarUrl,
        status: session.status || "Sign in first, then open settings",
        clients: [],
        profile: EMPTY_PROFILE,
        siteSettings
      };
    }

    const [clientsData, profileData] = await Promise.all([
      authedJsonFetch({ accessToken, path: "/api/clients" }),
      authedJsonFetch({ accessToken, path: "/profile" })
    ]);

    return {
      token: clientsData.accessToken,
      googleAvatarUrl,
      status: session.status,
      clients: (clientsData.data?.clients ?? []) as ClientRecord[],
      profile: profileRecordToForm((profileData.data?.profile ?? null) as UserProfileRecord | null),
      siteSettings
    };
  } catch (error) {
    return {
      token: null,
      googleAvatarUrl: "",
      status: error instanceof Error ? error.message : "Failed to load",
      clients: [],
      profile: EMPTY_PROFILE,
      siteSettings: {
        siteTitle: DEFAULT_SITE_TITLE,
        logoUrl: DEFAULT_SITE_LOGO_URL,
        defaultHourlyRateUsd: formatUsdInput(DEFAULT_HOURLY_RATE_USD)
      }
    };
  }
}

async function loadSiteSettings(accessToken: string | null): Promise<SiteSettingsForm> {
  if (!accessToken) {
    return {
      siteTitle: DEFAULT_SITE_TITLE,
      logoUrl: DEFAULT_SITE_LOGO_URL,
      defaultHourlyRateUsd: formatUsdInput(DEFAULT_HOURLY_RATE_USD)
    };
  }

  try {
    const response = await fetch("/site-settings", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) {
      return {
        siteTitle: DEFAULT_SITE_TITLE,
        logoUrl: DEFAULT_SITE_LOGO_URL,
        defaultHourlyRateUsd: formatUsdInput(DEFAULT_HOURLY_RATE_USD)
      };
    }

    const payload = (await response.json().catch(() => null)) as
      | {
        siteSettings?: {
          siteTitle?: string | null;
          logoUrl?: string | null;
          defaultHourlyRateUsd?: number | string | null;
          site_title?: string | null;
          logo_url?: string | null;
        };
      }
      | null;
    const source = payload?.siteSettings ?? null;
    const rawTitle = source?.siteTitle ?? source?.site_title ?? null;
    const rawLogo = source?.logoUrl ?? source?.logo_url ?? null;
    const rawHourlyRate = source?.defaultHourlyRateUsd ?? DEFAULT_HOURLY_RATE_USD;

    return {
      siteTitle: normalizeSiteTitle(rawTitle),
      logoUrl: normalizeSiteLogoUrl(rawLogo),
      defaultHourlyRateUsd: formatUsdInput(rawHourlyRate)
    };
  } catch {
    return {
      siteTitle: DEFAULT_SITE_TITLE,
      logoUrl: DEFAULT_SITE_LOGO_URL,
      defaultHourlyRateUsd: formatUsdInput(DEFAULT_HOURLY_RATE_USD)
    };
  }
}
