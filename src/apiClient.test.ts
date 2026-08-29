import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  AuthError,
  createApiClient,
  getErrorMessage,
  request,
  setAccessTokenProvider,
  setBaseUrl,
  setLogHandler,
  setRefreshTokensProvider,
  setUnauthorizedHandler,
} from "./index";

const JSON_401 = () => new Response("{}", { status: 401, statusText: "Unauthorized" });
const json200 = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, statusText: "OK" });

function netError(cause: string): Error {
  return Object.assign(new Error("fetch failed"), { cause });
}

// ============================================================
// 实例工厂（用法 B · createApiClient）
// ============================================================

describe("createApiClient（coreRequest 核心路径）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("成功请求：拼 URL、注入 Authorization、返回 JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json200({ list: [1, 2] }));
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient({
      baseUrl: "https://gw.example.com",
      hooks: { getAccessToken: () => "token-1" },
    });

    await expect(api.get<{ list: number[] }>("/users")).resolves.toEqual({ list: [1, 2] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://gw.example.com/api/users");
    expect(init.headers.Authorization).toBe("Bearer token-1");
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("错误体解析：后端 { error, message } → ApiError 透传 code/message/status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: "INTERNAL", message: "boom" }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient({ baseUrl: "https://gw.example.com" });
    const err = (await api.get("/x").catch((e: unknown) => e)) as ApiError;

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: "INTERNAL", message: "boom", status: 500 });
  });

  it("错误体非 JSON（网关 HTML 502）→ 兜底 HTTP_<status>", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("<html>Bad Gateway</html>", { status: 502, statusText: "Bad Gateway" }));
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient({ baseUrl: "https://gw.example.com" });
    const err = (await api.get("/x").catch((e: unknown) => e)) as ApiError;

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: "HTTP_502" });
    expect(String(err.message)).toContain("502");
  });

  it("网络错误：包装为 NETWORK_ERROR 并保留底层 cause（net::ERR_xxx）", async () => {
    const fetchMock = vi.fn().mockRejectedValue(netError("net::ERR_CONNECTION_REFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient({ baseUrl: "https://gw.example.com" });
    const err = (await api.get("/x").catch((e: unknown) => e)) as ApiError;

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: "NETWORK_ERROR", status: 0 });
    expect(String(err.message)).toContain("net::ERR_CONNECTION_REFUSED");
  });

  it("401 单飞：并发 401 只触发一次 refresh，成功后各自重试并返回数据", async () => {
    const refreshTokens = vi.fn().mockResolvedValue(true);
    const onUnauthorized = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(JSON_401())
      .mockResolvedValueOnce(JSON_401())
      .mockResolvedValueOnce(json200({ id: 1 }))
      .mockResolvedValueOnce(json200({ id: 2 }));
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient({
      baseUrl: "https://gw.example.com",
      hooks: { getAccessToken: () => "token-1", refreshTokens, onUnauthorized },
    });

    const [a, b] = await Promise.all([
      api.get<{ id: number }>("/users/1"),
      api.get<{ id: number }>("/users/2"),
    ]);

    expect(refreshTokens).toHaveBeenCalledTimes(1); // 单飞：只刷一次
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(4); // 401, 401, 重试 200, 重试 200
    expect([a.id, b.id].sort()).toEqual([1, 2]);
  });

  it("401 + refresh 失败 → 触发 onUnauthorized 并抛 AuthError，不重试", async () => {
    const refreshTokens = vi.fn().mockResolvedValue(false);
    const onUnauthorized = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(JSON_401());
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient({
      baseUrl: "https://gw.example.com",
      hooks: { getAccessToken: () => "token-1", refreshTokens, onUnauthorized },
    });

    const err = (await api.get("/x").catch((e: unknown) => e)) as ApiError;

    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(AuthError);
    expect(err).toMatchObject({ code: "UNAUTHORIZED", status: 401, message: "登录已过期，请重新登录" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // 刷新失败不再重试
  });

  it("401 且无 refresh provider → 直接抛 AuthError", async () => {
    const onUnauthorized = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(JSON_401());
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient({
      baseUrl: "https://gw.example.com",
      hooks: { onUnauthorized },
    });

    const err = (await api.get("/x").catch((e: unknown) => e)) as ApiError;

    expect(err).toBeInstanceOf(AuthError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("skipAuth401：认证接口 401 = 凭据错误，不走会话过期拦截（不 refresh、不 onUnauthorized）", async () => {
    const refreshTokens = vi.fn();
    const onUnauthorized = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "BAD_CREDENTIALS", message: "用户名或密码错误" }), { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient({
      baseUrl: "https://gw.example.com",
      hooks: { getAccessToken: () => "token-1", refreshTokens, onUnauthorized },
    });

    const err = (await api
      .request({ method: "POST", path: "/auth/login", body: { username: "x" }, skipAuth401: true })
      .catch((e: unknown) => e)) as ApiError;

    expect(err).toBeInstanceOf(AuthError);
    expect(err).toMatchObject({ code: "BAD_CREDENTIALS", status: 401, message: "用户名或密码错误" });
    expect(refreshTokens).not.toHaveBeenCalled();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("204 No Content → 返回 undefined", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient({ baseUrl: "https://gw.example.com" });
    await expect(api.delete("/users/1")).resolves.toBeUndefined();
  });

  it("asBlob：返回 Blob 且自动带 Authorization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("a,b\n1,2", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient({
      baseUrl: "https://gw.example.com",
      hooks: { getAccessToken: () => "token-1" },
    });

    const blob = await api.getBlob("/export.csv");
    expect(blob).toBeInstanceOf(Blob);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://gw.example.com/api/export.csv");
    expect(init.headers.Authorization).toBe("Bearer token-1");
  });

  it("query 序列化：过滤 undefined、encodeURIComponent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json200({}));
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient({ baseUrl: "https://gw.example.com" });
    await api.request({ method: "GET", path: "/users", query: { page: 1, size: 20, tag: undefined, q: "a b&c" } });

    expect(fetchMock.mock.calls[0][0]).toBe("https://gw.example.com/api/users?page=1&size=20&q=a%20b%26c");
  });

  it("multipart：FormData 不手动设 Content-Type（浏览器带 boundary）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json200({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient({ baseUrl: "https://gw.example.com" });
    const form = new FormData();
    form.append("file", new Blob(["a,b"], { type: "text/csv" }), "data.csv");

    await api.postForm("/import", form);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["Content-Type"]).toBeUndefined();
    expect(init.body).toBe(form);
  });

  it("timeoutMs：超时中止请求并抛 ApiError('TIMEOUT')", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })),
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient({ baseUrl: "https://gw.example.com" });
    const err = (await api
      .request({ method: "GET", path: "/slow", timeoutMs: 30 })
      .catch((e: unknown) => e)) as ApiError;

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: "TIMEOUT", status: 0 });
    expect(String(err.message)).toContain("30");
  });

  it("onLog：记录方法/路径/状态/耗时", async () => {
    const onLog = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(json200({}));
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient({ baseUrl: "https://gw.example.com", hooks: { onLog } });
    await api.get("/users");

    expect(onLog).toHaveBeenCalledTimes(1);
    const entry = onLog.mock.calls[0][0];
    expect(entry).toMatchObject({ method: "GET", path: "/users", status: 200 });
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================
// 工具函数
// ============================================================

describe("getErrorMessage", () => {
  it("ApiError/AuthError 优先返回 message（后端 S5 起已本地化），不再拼英文 code 前缀", () => {
    expect(getErrorMessage(new ApiError("INTERNAL", "boom", 500))).toBe("boom");
    expect(getErrorMessage(new AuthError("UNAUTHORIZED", "登录已过期", 401))).toBe("登录已过期");
  });

  it("message 为空时按 code 查共享 i18n 映射（error.common.*）", () => {
    expect(getErrorMessage(new ApiError("BAD_REQUEST", "", 400))).toBe("请求参数错误");
    expect(getErrorMessage(new ApiError("NOT_FOUND", "", 404))).toBe("资源不存在");
    expect(getErrorMessage(new ApiError("HTTP_502", "", 502))).toBe("请求失败（HTTP 502）");
  });

  it("未映射 code 返回 code 本身", () => {
    expect(getErrorMessage(new ApiError("INVALID_DEVICE_CREDENTIALS", "", 401))).toBe("INVALID_DEVICE_CREDENTIALS");
  });

  it("普通 Error 返回 message，非 Error 兜底 String()", () => {
    expect(getErrorMessage(new Error("plain"))).toBe("plain");
    expect(getErrorMessage(42)).toBe("42");
  });
});


describe("request（模块级单例）", () => {
  beforeEach(() => {
    setBaseUrl("https://gw.example.com");
    setAccessTokenProvider(() => "token-m");
    setRefreshTokensProvider(null);
    setUnauthorizedHandler(null);
    setLogHandler(null);
  });

  afterEach(() => {
    setBaseUrl("");
    setAccessTokenProvider(null);
    setRefreshTokensProvider(null);
    setUnauthorizedHandler(null);
    setLogHandler(null);
    vi.unstubAllGlobals();
  });

  it("401 单飞同样生效：模块级并发请求只刷新一次", async () => {
    const refresh = vi.fn().mockResolvedValue(true);
    setRefreshTokensProvider(refresh);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(JSON_401())
      .mockResolvedValueOnce(JSON_401())
      .mockResolvedValueOnce(json200({ id: 1 }))
      .mockResolvedValueOnce(json200({ id: 2 }));
    vi.stubGlobal("fetch", fetchMock);

    const [a, b] = await Promise.all([
      request<{ id: number }>({ method: "GET", path: "/users/1" }),
      request<{ id: number }>({ method: "GET", path: "/users/2" }),
    ]);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect([a.id, b.id].sort()).toEqual([1, 2]);
  });

  it("模块级 request 注入模块级 token 与 /api 归一", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json200({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await request({ method: "GET", path: "/users" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://gw.example.com/api/users");
    expect(init.headers.Authorization).toBe("Bearer token-m");
  });
});
