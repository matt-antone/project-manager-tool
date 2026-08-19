import type { SupabaseClient } from "@supabase/supabase-js";

export interface AgentIdentity {
  client_id: string;
  role: string;
}

export interface RateLimiter {
  consume(key: string): boolean;
}

export interface JwtAuthConfig {
  secret: string;
  issuer: string;
  audience: string;
  clockToleranceSeconds?: number;
}

export interface JwtClaims {
  sub: string;
  iss: string;
  aud: string | string[];
  iat: number;
  exp: number;
  jti: string;
  role?: string;
  scope?: string | string[];
  token_version?: number;
  auth_epoch?: number;
  nbf?: number;
}

export interface MintJwtParams {
  client_id: string;
  role?: string;
  scope?: string | string[];
  expiresInSeconds?: number;
  token_version?: number;
  auth_epoch?: number;
  issuedAt?: number;
  jti?: string;
}

export class AuthError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "AuthError";
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const JWT_ALG = "HS256";

// Audiences for the stateless OAuth artifacts. Shared with the app's /mcp/authorize route.
export const OAUTH_CLIENT_AUDIENCE = "oauth-client";
export const OAUTH_CODE_AUDIENCE = "oauth-code";
export const OAUTH_CODE_TTL_SECONDS = 120;

export function createRateLimiter(rpmLimit: number): RateLimiter {
  const windows = new Map<string, number[]>();
  return {
    consume(key: string): boolean {
      const now = Date.now();
      const windowMs = 60_000;
      const hits = (windows.get(key) ?? []).filter((t) => now - t < windowMs);
      if (hits.length >= rpmLimit) return false;
      hits.push(now);
      windows.set(key, hits);
      return true;
    },
  };
}

export function parseBearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (base64.length % 4)) % 4;
  return base64ToBytes(base64 + "=".repeat(padLength));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}

function normalizeAudience(aud: unknown): string[] {
  if (typeof aud === "string") return [aud];
  if (Array.isArray(aud)) return aud.filter((value): value is string => typeof value === "string");
  return [];
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signJwt(claims: Record<string, unknown>, config: JwtAuthConfig): Promise<string> {
  const header = { alg: JWT_ALG, typ: "JWT" };
  const encodedHeader = base64UrlEncode(textEncoder.encode(JSON.stringify(header)));
  const encodedPayload = base64UrlEncode(textEncoder.encode(JSON.stringify(claims)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = await importSigningKey(config.secret);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(signingInput)));
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

export async function mintAgentJwt(params: MintJwtParams, config: JwtAuthConfig): Promise<string> {
  const now = params.issuedAt ?? Math.floor(Date.now() / 1000);
  const exp = now + (params.expiresInSeconds ?? 15 * 60);
  return await signJwt(
    {
      sub: params.client_id,
      iss: config.issuer,
      aud: config.audience,
      iat: now,
      exp,
      jti: params.jti ?? crypto.randomUUID(),
      ...(params.role ? { role: params.role } : {}),
      ...(params.scope !== undefined ? { scope: params.scope } : {}),
      ...(params.token_version !== undefined ? { token_version: params.token_version } : {}),
      ...(params.auth_epoch !== undefined ? { auth_epoch: params.auth_epoch } : {}),
    },
    config
  );
}

export async function verifyJwt(token: string, config: JwtAuthConfig): Promise<JwtClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("Invalid token", 401);

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  let header: Record<string, unknown>;
  let payload: unknown;

  try {
    header = JSON.parse(textDecoder.decode(base64UrlDecode(encodedHeader)));
    payload = JSON.parse(textDecoder.decode(base64UrlDecode(encodedPayload)));
  } catch {
    throw new AuthError("Invalid token", 401);
  }

  if (!isRecord(header) || header.alg !== JWT_ALG) {
    throw new AuthError("Invalid token", 401);
  }
  if (!isRecord(payload)) throw new AuthError("Invalid token", 401);

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = await importSigningKey(config.secret);
  const actualSignature = base64UrlDecode(encodedSignature);
  const expectedSignature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, textEncoder.encode(signingInput))
  );

  if (!timingSafeEqual(expectedSignature, actualSignature)) {
    throw new AuthError("Invalid token", 401);
  }

  const { sub, iss, aud, iat, exp, jti, nbf } = payload as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  const tolerance = config.clockToleranceSeconds ?? 30;

  if (typeof sub !== "string" || sub.trim().length === 0) throw new AuthError("Invalid token", 401);
  if (typeof iss !== "string" || iss !== config.issuer) throw new AuthError("Invalid token", 401);
  if (!normalizeAudience(aud).includes(config.audience)) throw new AuthError("Invalid token", 401);
  if (typeof iat !== "number" || !Number.isFinite(iat)) throw new AuthError("Invalid token", 401);
  if (typeof exp !== "number" || !Number.isFinite(exp)) throw new AuthError("Invalid token", 401);
  if (typeof jti !== "string" || jti.trim().length === 0) throw new AuthError("Invalid token", 401);
  if (exp <= now - tolerance) throw new AuthError("Token expired", 401);
  if (iat > now + tolerance) throw new AuthError("Invalid token", 401);
  if (nbf !== undefined && (typeof nbf !== "number" || nbf > now + tolerance)) {
    throw new AuthError("Invalid token", 401);
  }

  return {
    ...(payload as Record<string, unknown>),
    sub,
    iss,
    aud: aud as string | string[],
    iat,
    exp,
    jti,
    ...(payload as Record<string, unknown>).role !== undefined ? { role: String((payload as Record<string, unknown>).role) } : {},
    ...(payload as Record<string, unknown>).scope !== undefined ? { scope: (payload as Record<string, unknown>).scope as string | string[] } : {},
    ...(payload as Record<string, unknown>).token_version !== undefined ? { token_version: Number((payload as Record<string, unknown>).token_version) } : {},
    ...(payload as Record<string, unknown>).auth_epoch !== undefined ? { auth_epoch: Number((payload as Record<string, unknown>).auth_epoch) } : {},
    ...(nbf !== undefined ? { nbf } : {}),
  };
}

export async function authenticateAgent(
  supabase: SupabaseClient,
  bearerToken: string | null,
  config: JwtAuthConfig
): Promise<AgentIdentity> {
  if (!bearerToken) throw new AuthError("Missing credentials", 401);

  const claims = await verifyJwt(bearerToken, config);
  const { data, error } = await supabase
    .from("agent_clients")
    .select("client_id, role, disabled")
    .eq("client_id", claims.sub)
    .single();

  if (error || !data) throw new AuthError("Unknown agent", 401);
  if (data.disabled) throw new AuthError("Agent disabled", 401);

  return { client_id: data.client_id, role: data.role };
}

export async function resolveAgent(
  supabase: SupabaseClient,
  bearerToken: string | null,
  config: JwtAuthConfig
): Promise<AgentIdentity> {
  return await authenticateAgent(supabase, bearerToken, config);
}

export async function ensureProfile(
  supabase: SupabaseClient,
  clientId: string
): Promise<void> {
  await supabase
    .from("agent_profiles")
    .upsert({ client_id: clientId }, { onConflict: "client_id", ignoreDuplicates: true });
}
