"use client";

import { mutate as globalMutate } from "swr";
import { authedJsonFetch } from "@/lib/browser-auth";

// Shared SWR cache layer for project data.
//
// Before this, each route kept its own copy of project state (the home board in
// a React context, the detail page in local component state) with no shared
// cache, so a status change on one route never reached the others. These keys +
// the global fetcher give every route a single, revalidatable source of truth.

// Module-scoped token cache shared by all SWR reads. `authedJsonFetch` refreshes
// on 401 and reports the working token via `onToken`; we keep the latest here so
// reads don't re-hit /auth/session on every request.
let cachedAccessToken: string | null = null;

/** Seed the shared token from a route that already has one (e.g. bootstrap). */
export function primeProjectSwrToken(token: string | null) {
  if (token) {
    cachedAccessToken = token;
  }
}

/** SWR fetcher: the key IS the request path. Returns the parsed JSON body. */
export async function projectSwrFetcher(path: string) {
  const { accessToken, data } = await authedJsonFetch({
    accessToken: cachedAccessToken,
    onToken: (token) => {
      cachedAccessToken = token;
    },
    path
  });
  cachedAccessToken = accessToken;
  return data;
}

// --- Key conventions --------------------------------------------------------

/** Cache key for a single project record (GET /projects/:id). */
export function projectKey(id: string) {
  return `/projects/${id}`;
}

const LIST_KEY_PREFIX = "/projects?";

/** Matches every cached projects-list variant (filters/sort change the query). */
export function isProjectsListKey(key: unknown): key is string {
  return typeof key === "string" && key.startsWith(LIST_KEY_PREFIX);
}

// --- Invalidation -----------------------------------------------------------

/**
 * After a status (or other) mutation, refresh the single project AND every
 * cached list variant across all routes. Any component subscribed via `useSWR`
 * to those keys re-renders with fresh data — this is what keeps the board and
 * the detail page in sync.
 */
export async function revalidateProjectEverywhere(id: string) {
  await Promise.all([
    globalMutate(projectKey(id)),
    globalMutate((key) => isProjectsListKey(key), undefined, { revalidate: true })
  ]);
}
