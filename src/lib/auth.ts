import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest, NextResponse } from "next/server";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { AuthAccessLevel, AuthRole, DashboardAuthState } from "@/types";

const COOKIE_NAME = "AzureCertGui.Auth";
const OIDC_STATE_COOKIE = "AzureCertGui.OidcState";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const MIN_IDLE_TIMEOUT_MINUTES = 15;
const MAX_IDLE_TIMEOUT_MINUTES = 1440;
const MIN_ABSOLUTE_SESSION_HOURS = 8;
const MAX_ABSOLUTE_SESSION_HOURS = 720;

export class AuthError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message: string
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface AuthOptions {
  mode: "local" | "oidc" | "hybrid";
  idleTimeoutMinutes: number;
  absoluteSessionHours: number;
  cookieSecret: string | null;
  oidc: {
    authority: string | null;
    clientId: string | null;
    clientSecret: string | null;
    callbackPath: string;
    rolesClaimType: string;
    displayNameClaimType: string;
    usernameClaimType: string;
    viewerGroups: string[];
    operatorGroups: string[];
    adminGroups: string[];
  };
}

interface AuthSession {
  sub: string;
  username: string;
  displayName: string | null;
  roles: AuthRole[];
  authSource: "local" | "oidc";
  issuedAt: string;
  expiresAt: string;
  absoluteExpiresAt: string;
}

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
}

interface OidcTokenResponse {
  id_token?: string;
  access_token?: string;
  error?: string;
  error_description?: string;
}

export function authOptionsFromEnv(env: Record<string, string | undefined> = process.env): AuthOptions {
  const mode = normalizeMode(readEnv(env, "MODE") ?? "local");
  return {
    mode,
    idleTimeoutMinutes: boundedInt(
      readEnv(env, "IDLETIMEOUTMINUTES"),
      480,
      MIN_IDLE_TIMEOUT_MINUTES,
      MAX_IDLE_TIMEOUT_MINUTES
    ),
    absoluteSessionHours: boundedInt(
      readEnv(env, "ABSOLUTESESSIONHOURS"),
      168,
      MIN_ABSOLUTE_SESSION_HOURS,
      MAX_ABSOLUTE_SESSION_HOURS
    ),
    cookieSecret: readEnv(env, "COOKIESECRET") ?? readEnv(env, "OIDC__CLIENTSECRET"),
    oidc: {
      authority: readEnv(env, "OIDC__AUTHORITY"),
      clientId: readEnv(env, "OIDC__CLIENTID"),
      clientSecret: readEnv(env, "OIDC__CLIENTSECRET"),
      callbackPath: readEnv(env, "OIDC__CALLBACKPATH") ?? "/api/auth/callback",
      rolesClaimType: readEnv(env, "OIDC__ROLESCLAIMTYPE") ?? "groups",
      displayNameClaimType: readEnv(env, "OIDC__DISPLAYNAMECLAIMTYPE") ?? "name",
      usernameClaimType: readEnv(env, "OIDC__USERNAMECLAIMTYPE") ?? "preferred_username",
      viewerGroups: readArrayEnv(env, "OIDC__VIEWERGROUPS"),
      operatorGroups: readArrayEnv(env, "OIDC__OPERATORGROUPS"),
      adminGroups: readArrayEnv(env, "OIDC__ADMINGROUPS")
    }
  };
}

export function validateAuthConfiguration(options = authOptionsFromEnv()): void {
  const oidcEnabled = isOidcEnabled(options);
  if ((options.mode === "oidc" || options.mode === "hybrid") && !oidcEnabled) {
    throw new Error("AZURE_CERT_GUI__AUTH__MODE=oidc or hybrid requires OIDC authority and client ID.");
  }
  if (oidcEnabled && !hasConfiguredRoleGroups(options)) {
    throw new Error(
      "AZURE_CERT_GUI__AUTH__OIDC must configure at least one ViewerGroups, OperatorGroups, or AdminGroups value when OIDC is enabled."
    );
  }
  if (oidcEnabled && !options.cookieSecret) {
    throw new Error(
      "OIDC mode requires AZURE_CERT_GUI__AUTH__COOKIESECRET or AZURE_CERT_GUI__AUTH__OIDC__CLIENTSECRET for session cookie signing."
    );
  }
}

export function resolveOidcRoles(claims: JWTPayload, options: AuthOptions): AuthRole[] {
  const groups = claimValues(claims[options.oidc.rolesClaimType]);
  const roles: AuthRole[] = [];
  if (matchesAny(groups, options.oidc.adminGroups)) roles.push("Admin");
  if (matchesAny(groups, options.oidc.operatorGroups)) roles.push("Operator");
  if (matchesAny(groups, options.oidc.viewerGroups)) roles.push("Viewer");
  return [...new Set(roles)];
}

export function resolveAccessLevel(roles: readonly string[]): AuthAccessLevel {
  const roleSet = new Set(roles.map((role) => role.toLowerCase()));
  if (roleSet.has("admin")) return "Admin";
  if (roleSet.has("operator")) return "Operator";
  if (roleSet.has("viewer")) return "Viewer";
  return "No Access";
}

export async function requirePageViewerAccess(): Promise<DashboardAuthState> {
  const context = await getCurrentAuthContext();
  if (canView(context)) return toDashboardAuthState(context);
  redirect("/api/auth/login");
}

export async function requireOperatorAccess(): Promise<void> {
  const context = await getCurrentAuthContext();
  const requestHeaders = await headers();
  if (!isSameOriginMutation(requestHeaders)) {
    throw new AuthError(403, "MutationOriginMismatch");
  }
  if (!canOperate(context)) {
    throw new AuthError(context ? 403 : 401, "OperatorAccessRequired");
  }
}

export async function requireOperatorAccessForRequest(request: NextRequest): Promise<void> {
  const context = await getCurrentAuthContextForRequest(request);
  if (!isSameOriginMutation(request.headers)) {
    throw new AuthError(403, "MutationOriginMismatch");
  }
  if (!canOperate(context)) {
    throw new AuthError(context ? 403 : 401, "OperatorAccessRequired");
  }
}

export async function requireViewerAccessForRequest(request: NextRequest): Promise<void> {
  const context = await getCurrentAuthContextForRequest(request);
  if (!canView(context)) {
    throw new AuthError(context ? 403 : 401, "ViewerAccessRequired");
  }
}

export async function getCurrentAuthContextForRequest(request: NextRequest): Promise<AuthSession | null> {
  const options = authOptionsFromEnv();
  validateAuthConfiguration(options);

  const sessionCookie = request.cookies.get(COOKIE_NAME)?.value;
  const session = sessionCookie ? parseSessionCookie(sessionCookie, options) : null;
  if (session && (canView(session) || canOperate(session))) return session;

  if ((options.mode === "local" || options.mode === "hybrid") && isLocalRequest(request.headers)) {
    return localSession(options);
  }

  return null;
}

export async function beginOidcSignIn(request: NextRequest): Promise<{ redirectUrl: string; stateCookie: string }> {
  const options = authOptionsFromEnv();
  validateAuthConfiguration(options);
  if (!isOidcEnabled(options)) {
    throw new AuthError(401, "OidcNotEnabled");
  }

  const discovery = await discoverOidc(options);
  const state = randomToken();
  const nonce = randomToken();
  const returnTo = sanitizeReturnTo(request.nextUrl.searchParams.get("returnTo"));
  const redirectUri = callbackUrl(request, options);
  const authUrl = new URL(discovery.authorization_endpoint);
  authUrl.searchParams.set("client_id", options.oidc.clientId ?? "");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "openid profile email");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("nonce", nonce);

  const stateCookie = signJson({ state, nonce, returnTo, createdAt: new Date().toISOString() }, sessionSecret(options));
  return { redirectUrl: authUrl.toString(), stateCookie };
}

export async function completeOidcSignIn(request: NextRequest): Promise<{ sessionCookie: string; returnTo: string }> {
  const options = authOptionsFromEnv();
  validateAuthConfiguration(options);
  if (!isOidcEnabled(options)) {
    throw new AuthError(401, "OidcNotEnabled");
  }

  const error = request.nextUrl.searchParams.get("error");
  if (error) {
    throw new AuthError(401, `OidcError:${error}`);
  }

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const stateCookie = request.cookies.get(OIDC_STATE_COOKIE)?.value;
  const expected = stateCookie ? parseSignedJson<{ state: string; nonce: string; returnTo: string }>(stateCookie, sessionSecret(options)) : null;
  if (!code || !state || !expected || expected.state !== state) {
    throw new AuthError(401, "OidcStateMismatch");
  }

  const discovery = await discoverOidc(options);
  const tokens = await exchangeCodeForTokens(discovery, options, code, callbackUrl(request, options));
  if (!tokens.id_token) {
    throw new AuthError(401, "OidcMissingIdToken");
  }

  const JWKS = createRemoteJWKSet(new URL(discovery.jwks_uri));
  const verified = await jwtVerify(tokens.id_token, JWKS, {
    issuer: discovery.issuer,
    audience: options.oidc.clientId ?? ""
  });
  if (verified.payload.nonce !== expected.nonce) {
    throw new AuthError(401, "OidcNonceMismatch");
  }

  const roles = resolveOidcRoles(verified.payload, options);
  if (!roles.length) {
    throw new AuthError(403, "OidcNoMappedRoles");
  }

  const now = new Date();
  const idleExpires = new Date(now.getTime() + options.idleTimeoutMinutes * 60_000);
  const absoluteExpires = new Date(now.getTime() + options.absoluteSessionHours * 60 * 60_000);
  const username =
    stringClaim(verified.payload[options.oidc.usernameClaimType]) ??
    stringClaim(verified.payload[options.oidc.displayNameClaimType]) ??
    verified.payload.sub ??
    "oidc-user";

  const session: AuthSession = {
    sub: verified.payload.sub ?? username,
    username,
    displayName: stringClaim(verified.payload[options.oidc.displayNameClaimType]),
    roles,
    authSource: "oidc",
    issuedAt: now.toISOString(),
    expiresAt: idleExpires.toISOString(),
    absoluteExpiresAt: absoluteExpires.toISOString()
  };

  return { sessionCookie: signJson(session, sessionSecret(options)), returnTo: expected.returnTo || "/" };
}

export function setAuthCookie(response: NextResponse, name: string, value: string, request: NextRequest, maxAgeSeconds: number): void {
  response.cookies.set(name, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(request.headers),
    path: "/",
    maxAge: maxAgeSeconds
  });
}

export function clearAuthCookies(response: NextResponse): void {
  response.cookies.set(COOKIE_NAME, "", { path: "/", maxAge: 0 });
  response.cookies.set(OIDC_STATE_COOKIE, "", { path: "/", maxAge: 0 });
}

export const authCookieName = COOKIE_NAME;
export const oidcStateCookieName = OIDC_STATE_COOKIE;

async function getCurrentAuthContext(): Promise<AuthSession | null> {
  const options = authOptionsFromEnv();
  validateAuthConfiguration(options);

  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(COOKIE_NAME)?.value;
  const session = sessionCookie ? parseSessionCookie(sessionCookie, options) : null;
  if (session && (canView(session) || canOperate(session))) return session;

  const requestHeaders = await headers();
  if ((options.mode === "local" || options.mode === "hybrid") && isLocalRequest(requestHeaders)) {
    return localSession(options);
  }

  return null;
}

function isOidcEnabled(options: AuthOptions): boolean {
  return Boolean((options.mode === "oidc" || options.mode === "hybrid") && options.oidc.authority && options.oidc.clientId);
}

function canView(session: AuthSession | null): session is AuthSession {
  if (!session) return false;
  return ["Viewer", "Operator", "Admin"].includes(resolveAccessLevel(session.roles));
}

function canOperate(session: AuthSession | null): session is AuthSession {
  if (!session) return false;
  return ["Operator", "Admin"].includes(resolveAccessLevel(session.roles));
}

function toDashboardAuthState(session: AuthSession): DashboardAuthState {
  return {
    mode: authOptionsFromEnv().mode,
    source: session.authSource,
    username: session.username,
    displayName: session.displayName,
    accessLevel: resolveAccessLevel(session.roles),
    canOperate: canOperate(session),
    signInPath: "/api/auth/login",
    signOutPath: "/api/auth/logout"
  };
}

function localSession(options: AuthOptions): AuthSession {
  const now = new Date();
  return {
    sub: "local-operator",
    username: "local-operator",
    displayName: "Local operator",
    roles: ["Admin", "Operator", "Viewer"],
    authSource: "local",
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + options.idleTimeoutMinutes * 60_000).toISOString(),
    absoluteExpiresAt: new Date(now.getTime() + options.absoluteSessionHours * 60 * 60_000).toISOString()
  };
}

function parseSessionCookie(cookie: string, options: AuthOptions): AuthSession | null {
  const session = parseSignedJson<AuthSession>(cookie, sessionSecret(options));
  if (!session) return null;
  const now = Date.now();
  if (Date.parse(session.expiresAt) <= now || Date.parse(session.absoluteExpiresAt) <= now) return null;
  return session;
}

function signJson(value: unknown, secret: string): string {
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function parseSignedJson<T>(cookie: string, secret: string): T | null {
  const [payload, signature] = cookie.split(".");
  if (!payload || !signature) return null;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const provided = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (provided.length !== expectedBuffer.length || !timingSafeEqual(provided, expectedBuffer)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function sessionSecret(options: AuthOptions): string {
  if (!options.cookieSecret) {
    throw new Error("Auth session cookie secret is not configured.");
  }
  return options.cookieSecret;
}

async function discoverOidc(options: AuthOptions): Promise<OidcDiscovery> {
  const authority = options.oidc.authority?.replace(/\/+$/, "");
  if (!authority) throw new AuthError(401, "OidcAuthorityMissing");
  const response = await fetch(`${authority}/.well-known/openid-configuration`, { cache: "force-cache" });
  if (!response.ok) throw new AuthError(401, `OidcDiscoveryFailed:${response.status}`);
  return (await response.json()) as OidcDiscovery;
}

async function exchangeCodeForTokens(
  discovery: OidcDiscovery,
  options: AuthOptions,
  code: string,
  redirectUri: string
): Promise<OidcTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: options.oidc.clientId ?? ""
  });
  if (options.oidc.clientSecret) {
    body.set("client_secret", options.oidc.clientSecret);
  }

  const response = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const tokens = (await response.json()) as OidcTokenResponse;
  if (!response.ok || tokens.error) {
    throw new AuthError(401, tokens.error_description ?? tokens.error ?? `OidcTokenExchangeFailed:${response.status}`);
  }
  return tokens;
}

function callbackUrl(request: NextRequest, options: AuthOptions): string {
  return new URL(options.oidc.callbackPath, request.nextUrl.origin).toString();
}

function sanitizeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function isSameOriginMutation(requestHeaders: Headers): boolean {
  const origin = requestHeaders.get("origin");
  if (!origin) return false;
  const host = requestHeaders.get("host") ?? "";
  const forwardedProto = requestHeaders.get("x-forwarded-proto");
  const protocol = forwardedProto ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  try {
    const originUrl = new URL(origin);
    return originUrl.host.toLowerCase() === host.toLowerCase() && originUrl.protocol.replace(":", "") === protocol;
  } catch {
    return false;
  }
}

function isLocalRequest(requestHeaders: Headers): boolean {
  const host = requestHeaders.get("host");
  const forwardedHost = requestHeaders.get("x-forwarded-host");
  if (forwardedHost && !isLocalHost(forwardedHost)) return false;
  return Boolean(host && isLocalHost(host));
}

function isLocalHost(value: string): boolean {
  const host = value.toLowerCase().replace(/:\d+$/, "");
  return LOCAL_HOSTS.has(host);
}

function isSecureRequest(requestHeaders: Headers): boolean {
  return requestHeaders.get("x-forwarded-proto") === "https" || requestHeaders.get("origin")?.startsWith("https://") === true;
}

function readEnv(env: Record<string, string | undefined>, name: string): string | null {
  return env[`AZURE_CERT_GUI__AUTH__${name}`]?.trim() || null;
}

function readArrayEnv(env: Record<string, string | undefined>, name: string): string[] {
  const direct = readEnv(env, name);
  const values = direct ? direct.split(",") : [];
  for (let index = 0; ; index += 1) {
    const value = readEnv(env, `${name}__${index}`);
    if (value === null) break;
    values.push(value);
  }
  return values.map((value) => value.trim()).filter(Boolean);
}

function normalizeMode(value: string): AuthOptions["mode"] {
  const normalized = value.trim().toLowerCase();
  if (normalized === "oidc" || normalized === "hybrid" || normalized === "local") return normalized;
  if (normalized === "local-break-glass") return "local";
  return "local";
}

function boundedInt(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function hasConfiguredRoleGroups(options: AuthOptions): boolean {
  return Boolean(options.oidc.viewerGroups.length || options.oidc.operatorGroups.length || options.oidc.adminGroups.length);
}

function claimValues(value: unknown): Set<string> {
  if (Array.isArray(value)) return new Set(value.map(String).filter(Boolean));
  if (typeof value === "string" && value.trim()) return new Set([value.trim()]);
  return new Set();
}

function stringClaim(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function matchesAny(groups: Set<string>, candidates: readonly string[]): boolean {
  const normalized = new Set([...groups].map((group) => group.toLowerCase()));
  return candidates.some((candidate) => normalized.has(candidate.toLowerCase()));
}
