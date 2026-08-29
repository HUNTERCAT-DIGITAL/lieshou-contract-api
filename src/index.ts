/**
 * @lieshoucloud/contract-api — 跨端共享 HTTP 客户端（L0 传输层 · Bottom-Up 优化）
 *
 * 统一能力（各端一次接入,消灭重复的 services/api.ts）：
 * - JWT 注入（token provider 注册一次）
 * - 401 单飞 refresh：并发 401 只发一次刷新,成功自动重试一次;失败触发 unauthorized 回调
 * - 后端标准化错误体 { error, message } → ApiError 透传
 * - multipart / blob 下载 / query 序列化
 * - 可选 devlog 钩子（admin-web 调试面板）
 *
 * 用法 A（模块级单例,兼容旧 API）：
 *   setBaseUrl(''); setAccessTokenProvider(() => store.accessToken);
 *   setRefreshTokensProvider(async () => { ...refresh...; return ok; });
 *   await request<LoginResp>({ method: 'POST', path: '/api/auth/login', body });
 *
 * 用法 B（实例工厂,web 端推荐）：
 *   export const api = createApiClient({ baseUrl: '', hooks: { getAccessToken, refreshTokens, onUnauthorized, onLog } });
 *   await api.get<T>('/api/users');
 *
 * @see BOTTOM_UP.md · L0-2
 */

import { t, type TranslationKey } from "@lieshoucloud/i18n";

export interface ApiRequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  /** 资源路径。/api 前缀由 normalizeApiPath 幂等归一（已带/不带均可，绝对 URL 原样透传） */
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** true 时返回 Blob（文件下载/预览,自动带 Authorization） */
  asBlob?: boolean;
  /** true 时 401 不走会话过期拦截（登录/注册/刷新等认证接口:401=凭据错误,直接抛原始错误体） */
  skipAuth401?: boolean;
  /** 超时毫秒数（缺省不超时）。超时后 AbortController 中止 fetch 并抛 ApiError('TIMEOUT') */
  timeoutMs?: number;
}

/**
 * path 幂等归一化（/api 前缀单一兜底点 · 2026-09 治本）。
 *
 * 背景：gateway/nginx 仅暴露 /api/**，但各端历史拼接约定不一：
 *  - path 已带 /api（mobile/desktop/客户包）→ 不动（幂等）
 *  - baseUrl 已含 /api 段（旧模式 baseUrl='/api'）→ path 纯资源不动；
 *    path 若也带 /api → 以 baseUrl 为准剥掉，避免 /api/api 双前缀（2026-09 修复）
 *  - path 无前缀（mini-program 等历史代码）→ 自动补 /api
 *  - path 不以 / 开头（相对路径误传）→ 补成 /api/<path>，避免 baseUrl+path 拼成坏 URL
 *  - 绝对 URL（健康检查直连等）→ 不动
 */
export function normalizeApiPath(path: string, baseUrl: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;
  const baseCarriesApi = baseUrl === "/api" || baseUrl.endsWith("/api");
  if (baseCarriesApi) {
    // 旧模式：/api 由 baseUrl 携带。path 带 /api 则剥掉（防双前缀），不带 / 则补上（防坏 URL）
    if (path === "/api") return "";
    if (path.startsWith("/api/")) return path.slice("/api".length);
    if (path && !path.startsWith("/")) return `/${path}`;
    return path;
  }
  if (path === "/api" || path.startsWith("/api/")) return path;
  if (path.startsWith("/")) return `/api${path}`;
  return path ? `/api/${path}` : path;
}

// ============================================================
// 错误类型（跨端共享）
// ============================================================

/** 后端标准化错误体（{ error, message }）透传 */
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** 鉴权类错误（401,refresh 失败等） */
export class AuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

export function isAuthError(e: unknown): e is AuthError {
  return e instanceof AuthError;
}

/** 任意异常 → 可读 message（兜底展示用 · 2026-09 S6 中文化）。
 *
 * 优先返回 message（后端 S5 起按 Accept-Language 本地化）；message 为空时按 code
 * 查共享 i18n 映射（error.common.*），命中返回中文文案，未命中返回 code 本身。 */
export function getErrorMessage(e: unknown): string {
  if (e instanceof ApiError || e instanceof AuthError) {
    if (e.message) return e.message;
    // HTTP_<status> 兜底码（readErrorBody 无响应体时）：转中文状态文案
    const httpMatch = /^HTTP_(\d+)$/.exec(e.code);
    if (httpMatch) return t("error.common.http_status", { 0: httpMatch[1] });
    const key = CODE_TO_I18N_KEY[e.code];
    return key ? t(key as TranslationKey) : e.code;
  }
  if (e instanceof Error && e.message) return e.message;
  return String(e);
}

/** 错误码 → i18n key（与 lieshou-i18n messages/error.common.* 对齐；无 message 兜底用） */
const CODE_TO_I18N_KEY: Record<string, string> = {
  BAD_REQUEST: "error.common.bad_request",
  VALIDATION_FAILED: "error.common.validation_failed",
  UNAUTHORIZED: "error.common.unauthorized",
  TENANT_CONTEXT_REQUIRED: "error.common.tenant_context_required",
  FORBIDDEN: "error.common.forbidden",
  NOT_FOUND: "error.common.not_found",
  CONFLICT: "error.common.conflict",
  BUSINESS_CONFLICT: "error.common.business_conflict",
  DATA_CONFLICT: "error.common.data_conflict",
  INTERNAL: "error.common.internal_error",
  INTERNAL_ERROR: "error.common.internal_error",
  SERVICE_UNAVAILABLE: "error.common.service_unavailable",
  TIMEOUT: "error.common.timeout",
  NETWORK_ERROR: "error.common.network",
};

// ============================================================
// 模块级配置（用法 A · 兼容旧 API）
// ============================================================

let tokenProvider: (() => string | null) | null = null;
let unauthorizedHandler: (() => void) | null = null;
// 模块级单飞闭包：setter 时创建一次并持久化，保证跨请求共享 in-flight（并发 401 只刷一次）
let moduleRefreshOnce: (() => Promise<boolean>) | undefined = undefined;
let logHandler: ((entry: ApiLogEntry) => void) | null = null;
let baseUrl = "";

/** 注册 token 供给器（应用启动时调一次） */
export function setAccessTokenProvider(fn: (() => string | null) | null): void {
  tokenProvider = fn;
}

/** 401 且 refresh 失败后的 UI 出口（提示 + logout + 跳登录） */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

/** 注册单飞 refresh：返回 true 表示刷新成功（401 时自动重试一次） */
export function setRefreshTokensProvider(fn: (() => Promise<boolean>) | null): void {
  moduleRefreshOnce = createRefreshOnce(fn);
}

/** 可选 devlog 钩子（admin-web 调试面板等） */
export function setLogHandler(fn: ((entry: ApiLogEntry) => void) | null): void {
  logHandler = fn;
}

export function setBaseUrl(url: string): void {
  baseUrl = url;
}

export function getBaseUrl(): string {
  return baseUrl;
}

// ============================================================
// 核心请求逻辑（模块级单例 与 实例工厂 共用）
// ============================================================

export interface ApiLogEntry {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  error?: string;
}

interface CoreConfig {
  baseUrl: string;
  getToken?: () => string | null;
  getHeaders?: () => Record<string, string>;
  onUnauthorized?: () => void;
  refreshTokens?: () => Promise<boolean>;
  onLog?: (entry: ApiLogEntry) => void;
}

/**
 * 单飞去重：并发调用共享同一 in-flight promise（模块级与实例级共用）。
 * 返回 undefined 表示未配置 refresh provider（调用方直接走失败路径）。
 */
function createRefreshOnce(
  provider?: (() => Promise<boolean>) | null,
): (() => Promise<boolean>) | undefined {
  if (!provider) return undefined;
  let inflight: Promise<boolean> | null = null;
  return () => {
    if (!inflight) {
      inflight = (async () => {
        try {
          return await provider();
        } finally {
          inflight = null;
        }
      })();
    }
    return inflight;
  };
}

/** 解析后端标准化错误体 { error?, message? } */
async function readErrorBody(res: Response): Promise<{ code: string; message: string }> {
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    return {
      code: body.error ?? `HTTP_${res.status}`,
      message: body.message ?? httpStatusText(res.status),
    };
  } catch {
    return { code: `HTTP_${res.status}`, message: httpStatusText(res.status) };
  }
}

/** HTTP 状态码兜底文案（中文化 · S6，替代英文 "HTTP 404 Not Found"） */
function httpStatusText(status: number): string {
  return t("error.common.http_status", { 0: String(status) });
}

/**
 * 核心请求。401 处理：
 * 1. 未重试过 → 单飞 refresh（并发 401 只发一次）→ 成功则重试一次
 * 2. 失败 → 触发 onUnauthorized（UI 登出跳转）并抛 AuthError
 */
async function coreRequest<T>(cfg: CoreConfig, opts: ApiRequestOptions, retried = false): Promise<T> {
  const startedAt = performance.now();
  const method = opts.method;

  // multipart（FormData）：浏览器自动带 boundary,不能手动设 Content-Type
  // ⚠️ 小程序端无 FormData 全局：instanceof 右侧标识符求值即 ReferenceError，必须 typeof 守卫
  const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  const headers: Record<string, string> = {
    ...(isForm ? {} : { "Content-Type": "application/json" }),
    ...(opts.headers ?? {}),
    ...(cfg.getHeaders?.() ?? {}),
  };
  const token = cfg.getToken?.();
  if (token) headers.Authorization = `Bearer ${token}`;

  const qs = opts.query
    ? "?" +
      Object.entries(opts.query)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&")
    : "";

  const url = `${cfg.baseUrl}${normalizeApiPath(opts.path, cfg.baseUrl)}${qs}`;
  const log = (status: number, error?: string) =>
    cfg.onLog?.({ method, path: opts.path, status, durationMs: Math.round(performance.now() - startedAt), error });

  const controller = opts.timeoutMs ? new AbortController() : undefined;
  const timer = opts.timeoutMs ? setTimeout(() => controller!.abort(), opts.timeoutMs) : undefined;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? (isForm ? (opts.body as FormData) : JSON.stringify(opts.body)) : undefined,
      signal: controller?.signal,
    });
  } catch (e) {
    // 超时 abort → 明确报 TIMEOUT；其余保留底层原因（WebView2/Chromium 的 net::ERR_xxx）
    if (controller?.signal.aborted) {
      log(0, `TIMEOUT ${opts.timeoutMs}ms`);
      throw new ApiError("TIMEOUT", `请求超时（${opts.timeoutMs}ms），请稍后重试`, 0);
    }
    const cause = e instanceof Error && e.cause ? `（${String(e.cause)}）` : "";
    log(0, `NETWORK_ERROR ${String(e)} ${cause}`);
    throw new ApiError("NETWORK_ERROR", `网络请求失败，请检查网络后重试（${String(e)}${cause}）`, 0);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (res.status === 401) {
    if (opts.skipAuth401) {
      // 认证类接口（登录/注册/刷新）：401 = 凭据错误,不走会话过期拦截
      const { code, message } = await readErrorBody(res);
      log(res.status, `${code} ${message}`);
      throw new AuthError(code, message, res.status);
    }
    if (!retried && cfg.refreshTokens) {
      // 单飞：并发 401 只发起一次刷新
      const ok = await cfg.refreshTokens();
      if (ok) return coreRequest<T>(cfg, opts, true);
    }
    cfg.onUnauthorized?.();
    log(401, "UNAUTHORIZED 登录已过期");
    throw new AuthError("UNAUTHORIZED", "登录已过期，请重新登录", 401);
  }

  if (!res.ok) {
    const { code, message } = await readErrorBody(res);
    log(res.status, `${code} ${message}`);
    throw new ApiError(code, message, res.status);
  }

  // 204 No Content（DELETE 等）：无响应体
  if (res.status === 204) {
    log(204);
    return undefined as T;
  }
  log(res.status);
  if (opts.asBlob) return (await res.blob()) as T;
  return (await res.json()) as T;
}

// ------------------------------------------------------------
// 用法 A：模块级单例（兼容旧 API）
// ------------------------------------------------------------

/** 模块级 request（旧 API：path 自动带 /api 前缀由调用方决定,配置走全局 setter） */
export async function request<T>(opts: ApiRequestOptions): Promise<T> {
  return coreRequest<T>(
    {
      baseUrl,
      getToken: tokenProvider ?? undefined,
      onUnauthorized: unauthorizedHandler ?? undefined,
      refreshTokens: moduleRefreshOnce,
      onLog: logHandler ?? undefined,
    },
    opts,
  );
}

// ------------------------------------------------------------
// 用法 B：实例工厂（web 端推荐 · 独立配置互不干扰）
// ------------------------------------------------------------

export interface ApiClientHooks {
  getAccessToken?: () => string | null;
  /** 全局请求头（如 Accept-Language 随语言切换）——每次请求动态求值 */
  getHeaders?: () => Record<string, string>;
  /** 返回 true=刷新成功,401 时自动重试一次 */
  refreshTokens?: () => Promise<boolean>;
  /** 401 且 refresh 失败：提示 + logout + 跳登录 */
  onUnauthorized?: () => void;
  /** 调试日志（可选） */
  onLog?: (entry: ApiLogEntry) => void;
}

export interface ApiClientOptions {
  baseUrl?: string;
  hooks?: ApiClientHooks;
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
  /** multipart 上传（CSV 导入等）：FormData 由浏览器带边界头 */
  postForm<T>(path: string, form: FormData): Promise<T>;
  /** blob 下载（文件内容流 · 自动带 Authorization） */
  getBlob(path: string): Promise<Blob>;
  /** 完整 options 直通（供 core-web ApiPort 桥接透传 skipAuth401 等扩展字段） */
  request<T>(opts: ApiRequestOptions): Promise<T>;
}

/** 创建 API 客户端实例（每个实例独立 baseUrl/hooks/单飞刷新） */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const cfg: CoreConfig = {
    baseUrl: options.baseUrl ?? "",
    getToken: options.hooks?.getAccessToken,
    getHeaders: options.hooks?.getHeaders,
    onUnauthorized: options.hooks?.onUnauthorized,
    refreshTokens: options.hooks?.refreshTokens,
    onLog: options.hooks?.onLog,
  };

  // 实例级单飞（与模块级共用 createRefreshOnce）
  const refreshOnce = createRefreshOnce(cfg.refreshTokens);
  const instanceCfg: CoreConfig = { ...cfg, refreshTokens: refreshOnce };
  const call = <T>(
    method: ApiRequestOptions["method"],
    path: string,
    body?: unknown,
    extra: Partial<ApiRequestOptions> = {},
  ) => coreRequest<T>(instanceCfg, { method, path, body, ...extra });

  return {
    get: <T>(path: string) => call<T>("GET", path),
    post: <T>(path: string, body?: unknown) => call<T>("POST", path, body),
    put: <T>(path: string, body?: unknown) => call<T>("PUT", path, body),
    patch: <T>(path: string, body?: unknown) => call<T>("PATCH", path, body),
    delete: <T>(path: string) => call<T>("DELETE", path),
    postForm: <T>(path: string, form: FormData) => call<T>("POST", path, form),
    getBlob: (path: string) => call<Blob>("GET", path, undefined, { asBlob: true }),
    /** 完整 options 直通（供 core-web ApiPort 桥接透传 skipAuth401 等扩展字段） */
    request: <T>(opts: ApiRequestOptions) => coreRequest<T>(instanceCfg, opts),
  };
}
