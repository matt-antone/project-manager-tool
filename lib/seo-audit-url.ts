/**
 * URL normalization + SSRF guard for the SEO Audit tool.
 *
 * `POST /api/tools/seo-audit` accepts a user-supplied URL and fetches it
 * server-side via `runApiAudit`, so any hostname that resolves to loopback,
 * link-local, or private address space must be rejected before the audit
 * engine ever sees it.
 *
 * Note on alternate IPv4 encodings (octal `0177.0.0.1`, decimal `2130706433`,
 * hex `0x7f000001`): the WHATWG `URL` parser canonicalizes these to dotted-quad
 * before `isDisallowedAuditHost` ever runs, so they are covered. That is a
 * property of `URL`, not of the checks below — callers that skip
 * `normalizeSeoAuditUrl` and pass a raw string here do not get that guarantee.
 *
 * This is a syntactic guard only. It cannot stop a public hostname whose DNS
 * record points at private space (DNS rebinding); defending against that
 * requires resolving the name and checking the resolved address at connect
 * time, which the upstream audit engine does not expose a hook for.
 */

export class InvalidSeoAuditUrlError extends Error {}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Matches a URL scheme prefix. The `(?!\d)` guard distinguishes a real scheme
 * (`file:`, `javascript:`) from a bare `host:port` (`example.com:8080`), since
 * dots and digits are both legal scheme characters.
 */
const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):(?!\d)/i;

/** True if the dotted-quad `octets` fall in loopback/private/link-local space. */
function isDisallowedIpv4(octets: number[]): boolean {
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }
  const [a, b] = octets;
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (covers 169.254.169.254 metadata)
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

/**
 * Expands an IPv6 literal to its eight 16-bit hextets, resolving `::` and any
 * trailing embedded IPv4 (`::ffff:127.0.0.1`). Returns null if `host` is not a
 * parseable IPv6 literal.
 */
function parseIpv6Hextets(host: string): number[] | null {
  if (!host.includes(":")) {
    return null;
  }

  let body = host;
  const embeddedIpv4: number[] = [];

  // A trailing dotted-quad occupies the final two hextets.
  const lastColon = body.lastIndexOf(":");
  const tail = body.slice(lastColon + 1);
  const tailMatch = tail.match(IPV4_PATTERN);
  if (tailMatch) {
    const octets = tailMatch.slice(1, 5).map((part) => Number(part));
    if (octets.some((octet) => !Number.isInteger(octet) || octet > 255)) {
      return null;
    }
    embeddedIpv4.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
    body = body.slice(0, lastColon + 1);
  }

  const doubleColonCount = (body.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) {
    return null;
  }

  const [head, rest] = doubleColonCount === 1 ? body.split("::") : [body, null];

  const toHextets = (segment: string): number[] | null => {
    if (!segment) return [];
    const parts = segment.split(":").filter((part) => part.length > 0);
    const values: number[] = [];
    for (const part of parts) {
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
      values.push(Number.parseInt(part, 16));
    }
    return values;
  };

  const headHextets = toHextets(head);
  const restHextets = rest === null ? [] : toHextets(rest);
  if (headHextets === null || restHextets === null) {
    return null;
  }

  const known = [...headHextets, ...restHextets, ...embeddedIpv4];
  if (doubleColonCount === 0) {
    return known.length === 8 ? known : null;
  }
  if (known.length >= 8) {
    return null;
  }

  const fill = new Array(8 - known.length).fill(0);
  return [...headHextets, ...fill, ...restHextets, ...embeddedIpv4];
}

/** True if `hextets` is loopback, unspecified, link-local, ULA, or mapped-private. */
function isDisallowedIpv6(hextets: number[]): boolean {
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible — unwrap and reuse the v4 rules.
  const leadingZeros = hextets.slice(0, 5).every((hextet) => hextet === 0);
  if (leadingZeros && (hextets[5] === 0xffff || hextets[5] === 0)) {
    const a = (hextets[6] >> 8) & 0xff;
    const b = hextets[6] & 0xff;
    const c = (hextets[7] >> 8) & 0xff;
    const d = hextets[7] & 0xff;
    // ::0 and ::1 fall out of the v4 rules as 0.0.0.0/8 and 127-less; handle explicitly.
    if (hextets[5] === 0 && hextets[6] === 0 && (hextets[7] === 0 || hextets[7] === 1)) {
      return true; // :: and ::1
    }
    if (isDisallowedIpv4([a, b, c, d])) {
      return true;
    }
  }

  const first = hextets[0];
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local

  return false;
}

/** True if `hostname` is a loopback, link-local, or private-range literal. */
export function isDisallowedAuditHost(hostname: string): boolean {
  // Strip brackets, then the FQDN root dot — `localhost.` is `localhost`.
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.+$/, "");

  if (!host) {
    return true;
  }

  if (host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }

  const hextets = parseIpv6Hextets(host);
  if (hextets) {
    return isDisallowedIpv6(hextets);
  }

  const ipv4Match = host.match(IPV4_PATTERN);
  if (ipv4Match) {
    return isDisallowedIpv4(ipv4Match.slice(1, 5).map((part) => Number(part)));
  }

  return false;
}

/**
 * Normalizes and validates a user-supplied URL for the SEO audit engine.
 * Throws `InvalidSeoAuditUrlError` for anything malformed, non-http(s), or
 * pointed at loopback/link-local/private address space.
 */
export function normalizeSeoAuditUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new InvalidSeoAuditUrlError("URL is required");
  }

  // Reject a non-http(s) scheme outright rather than prepending `https://` to
  // it, which would silently mangle `file:///etc/passwd` into a request for
  // host "file" instead of failing.
  const schemeMatch = trimmed.match(SCHEME_PATTERN);
  if (schemeMatch && !/^https?$/i.test(schemeMatch[1])) {
    throw new InvalidSeoAuditUrlError("URL must use http or https");
  }

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new InvalidSeoAuditUrlError("URL is not valid");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidSeoAuditUrlError("URL must use http or https");
  }

  if (!parsed.hostname) {
    throw new InvalidSeoAuditUrlError("URL is missing a host");
  }

  if (isDisallowedAuditHost(parsed.hostname)) {
    throw new InvalidSeoAuditUrlError("URL host is not allowed");
  }

  return parsed.toString();
}
