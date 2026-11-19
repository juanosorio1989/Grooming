import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError } from "./errors";
import type { FetchLike } from "./fetch";
import { createApiClient } from "./client";
import { MemoryTokenStore, createCookieTokenStore } from "./token-store";

type Call = { url: string; init: Parameters<FetchLike>[1] };
type Reply = { status: number; body?: unknown; raw?: string };

function fake(script: Reply[] | ((c: Call) => Reply)) {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    const call = { url, init };
    calls.push(call);
    const r = typeof script === "function" ? script(call) : script[calls.length - 1]!;
    const text = r.raw ?? (r.body === undefined ? "" : JSON.stringify(r.body));
    return Promise.resolve({
      status: r.status,
      headers: { get: () => null },
      text: () => Promise.resolve(text),
    });
  };
  return { calls, fetch };
}

const tokens = (extra: object = {}) => ({
  accessToken: "acc2",
  accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
  ...extra,
});
const problem = (status: number, code: string) => ({
  status: status,
  body: { type: "about:blank", title: "t", status, code },
});
const Me = z.object({ id: z.string() });

describe("auth methods", () => {
  it("otpVerify in body transport sends transport header and stores tokens", async () => {
    const { calls, fetch } = fake([{ status: 200, body: tokens({ refreshToken: "ref2", isNew: true }) }]);
    const store = new MemoryTokenStore();
    const api = createApiClient({ baseUrl: "http://x", fetch, tokenStore: store, transport: "body" });
    await api.auth.otpVerify({ phone: "+521234567890", code: "123456" } as never);
    expect(calls[0]!.url).toBe("http://x/v1/auth/otp/verify");
    expect(calls[0]!.init.headers["x-token-transport"]).toBe("body");
    expect(store.getAccessToken()).toBe("acc2");
    await expect(store.getRefreshToken()).resolves.toBe("ref2");
  });

  it("cookie transport refresh uses include + csrf, no body, no transport header", async () => {
    const { calls, fetch } = fake([{ status: 200, body: tokens() }]);
    const store = createCookieTokenStore();
    const api = createApiClient({ baseUrl: "http://x", fetch, tokenStore: store, transport: "cookie" });
    await api.auth.refresh();
    const init = calls[0]!.init;
    expect(calls[0]!.url).toBe("http://x/v1/auth/refresh");
    expect(init.credentials).toBe("include");
    expect(init.headers["x-grooming-csrf"]).toBe("1");
    expect(init.headers["x-token-transport"]).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(store.getAccessToken()).toBe("acc2");
  });

  it("body transport refresh sends the refresh token in the body", async () => {
    const { calls, fetch } = fake([{ status: 200, body: tokens({ refreshToken: "r3" }) }]);
    const store = new MemoryTokenStore();
    await store.setRefreshToken("r1");
    const api = createApiClient({ baseUrl: "http://x", fetch, tokenStore: store, transport: "body" });
    await api.auth.refresh();
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ refreshToken: "r1" });
    expect(calls[0]!.init.headers["x-token-transport"]).toBe("body");
    await expect(store.getRefreshToken()).resolves.toBe("r3");
  });

  it("cookie logout sends csrf + include and no body", async () => {
    const { calls, fetch } = fake([{ status: 204 }]);
    const api = createApiClient({ baseUrl: "http://x", fetch, tokenStore: createCookieTokenStore(), transport: "cookie" });
    await api.auth.logout();
    const init = calls[0]!.init;
    expect(calls[0]!.url).toBe("http://x/v1/auth/logout");
    expect(init.headers["x-grooming-csrf"]).toBe("1");
    expect(init.credentials).toBe("include");
    expect(init.body).toBeUndefined();
  });

  it("body logout sends the refresh token", async () => {
    const { calls, fetch } = fake([{ status: 204 }]);
    const store = new MemoryTokenStore();
    await store.setRefreshToken("r1");
    const api = createApiClient({ baseUrl: "http://x", fetch, tokenStore: store, transport: "body" });
    await api.auth.logout();
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ refreshToken: "r1" });
  });

  it("logout clears the store even when the server returns 500", async () => {
    const { fetch } = fake([problem(500, "INTERNAL")]);
    const store = new MemoryTokenStore();
    store.setAccessToken("a");
    await store.setRefreshToken("r");
    const api = createApiClient({ baseUrl: "http://x", fetch, tokenStore: store, transport: "body" });
    await expect(api.auth.logout()).rejects.toBeInstanceOf(ApiError);
    expect(store.getAccessToken()).toBeNull();
    await expect(store.getRefreshToken()).resolves.toBeNull();
  });
});

describe("request", () => {
  it("refreshes once on 401 and retries with the new bearer", async () => {
    const { calls, fetch } = fake([
      problem(401, "UNAUTHENTICATED"),
      { status: 200, body: tokens() },
      { status: 200, body: { id: "u1" } },
    ]);
    const store = new MemoryTokenStore();
    store.setAccessToken("old");
    const api = createApiClient({ baseUrl: "http://x", fetch, tokenStore: store, transport: "cookie" });
    const out = await api.request({ method: "GET", path: "/me", schema: Me });
    expect(out).toEqual({ id: "u1" });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe("http://x/v1/me");
    expect(calls[0]!.init.headers.authorization).toBe("Bearer old");
    expect(calls[1]!.init.headers.authorization).toBeUndefined();
    expect(calls[2]!.init.headers.authorization).toBe("Bearer acc2");
  });

  it("single-flights concurrent refreshes", async () => {
    let refreshed = false;
    const { calls, fetch } = fake((c) => {
      if (c.url.endsWith("/auth/refresh")) {
        refreshed = true;
        return { status: 200, body: tokens() };
      }
      return c.init.headers.authorization === "Bearer acc2"
        ? { status: 200, body: { id: "u" } }
        : problem(401, "UNAUTHENTICATED");
    });
    const store = new MemoryTokenStore();
    store.setAccessToken("old");
    const api = createApiClient({ baseUrl: "http://x", fetch, tokenStore: store, transport: "cookie" });
    const r = await Promise.all([
      api.request({ method: "GET", path: "/me", schema: Me }),
      api.request({ method: "GET", path: "/me", schema: Me }),
    ]);
    expect(r).toEqual([{ id: "u" }, { id: "u" }]);
    expect(refreshed).toBe(true);
    expect(calls.filter((c) => c.url.endsWith("/auth/refresh"))).toHaveLength(1);
  });

  it("refresh failure expires the session once and rethrows the 401", async () => {
    const { fetch } = fake(() => problem(401, "UNAUTHENTICATED"));
    const store = new MemoryTokenStore();
    store.setAccessToken("old");
    await store.setRefreshToken("r");
    const onSessionExpired = vi.fn();
    const api = createApiClient({ baseUrl: "http://x", fetch, tokenStore: store, transport: "body", onSessionExpired });
    const reqs = [
      api.request({ method: "GET", path: "/me", schema: Me }),
      api.request({ method: "GET", path: "/me", schema: Me }),
    ];
    for (const p of reqs) await expect(p).rejects.toMatchObject({ status: 401 });
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(store.getAccessToken()).toBeNull();
    await expect(store.getRefreshToken()).resolves.toBeNull();
  });

  it("maps a 409 problem and a non-problem 502", async () => {
    const { fetch } = fake([problem(409, "SLOT_TAKEN"), { status: 502, raw: "<html>bad gateway</html>" }]);
    const api = createApiClient({ baseUrl: "http://x", fetch, tokenStore: new MemoryTokenStore(), transport: "cookie" });
    const e1 = await api.request({ method: "POST", path: "/x", body: {}, schema: null }).catch((e: unknown) => e);
    expect((e1 as ApiError).problem.code).toBe("SLOT_TAKEN");
    const e2 = await api.request({ method: "GET", path: "/x", schema: Me }).catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(ApiError);
    expect((e2 as ApiError).problem.code).toBe("INTERNAL");
  });

  it("rejects when a 200 body fails the schema", async () => {
    const { fetch } = fake([{ status: 200, body: { nope: 1 } }]);
    const api = createApiClient({ baseUrl: "http://x", fetch, tokenStore: new MemoryTokenStore(), transport: "cookie" });
    await expect(api.request({ method: "GET", path: "/me", schema: Me })).rejects.toBeInstanceOf(z.ZodError);
  });

  it("public auth.refresh() joins a refresh already in flight", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const urls: string[] = [];
    const reply = (status: number, body: unknown) => ({
      status,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify(body)),
    });
    const fetch: FetchLike = async (url, init) => {
      urls.push(url);
      if (url.endsWith("/auth/refresh")) {
        await gate;
        return reply(200, tokens());
      }
      return init.headers.authorization === "Bearer acc2"
        ? reply(200, { id: "u" })
        : reply(401, problem(401, "UNAUTHENTICATED").body);
    };
    const store = new MemoryTokenStore();
    store.setAccessToken("old");
    const api = createApiClient({ baseUrl: "http://x", fetch, tokenStore: store, transport: "cookie" });
    const me = api.request({ method: "GET", path: "/me", schema: Me });
    for (let i = 0; i < 100 && !urls.some((u) => u.endsWith("/auth/refresh")); i++) await Promise.resolve();
    expect(urls.some((u) => u.endsWith("/auth/refresh"))).toBe(true);
    const t = api.auth.refresh();
    release();
    await expect(me).resolves.toEqual({ id: "u" });
    await expect(t).resolves.toMatchObject({ accessToken: "acc2" });
    expect(urls.filter((u) => u.endsWith("/auth/refresh"))).toHaveLength(1);
  });

  it("a late 401 after a finished refresh retries without a second refresh", async () => {
    let releaseB: () => void = () => {};
    const gate = new Promise<void>((r) => (releaseB = r));
    const calls: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push(`${url} ${init.headers.authorization ?? "-"}`);
      const reply = (status: number, body: unknown) => ({
        status,
        headers: { get: () => null },
        text: () => Promise.resolve(JSON.stringify(body)),
      });
      if (url.endsWith("/auth/refresh")) return reply(200, tokens());
      if (init.headers.authorization === "Bearer acc2") return reply(200, { id: "u" });
      if (url.endsWith("/b")) await gate;
      return reply(401, problem(401, "UNAUTHENTICATED").body);
    };
    const store = new MemoryTokenStore();
    store.setAccessToken("old");
    const api = createApiClient({ baseUrl: "http://x", fetch, tokenStore: store, transport: "cookie" });
    const b = api.request({ method: "GET", path: "/b", schema: Me });
    await api.request({ method: "GET", path: "/a", schema: Me }); // 401 -> refresh -> retry
    releaseB();
    await expect(b).resolves.toEqual({ id: "u" });
    expect(calls.filter((c) => c.includes("/auth/refresh"))).toHaveLength(1);
    expect(calls[calls.length - 1]).toBe("http://x/v1/b Bearer acc2");
  });

  it("a 503 on refresh does not expire the session", async () => {
    const { fetch } = fake((c) => (c.url.endsWith("/auth/refresh") ? problem(503, "INTERNAL") : problem(401, "UNAUTHENTICATED")));
    const store = new MemoryTokenStore();
    store.setAccessToken("old");
    await store.setRefreshToken("r");
    const onSessionExpired = vi.fn();
    const api = createApiClient({ baseUrl: "http://x", fetch, tokenStore: store, transport: "body", onSessionExpired });
    await expect(api.request({ method: "GET", path: "/me", schema: Me })).rejects.toMatchObject({ status: 503 });
    expect(onSessionExpired).not.toHaveBeenCalled();
    await expect(store.getRefreshToken()).resolves.toBe("r");
    expect(store.getAccessToken()).toBe("old");
  });
});

describe("logout vs an in-flight refresh", () => {
  const reply = (status: number, body?: unknown) => ({
    status,
    headers: { get: () => null },
    text: () => Promise.resolve(body === undefined ? "" : JSON.stringify(body)),
  });
  const flush = async () => {
    for (let i = 0; i < 100; i++) await Promise.resolve();
  };

  function gatedRefresh(refreshReply: () => ReturnType<typeof reply>) {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const calls: { url: string; body?: string }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, body: init.body });
      if (url.endsWith("/auth/refresh")) {
        await gate;
        return refreshReply();
      }
      return reply(204);
    };
    return { fetch, calls, release };
  }

  it("waits for the refresh so its late tokens cannot repopulate the store, and logs out the new token", async () => {
    const { fetch, calls, release } = gatedRefresh(() => reply(200, tokens({ refreshToken: "r2" })));
    const store = new MemoryTokenStore();
    store.setAccessToken("old");
    await store.setRefreshToken("r1");
    const api = createApiClient({ baseUrl: "http://x", fetch, tokenStore: store, transport: "body" });
    const refreshed = api.auth.refresh();
    const loggedOut = api.auth.logout();
    await flush();
    release();
    await expect(refreshed).resolves.toMatchObject({ accessToken: "acc2" });
    await loggedOut;
    expect(store.getAccessToken()).toBeNull();
    await expect(store.getRefreshToken()).resolves.toBeNull();
    const logoutCall = calls.find((c) => c.url.endsWith("/auth/logout"))!;
    expect(JSON.parse(logoutCall.body!)).toEqual({ refreshToken: "r2" });
  });

  it("still logs out and clears the store when the in-flight refresh fails", async () => {
    const { fetch, calls, release } = gatedRefresh(() => reply(503, problem(503, "INTERNAL").body));
    const store = new MemoryTokenStore();
    store.setAccessToken("old");
    await store.setRefreshToken("r1");
    const api = createApiClient({ baseUrl: "http://x", fetch, tokenStore: store, transport: "body" });
    const refreshed = api.auth.refresh().catch((e: unknown) => e);
    const loggedOut = api.auth.logout();
    await flush();
    release();
    expect(await refreshed).toBeInstanceOf(ApiError);
    await loggedOut;
    expect(calls.some((c) => c.url.endsWith("/auth/logout"))).toBe(true);
    expect(store.getAccessToken()).toBeNull();
    await expect(store.getRefreshToken()).resolves.toBeNull();
  });
});

describe("refreshLock", () => {
  it("runs each shared refresh once inside the lock, wrapping the fetch", async () => {
    const events: string[] = [];
    const { fetch } = fake((c) => {
      events.push(`fetch ${c.url.replace("http://x/v1", "")}`);
      if (c.url.endsWith("/auth/refresh")) return { status: 200, body: tokens() };
      return c.init.headers.authorization === "Bearer acc2"
        ? { status: 200, body: { id: "u" } }
        : problem(401, "UNAUTHENTICATED");
    });
    let lockCalls = 0;
    const refreshLock = async <T,>(fn: () => Promise<T>): Promise<T> => {
      lockCalls++;
      events.push("lock");
      try {
        return await fn();
      } finally {
        events.push("unlock");
      }
    };
    const store = new MemoryTokenStore();
    store.setAccessToken("old");
    const api = createApiClient({ baseUrl: "http://x", fetch, tokenStore: store, transport: "cookie", refreshLock });
    await Promise.all([
      api.request({ method: "GET", path: "/me", schema: Me }),
      api.request({ method: "GET", path: "/me", schema: Me }),
    ]);
    expect(lockCalls).toBe(1);
    const i = events.indexOf("fetch /auth/refresh");
    expect(events.filter((e) => e === "fetch /auth/refresh")).toHaveLength(1);
    expect(events[i - 1]).toBe("lock");
    expect(events[i + 1]).toBe("unlock");

    await api.auth.refresh();
    expect(lockCalls).toBe(2);
  });

  it("a session-ending refresh inside the lock still clears the store and rejects", async () => {
    const { fetch } = fake(() => problem(401, "UNAUTHENTICATED"));
    let lockCalls = 0;
    const refreshLock = <T,>(fn: () => Promise<T>): Promise<T> => {
      lockCalls++;
      return fn();
    };
    const onSessionExpired = vi.fn();
    const store = new MemoryTokenStore();
    store.setAccessToken("old");
    const api = createApiClient({
      baseUrl: "http://x",
      fetch,
      tokenStore: store,
      transport: "cookie",
      refreshLock,
      onSessionExpired,
    });
    await expect(api.auth.refresh()).rejects.toMatchObject({ status: 401 });
    expect(lockCalls).toBe(1);
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(store.getAccessToken()).toBeNull();
  });
});
