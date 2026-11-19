import {
  AUTH_HEADERS,
  InviteAcceptRequestSchema,
  MfaCodeRequestSchema,
  MfaEnrollConfirmResponseSchema,
  MfaEnrollStartResponseSchema,
  MfaRecoverRequestSchema,
  MfaStepResponseSchema,
  MfaTokenRequestSchema,
  OtpStartRequestSchema,
  OtpStartResponseSchema,
  OtpVerifyRequestSchema,
  OtpVerifyResponseSchema,
  PasswordForgotRequestSchema,
  PasswordResetRequestSchema,
  StaffLoginRequestSchema,
  TokenResponseSchema,
} from "@grooming/contracts";
import type { z } from "zod";
import { ApiError, toApiError } from "./errors";
import type { FetchLike } from "./fetch";
import type { TokenStore } from "./token-store";

export interface ApiClientOptions {
  /** API origin, e.g. http://localhost:3001. The client adds `/v1`. */
  baseUrl: string;
  fetch: FetchLike;
  tokenStore: TokenStore;
  transport: "cookie" | "body";
  onSessionExpired?: () => void;
  /**
   * Optional cross-context lock around each shared refresh (the refresh request
   * runs inside `fn`). Web passes `(fn) => navigator.locks.request("gr-refresh", fn)`
   * so two tabs never rotate the same refresh token at once.
   */
  refreshLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface RequestOptions<T> {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path after `/v1`, e.g. `/me`. */
  path: string;
  body?: unknown;
  /** `null` for 204 responses. */
  schema: z.ZodType<T> | null;
  /** Default true: send the bearer token and refresh on 401. */
  auth?: boolean;
}

type In<S extends z.ZodTypeAny> = z.input<S>;
type TokenResult = z.infer<typeof TokenResponseSchema>;

export interface AuthApi {
  otpStart(b: In<typeof OtpStartRequestSchema>): Promise<z.infer<typeof OtpStartResponseSchema>>;
  otpVerify(b: In<typeof OtpVerifyRequestSchema>): Promise<z.infer<typeof OtpVerifyResponseSchema>>;
  staffLogin(b: In<typeof StaffLoginRequestSchema>): Promise<z.infer<typeof MfaStepResponseSchema>>;
  mfaEnrollStart(b: In<typeof MfaTokenRequestSchema>): Promise<z.infer<typeof MfaEnrollStartResponseSchema>>;
  mfaEnrollConfirm(b: In<typeof MfaCodeRequestSchema>): Promise<z.infer<typeof MfaEnrollConfirmResponseSchema>>;
  mfaVerify(b: In<typeof MfaCodeRequestSchema>): Promise<TokenResult>;
  mfaRecover(b: In<typeof MfaRecoverRequestSchema>): Promise<z.infer<typeof MfaStepResponseSchema>>;
  inviteAccept(b: In<typeof InviteAcceptRequestSchema>): Promise<z.infer<typeof MfaStepResponseSchema>>;
  passwordForgot(b: In<typeof PasswordForgotRequestSchema>): Promise<void>;
  passwordReset(b: In<typeof PasswordResetRequestSchema>): Promise<void>;
  refresh(): Promise<TokenResult>;
  logout(): Promise<void>;
}

export interface ApiClient {
  request<T>(opts: RequestOptions<T>): Promise<T>;
  auth: AuthApi;
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const { baseUrl, tokenStore, transport } = opts;
  let refreshing: Promise<TokenResult> | null = null;

  async function send<T>(
    o: RequestOptions<T>,
    extraHeaders: Record<string, string> = {},
    sendBearer = true,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", ...extraHeaders };
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const access = sendBearer ? tokenStore.getAccessToken() : null;
    if (access) headers.authorization = `Bearer ${access}`;
    const res = await opts.fetch(`${baseUrl}/v1${o.path}`, {
      method: o.method,
      headers,
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
      ...(transport === "cookie" ? { credentials: "include" as const } : {}),
    });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw toApiError(res.status, text);
    if (o.schema === null) return undefined as T;
    return o.schema.parse(JSON.parse(text));
  }

  async function storeTokens(t: TokenResult): Promise<void> {
    tokenStore.setAccessToken(t.accessToken);
    if (transport === "body" && t.refreshToken) await tokenStore.setRefreshToken(t.refreshToken);
  }

  async function clearStore(): Promise<void> {
    tokenStore.setAccessToken(null);
    await tokenStore.setRefreshToken(null);
  }

  function refreshOnce(): Promise<TokenResult> {
    refreshing ??= (async () => {
      try {
        return await (opts.refreshLock ? opts.refreshLock(doRefresh) : doRefresh());
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  /** Waits for any in-flight refresh to settle (its outcome is ignored). */
  async function settleRefresh(): Promise<void> {
    while (refreshing) {
      try {
        await refreshing;
      } catch {
        // The refresh's own caller handles its error.
      }
    }
  }

  async function request<T>(o: RequestOptions<T>): Promise<T> {
    const authed = o.auth !== false;
    const sentToken = authed ? tokenStore.getAccessToken() : null;
    try {
      return await send(o, {}, authed);
    } catch (err) {
      if (!authed || !(err instanceof ApiError) || err.status !== 401) throw err;
      const current = tokenStore.getAccessToken();
      if (current !== sentToken) {
        // another call already refreshed while this one was in flight
        if (current === null) throw err;
        return send(o, {}, true);
      }
      try {
        await refreshOnce();
      } catch (refreshErr) {
        // Session ended (refresh answered 401/403): surface the original 401.
        // Any other refresh failure (network, 5xx, 429) is rethrown as is.
        if (refreshErr instanceof ApiError && (refreshErr.status === 401 || refreshErr.status === 403)) throw err;
        throw refreshErr;
      }
      return send(o, {}, true);
    }
  }

  async function doRefresh(): Promise<TokenResult> {
    try {
      const headers: Record<string, string> =
        transport === "body"
          ? { [AUTH_HEADERS.tokenTransport]: "body" }
          : { [AUTH_HEADERS.csrf]: "1" };
      const body =
        transport === "body" ? { refreshToken: (await tokenStore.getRefreshToken()) ?? undefined } : undefined;
      const t = await send(
        { method: "POST", path: "/auth/refresh", ...(body ? { body } : {}), schema: TokenResponseSchema, auth: false },
        headers,
        false,
      );
      await storeTokens(t);
      return t;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        await clearStore();
        opts.onSessionExpired?.();
      }
      throw err;
    }
  }

  const post = <T>(path: string, body: unknown, schema: z.ZodType<T> | null, issuing = false) =>
    send(
      { method: "POST", path, body, schema, auth: false },
      issuing && transport === "body" ? { [AUTH_HEADERS.tokenTransport]: "body" } : {},
      false,
    );

  const issue = async <T extends TokenResult>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> => {
    const t = await post(path, body, schema, true);
    await storeTokens(t);
    return t;
  };

  const auth: AuthApi = {
    otpStart: (b) => post("/auth/otp/start", b, OtpStartResponseSchema),
    otpVerify: (b) => issue("/auth/otp/verify", b, OtpVerifyResponseSchema),
    staffLogin: (b) => post("/auth/staff/login", b, MfaStepResponseSchema),
    mfaEnrollStart: (b) => post("/auth/staff/mfa/enroll", b, MfaEnrollStartResponseSchema),
    mfaEnrollConfirm: (b) => issue("/auth/staff/mfa/enroll/confirm", b, MfaEnrollConfirmResponseSchema),
    mfaVerify: (b) => issue("/auth/staff/mfa/verify", b, TokenResponseSchema),
    mfaRecover: (b) => post("/auth/staff/mfa/recover", b, MfaStepResponseSchema),
    inviteAccept: (b) => post("/auth/staff/invite/accept", b, MfaStepResponseSchema),
    passwordForgot: (b) => post("/auth/staff/password/forgot", b, null),
    passwordReset: (b) => post("/auth/staff/password/reset", b, null),
    refresh: () => refreshOnce(),
    async logout() {
      // A refresh still in flight would store fresh tokens after `clearStore`; let it finish
      // first (body transport then logs out the token it just received).
      await settleRefresh();
      try {
        const headers: Record<string, string> = transport === "cookie" ? { [AUTH_HEADERS.csrf]: "1" } : {};
        const body =
          transport === "body" ? { refreshToken: (await tokenStore.getRefreshToken()) ?? undefined } : undefined;
        await send({ method: "POST", path: "/auth/logout", ...(body ? { body } : {}), schema: null }, headers, true);
      } finally {
        await settleRefresh();
        await clearStore();
      }
    },
  };

  return { request, auth };
}
