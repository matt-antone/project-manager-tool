"use client";

import { useEffect, useState } from "react";
import { authedJsonFetch } from "@/lib/browser-auth";
import type { ClientRecord } from "@/lib/types/client-record";

function listToText(values: string[] | null | undefined): string {
  return (values ?? []).join("\n");
}

function textToList(raw: string): string[] {
  return raw
    .split(/\r?\n|,/g)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export function ClientEditDialog({
  client,
  accessToken,
  open,
  onClose,
  onSaved
}: {
  client: ClientRecord;
  accessToken: string;
  open: boolean;
  onClose: () => void;
  onSaved: (next: ClientRecord) => void;
}) {
  const [name, setName] = useState(client.name);
  const [reposText, setReposText] = useState(listToText(client.github_repos));
  const [domainsText, setDomainsText] = useState(listToText(client.domains));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(client.name);
      setReposText(listToText(client.github_repos));
      setDomainsText(listToText(client.domains));
      setError(null);
    }
  }, [open, client]);

  if (!open) return null;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { data } = await authedJsonFetch({
        accessToken,
        path: `/api/clients/${client.id}`,
        init: {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            github_repos: textToList(reposText),
            domains: textToList(domainsText)
          })
        }
      });
      onSaved((data as { client: ClientRecord }).client);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" className="clientEditDialog">
      <form onSubmit={handleSubmit}>
        <h2>Edit client</h2>
        <label>
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label>
          GitHub repos (one per line)
          <textarea
            value={reposText}
            onChange={(e) => setReposText(e.target.value)}
            rows={3}
          />
        </label>
        <label>
          Domains (one per line)
          <textarea
            value={domainsText}
            onChange={(e) => setDomainsText(e.target.value)}
            rows={3}
          />
        </label>
        {error ? <p role="alert" className="clientEditDialogError">{error}</p> : null}
        <div className="clientEditDialogActions">
          <button type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" disabled={submitting || !name.trim()}>
            {submitting ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
