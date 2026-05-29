"use client";

import React from "react";
import Link from "next/link";
import { OneShotButton } from "@/components/one-shot-button";
import { authedJsonFetch } from "@/lib/browser-auth";
import { DEFAULT_HOURLY_RATE_USD, formatUsdInput } from "@/lib/project-financials";
import {
  DEFAULT_SITE_LOGO_URL,
  DEFAULT_SITE_TITLE,
  normalizeSiteLogoUrl,
  normalizeSiteTitle
} from "@/lib/site-branding";
import type { ClientRecord } from "@/lib/types/client-record";
import { partitionClientsByArchiveState } from "@/lib/clients-filter";
import { useEffect, useMemo, useRef, useState } from "react";

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

export type ProfileForm = {
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl: string;
  jobTitle: string;
  timezone: string;
  bio: string;
};

export type SiteSettingsForm = {
  siteTitle: string;
  logoUrl: string;
  defaultHourlyRateUsd: string;
};

export const EMPTY_PROFILE: ProfileForm = {
  email: "",
  firstName: "",
  lastName: "",
  avatarUrl: "",
  jobTitle: "",
  timezone: "",
  bio: ""
};

export type SettingsBootstrap = {
  token: string | null;
  googleAvatarUrl: string;
  status: string;
  clients: ClientRecord[];
  profile: ProfileForm;
  siteSettings: SiteSettingsForm;
};

const CLIENT_ARCHIVE_POLL_INTERVAL_MS = 2000;

type ClientArchiveAction = "archive" | "restore";

function getClientArchiveStatus(client: ClientRecord) {
  return (client.dropbox_archive_status ?? "idle").toLowerCase();
}

function isClientArchiveRunning(client: ClientRecord) {
  const status = getClientArchiveStatus(client);
  return status === "pending" || status === "in_progress";
}

function getClientArchiveAction(client: ClientRecord): ClientArchiveAction {
  return client.archived_at ? "restore" : "archive";
}

function getClientArchiveButtonLabel(client: ClientRecord) {
  if (isClientArchiveRunning(client)) {
    return client.archived_at ? "Restoring..." : "Archiving...";
  }
  if (getClientArchiveStatus(client) === "failed") {
    return client.archived_at ? "Retry Restore" : "Retry Archive";
  }
  return client.archived_at ? "Restore" : "Archive";
}

function getClientArchiveSummary(client: ClientRecord) {
  const status = getClientArchiveStatus(client);
  if (status === "pending") {
    return client.archived_at ? "Queued to restore" : "Queued to archive";
  }
  if (status === "in_progress") {
    return client.archived_at ? "Restoring from Dropbox archive" : "Moving client folder to Dropbox archive";
  }
  if (status === "failed") {
    return client.archived_at ? "Restore failed" : "Archive failed";
  }
  if (client.archived_at || status === "completed") {
    return "Archived";
  }
  return "Active";
}

function normalizeClientList(values: string[] | null | undefined) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

function parseClientListInput(raw: string) {
  return normalizeClientList(raw.split(/\r?\n|,/g));
}

function formatClientListInput(values: string[] | null | undefined) {
  return normalizeClientList(values).join("\n");
}

function areClientListsEqual(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function SettingsPageContent({ initial }: { initial: SettingsBootstrap }) {
  const [token, setToken] = useState(initial.token);
  const [status, setStatus] = useState(initial.status);
  const [tab, setTab] = useState<"clients" | "profile" | "site">("clients");

  const [clients, setClients] = useState<ClientRecord[]>(initial.clients);
  const [clientFilter, setClientFilter] = useState<"active" | "archived">("active");
  const { activeClients, archivedClients, visibleClients } = useMemo(() => {
    const { active, archived } = partitionClientsByArchiveState(clients);
    return {
      activeClients: active,
      archivedClients: archived,
      visibleClients: clientFilter === "active" ? active : archived
    };
  }, [clients, clientFilter]);
  const clientDialogRef = useRef<HTMLDialogElement>(null);
  const [clientEditingId, setClientEditingId] = useState<string | null>(null);
  const [clientDialogName, setClientDialogName] = useState("");
  const [clientDialogCode, setClientDialogCode] = useState("");
  const [clientDialogGithubRepos, setClientDialogGithubRepos] = useState("");
  const [clientDialogDomains, setClientDialogDomains] = useState("");
  const [clientDialogSaving, setClientDialogSaving] = useState(false);
  const [clientDialogError, setClientDialogError] = useState<string | undefined>();

  const [profile, setProfile] = useState<ProfileForm>(initial.profile);
  const [siteSettings, setSiteSettings] = useState<SiteSettingsForm>(initial.siteSettings);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingSiteSettings, setSavingSiteSettings] = useState(false);
  const trimmedClientName = clientDialogName.trim();
  const trimmedClientCode = clientDialogCode.trim().toUpperCase();
  const parsedClientGithubRepos = parseClientListInput(clientDialogGithubRepos);
  const parsedClientDomains = parseClientListInput(clientDialogDomains);
  const isClientEdit = clientEditingId !== null;
  const clientBeingEdited = isClientEdit ? clients.find((client) => client.id === clientEditingId) ?? null : null;
  const hasClientNameChanged = clientBeingEdited ? clientBeingEdited.name !== trimmedClientName : true;
  const hasClientGithubReposChanged = clientBeingEdited
    ? !areClientListsEqual(normalizeClientList(clientBeingEdited.github_repos), parsedClientGithubRepos)
    : true;
  const hasClientDomainsChanged = clientBeingEdited
    ? !areClientListsEqual(normalizeClientList(clientBeingEdited.domains), parsedClientDomains)
    : true;
  const hasClientDetailsChanged = hasClientNameChanged || hasClientGithubReposChanged || hasClientDomainsChanged;
  const clientDialogSubmitDisabled =
    clientDialogSaving ||
    !trimmedClientName ||
    (!isClientEdit && !trimmedClientCode) ||
    (isClientEdit && !hasClientDetailsChanged);

  async function authedFetch(accessToken: string, path: string, options: RequestInit = {}) {
    const { accessToken: nextToken, data } = await authedJsonFetch({
      accessToken,
      init: options,
      onToken: setToken,
      path
    });
    if (nextToken !== token) {
      setToken(nextToken);
    }
    return data;
  }

  async function loadClients(accessToken: string) {
    const data = await authedFetch(accessToken, "/api/clients");
    setClients((data?.clients ?? []) as ClientRecord[]);
  }

  function profileToForm(data: UserProfileRecord | null): ProfileForm {
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

  function openCreateClientDialog() {
    setClientEditingId(null);
    setClientDialogName("");
    setClientDialogCode("");
    setClientDialogGithubRepos("");
    setClientDialogDomains("");
    setClientDialogError(undefined);
    clientDialogRef.current?.showModal();
  }

  function openEditClientDialog(client: ClientRecord) {
    setClientEditingId(client.id);
    setClientDialogName(client.name);
    setClientDialogCode(client.code);
    setClientDialogGithubRepos(formatClientListInput(client.github_repos));
    setClientDialogDomains(formatClientListInput(client.domains));
    setClientDialogError(undefined);
    clientDialogRef.current?.showModal();
  }

  function closeClientDialog() {
    clientDialogRef.current?.close();
    setClientDialogError(undefined);
  }

  async function submitClientDialog() {
    if (!token) return;
    if (!trimmedClientName) {
      setClientDialogError("Client name is required.");
      return;
    }
    if (!isClientEdit && !trimmedClientCode) {
      setClientDialogError("Client code is required.");
      return;
    }
    if (isClientEdit && !hasClientDetailsChanged) {
      closeClientDialog();
      return;
    }

    setClientDialogSaving(true);
    setClientDialogError(undefined);
    try {
      if (isClientEdit) {
        await authedFetch(token, `/api/clients/${clientEditingId}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: trimmedClientName,
            github_repos: parsedClientGithubRepos,
            domains: parsedClientDomains
          })
        });
        setStatus("Client updated");
      } else {
        await authedFetch(token, "/api/clients", {
          method: "POST",
          body: JSON.stringify({
            name: trimmedClientName,
            code: trimmedClientCode,
            github_repos: parsedClientGithubRepos,
            domains: parsedClientDomains
          })
        });
        setStatus("Client added");
      }
      closeClientDialog();
      await loadClients(token);
    } catch (error) {
      setClientDialogError(error instanceof Error ? error.message : "Request failed");
    } finally {
      setClientDialogSaving(false);
    }
  }

  async function submitClientArchiveAction(client: ClientRecord) {
    if (!token) return;
    const action = getClientArchiveAction(client);
    const isArchive = action === "archive";
    const confirmed = window.confirm(
      isArchive
        ? `Archive ${client.name}? This moves the client Dropbox folder to the archive root and temporarily blocks new projects, discussions, comments, and uploads until the move finishes.`
        : `Restore ${client.name}? This moves the client Dropbox folder back to the active root and re-enables new work once the move completes.`
    );
    if (!confirmed) {
      return;
    }

    try {
      await authedFetch(token, `/api/clients/${client.id}/${action}`, { method: "POST" });
      setStatus(isArchive ? `Archiving ${client.name}...` : `Restoring ${client.name}...`);
      await loadClients(token);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Request failed");
    }
  }

  const pollingIds = clients
    .filter((client) => isClientArchiveRunning(client))
    .map((client) => client.id)
    .sort()
    .join(",");

  useEffect(() => {
    if (!token || !pollingIds) {
      return;
    }

    const ids = pollingIds.split(",").filter(Boolean);
    let cancelled = false;

    const poll = async () => {
      try {
        const updates = await Promise.all(
          ids.map(async (clientId) => {
            const data = await authedFetch(token, `/api/clients/${clientId}`);
            return (data?.client ?? null) as ClientRecord | null;
          })
        );
        if (cancelled) {
          return;
        }

        const nextById = new Map(
          updates
            .filter((client): client is ClientRecord => client !== null)
            .map((client) => [client.id, client])
        );

        setClients((current) => current.map((client) => nextById.get(client.id) ?? client));
      } catch (error) {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : "Failed to refresh client archive status");
        }
      }
    };

    void poll();
    const intervalId = window.setInterval(() => {
      void poll();
    }, CLIENT_ARCHIVE_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [pollingIds, token]);

  async function saveProfile() {
    if (!token) return;
    setSavingProfile(true);
    try {
      const data = await authedFetch(token, "/profile", {
        method: "PATCH",
        body: JSON.stringify({
          firstName: profile.firstName,
          lastName: profile.lastName,
          avatarUrl: profile.avatarUrl,
          jobTitle: profile.jobTitle,
          timezone: profile.timezone,
          bio: profile.bio
        })
      });
      setProfile(profileToForm((data?.profile ?? null) as UserProfileRecord | null));
      setStatus("Profile updated");
    } finally {
      setSavingProfile(false);
    }
  }

  async function saveSiteSettings() {
    if (!token) return;
    setSavingSiteSettings(true);
    try {
      const nextSiteTitle = siteSettings.siteTitle.trim() || null;
      const nextLogoUrl = siteSettings.logoUrl.trim() || null;
      const trimmedHourlyRate = siteSettings.defaultHourlyRateUsd.trim();
      const parsedHourlyRate = trimmedHourlyRate ? Number(trimmedHourlyRate) : Number.NaN;
      if (trimmedHourlyRate && (!Number.isFinite(parsedHourlyRate) || parsedHourlyRate < 0 || parsedHourlyRate > 999999.99)) {
        throw new Error("Default hourly rate must be between 0 and 999999.99");
      }
      const data = await authedFetch(token, "/site-settings", {
        method: "PATCH",
        body: JSON.stringify({
          siteTitle: nextSiteTitle,
          logoUrl: nextLogoUrl,
          defaultHourlyRateUsd: trimmedHourlyRate ? parsedHourlyRate : DEFAULT_HOURLY_RATE_USD
        })
      });

      const payload = (data?.siteSettings ?? null) as {
        siteTitle?: string | null;
        logoUrl?: string | null;
        defaultHourlyRateUsd?: number | string | null;
        site_title?: string | null;
        logo_url?: string | null;
      } | null;
      const rawTitle = payload?.siteTitle ?? payload?.site_title ?? null;
      const rawLogo = payload?.logoUrl ?? payload?.logo_url ?? null;
      const rawHourlyRate = payload?.defaultHourlyRateUsd ?? DEFAULT_HOURLY_RATE_USD;
      setSiteSettings({
        siteTitle: normalizeSiteTitle(rawTitle),
        logoUrl: normalizeSiteLogoUrl(rawLogo),
        defaultHourlyRateUsd: formatUsdInput(rawHourlyRate)
      });
      setStatus("Site settings updated");
    } finally {
      setSavingSiteSettings(false);
    }
  }

  return (
    <main className="page">
      <header className="header">
        <h1>Settings</h1>
        <Link href="/" className="linkButton">
          Back to Workspace
        </Link>
      </header>

      <p className="status">{status}</p>

      <div className="tabsRow">
        <OneShotButton className={tab === "clients" ? "tabButton activeTab" : "tabButton"} onClick={() => setTab("clients")}>
          Client List
        </OneShotButton>
        <OneShotButton className={tab === "profile" ? "tabButton activeTab" : "tabButton"} onClick={() => setTab("profile")}>
          Profile
        </OneShotButton>
        <OneShotButton className={tab === "site" ? "tabButton activeTab" : "tabButton"} onClick={() => setTab("site")}>
          Site
        </OneShotButton>
      </div>

      {tab === "clients" && (
        <section className="stackSection">
          <h2>Clients</h2>
          <p>Each project must choose a client. Project labels are generated as: CLIENTCODE-0001-Title.</p>
          <div className="form">
            <OneShotButton type="button" onClick={openCreateClientDialog} disabled={!token}>
              Add client
            </OneShotButton>
          </div>

          <div
            role="tablist"
            aria-label="Client filter"
            className="settingsClientFilter"
          >
            <button
              type="button"
              role="tab"
              aria-selected={clientFilter === "active"}
              className={clientFilter === "active" ? "tabButton activeTab" : "tabButton"}
              onClick={() => setClientFilter("active")}
            >
              Active <span className="settingsClientFilterCount">({activeClients.length})</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={clientFilter === "archived"}
              className={clientFilter === "archived" ? "tabButton activeTab" : "tabButton"}
              onClick={() => setClientFilter("archived")}
            >
              Archived <span className="settingsClientFilterCount">({archivedClients.length})</span>
            </button>
          </div>

          {clients.length === 0 ? (
            <p className="status">No clients yet. Add your first client to start assigning projects.</p>
          ) : visibleClients.length === 0 ? (
            <p className="status">
              {clientFilter === "active" ? "No active clients." : "No archived clients."}
            </p>
          ) : (
            <ul className="settingsClientList">
              {visibleClients.map((client) => (
                <li key={client.id} className="settingsClientRow">
                  <div className="settingsClientRowBody">
                    <div className="settingsClientRowMain">
                      <strong>{client.code}</strong>
                      <span>{client.name}</span>
                    </div>
                    <div className="settingsClientMeta">
                      <span className={`settingsClientStatus settingsClientStatus-${getClientArchiveStatus(client)}`}>
                        {getClientArchiveSummary(client)}
                      </span>
                      {isClientArchiveRunning(client) ? (
                        <div className="settingsClientProgress" aria-live="polite">
                          <span className="settingsClientProgressBar" aria-hidden="true" />
                          <span>Large Dropbox moves can take a few minutes. Status updates every 2 seconds.</span>
                        </div>
                      ) : null}
                      {client.archive_error ? (
                        <p className="status settingsDialogError" role="alert">
                          {client.archive_error}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className="settingsClientActions">
                    <OneShotButton
                      type="button"
                      className="secondary"
                      onClick={() => openEditClientDialog(client)}
                      disabled={!token || isClientArchiveRunning(client)}
                      aria-label={`Edit ${client.name}`}
                    >
                      Edit
                    </OneShotButton>
                    <OneShotButton
                      type="button"
                      className="secondary"
                      onClick={() => submitClientArchiveAction(client).catch((error) => setStatus(error.message))}
                      disabled={!token || isClientArchiveRunning(client)}
                    >
                      {getClientArchiveButtonLabel(client)}
                    </OneShotButton>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === "profile" && (
        <section className="stackSection">
          <h2 className="profileTitle">
            <span className="profileAvatarFallback">{(profile.firstName || profile.email || "U").charAt(0).toUpperCase()}</span>
            <span>My Profile</span>
          </h2>
          <p>Set the details shown to teammates across the workspace.</p>

          <div className="form">
            <label>
              Email
              <input value={profile.email} readOnly />
            </label>

            <label>
              First name
              <input
                value={profile.firstName}
                onChange={(e) => setProfile((prev) => ({ ...prev, firstName: e.target.value }))}
                placeholder="First name"
              />
            </label>

            <label>
              Last name
              <input
                value={profile.lastName}
                onChange={(e) => setProfile((prev) => ({ ...prev, lastName: e.target.value }))}
                placeholder="Last name"
              />
            </label>

            <label>
              Job title
              <input
                value={profile.jobTitle}
                onChange={(e) => setProfile((prev) => ({ ...prev, jobTitle: e.target.value }))}
                placeholder="Product Designer"
              />
            </label>

            <label>
              Timezone
              <input
                value={profile.timezone}
                onChange={(e) => setProfile((prev) => ({ ...prev, timezone: e.target.value }))}
                placeholder="America/Los_Angeles"
              />
            </label>

            <label>
              Bio
              <textarea
                value={profile.bio}
                onChange={(e) => setProfile((prev) => ({ ...prev, bio: e.target.value }))}
                placeholder="A short bio"
              />
            </label>

            <OneShotButton onClick={() => saveProfile().catch((error) => setStatus(error.message))} disabled={savingProfile}>
              {savingProfile ? "Saving..." : "Save Profile"}
            </OneShotButton>
          </div>
        </section>
      )}

      <dialog
        ref={clientDialogRef}
        className="dialog"
        aria-labelledby="client-dialog-title"
        aria-describedby={isClientEdit ? "client-code-immutable-note" : undefined}
        onClose={() => {
          setClientDialogError(undefined);
          setClientEditingId(null);
        }}
      >
        <form
          className="dialogForm"
          onSubmit={(event) => {
            event.preventDefault();
            submitClientDialog();
          }}
        >
          <h3 id="client-dialog-title">{clientEditingId ? "Edit client" : "Add client"}</h3>
          <div className="form">
            <label className="dialogField">
              <span>Name</span>
              <input
                value={clientDialogName}
                onChange={(e) => setClientDialogName(e.target.value)}
                placeholder="Client name"
                disabled={clientDialogSaving}
                maxLength={120}
                autoFocus
              />
            </label>
            <label className="dialogField">
              <span>Code</span>
              <input
                value={clientDialogCode}
                onChange={(e) => setClientDialogCode(e.target.value.toUpperCase())}
                placeholder="e.g. ACME"
                disabled={clientDialogSaving || clientEditingId !== null}
                maxLength={16}
                autoCapitalize="characters"
                spellCheck={false}
              />
            </label>
            <label className="dialogField">
              <span>GitHub repositories</span>
              <textarea
                value={clientDialogGithubRepos}
                onChange={(e) => setClientDialogGithubRepos(e.target.value)}
                placeholder="owner/repo"
                disabled={clientDialogSaving}
              />
              <span className="dialogFieldHint">One repository per line (comma also supported).</span>
            </label>
            <label className="dialogField">
              <span>Domains</span>
              <textarea
                value={clientDialogDomains}
                onChange={(e) => setClientDialogDomains(e.target.value)}
                placeholder="example.com"
                disabled={clientDialogSaving}
              />
              <span className="dialogFieldHint">One domain per line (comma also supported).</span>
            </label>
            {clientEditingId ? (
              <p id="client-code-immutable-note" className="dialogFieldHint">
                Code can&apos;t be changed after the client is created.
              </p>
            ) : null}
            {clientDialogError ? (
              <p className="status settingsDialogError" role="alert" aria-live="polite">
                {clientDialogError}
              </p>
            ) : null}
          </div>
          <div className="row">
            <OneShotButton type="submit" disabled={clientDialogSubmitDisabled}>
              {clientDialogSaving ? "Saving…" : clientEditingId ? "Save changes" : "Add client"}
            </OneShotButton>
            <OneShotButton type="button" className="secondary" onClick={closeClientDialog} disabled={clientDialogSaving}>
              Cancel
            </OneShotButton>
          </div>
        </form>
      </dialog>

      {tab === "site" && (
        <section className="stackSection">
          <h2>Site Branding</h2>
          <p>Set a workspace-wide title and logo used in the top navigation.</p>

          <div className="form">
            <label>
              Site title
              <input
                value={siteSettings.siteTitle}
                onChange={(e) => setSiteSettings((prev) => ({ ...prev, siteTitle: e.target.value }))}
                placeholder={DEFAULT_SITE_TITLE}
              />
            </label>

            <label>
              Logo URL or path
              <input
                value={siteSettings.logoUrl}
                onChange={(e) => setSiteSettings((prev) => ({ ...prev, logoUrl: e.target.value }))}
                placeholder={DEFAULT_SITE_LOGO_URL}
              />
            </label>

            <label>
              Default hourly rate (USD)
              <input
                type="number"
                min="0"
                max="999999.99"
                step="0.01"
                inputMode="decimal"
                value={siteSettings.defaultHourlyRateUsd}
                onChange={(e) => setSiteSettings((prev) => ({ ...prev, defaultHourlyRateUsd: e.target.value }))}
                placeholder={formatUsdInput(DEFAULT_HOURLY_RATE_USD)}
              />
            </label>

            <p className="siteBrandPreviewLabel">Preview</p>
            <div className="siteBrandPreview" aria-label="Site branding preview">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={siteSettings.logoUrl.trim() || DEFAULT_SITE_LOGO_URL}
                alt={`${siteSettings.siteTitle.trim() || DEFAULT_SITE_TITLE} logo preview`}
                className="siteBrandPreviewLogo"
              />
              <span className="siteBrandPreviewTitle">{siteSettings.siteTitle.trim() || DEFAULT_SITE_TITLE}</span>
            </div>

            <OneShotButton onClick={() => saveSiteSettings().catch((error) => setStatus(error.message))} disabled={savingSiteSettings || !token}>
              {savingSiteSettings ? "Saving..." : "Save Site Settings"}
            </OneShotButton>
          </div>
        </section>
      )}
    </main>
  );
}
