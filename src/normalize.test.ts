import { describe, expect, it } from "vitest";
import { normalizeApiPath } from "./index";

describe("normalizeApiPath（/api 前缀单一兜底点）", () => {
  it("已带 /api → 幂等不动", () => {
    expect(normalizeApiPath("/api/approvals", "")).toBe("/api/approvals");
    expect(normalizeApiPath("/api/approvals", "https://expo.example.cn")).toBe("/api/approvals");
    expect(normalizeApiPath("/api/iot/tickets", "")).toBe("/api/iot/tickets");
  });

  it("path 无前缀 → 自动补 /api", () => {
    expect(normalizeApiPath("/approvals", "")).toBe("/api/approvals");
    expect(normalizeApiPath("/customers", "https://dev.example.cn")).toBe("/api/customers");
    expect(normalizeApiPath("/auth/login", "")).toBe("/api/auth/login");
  });

  it("baseUrl 已含 /api 段（旧模式 baseUrl='/api'）→ path 纯资源不动", () => {
    expect(normalizeApiPath("/approvals", "/api")).toBe("/approvals");
    expect(normalizeApiPath("/approvals", "http://localhost:9000/api")).toBe("/approvals");
  });

  it("baseUrl 与 path 均含 /api → 剥离 path 前缀防双写（0.0.37 事故回归）", () => {
    // 客户仓注入 VITE_API_BASE=.../api + 调用方 path 带 /api：只能拼出一个 /api
    expect(
      normalizeApiPath("/api/auth/login", "https://legalmind.lieshoucloud.huntercat.cn/api"),
    ).toBe("/auth/login");
    expect(normalizeApiPath("/api/approvals", "http://localhost:9000/api")).toBe("/approvals");
    expect(normalizeApiPath("/api", "https://xxx/api")).toBe("");
    // path 非 /api 前缀（如 /api-extra）不受影响
    expect(normalizeApiPath("/api-extra/foo", "https://xxx/api")).toBe("/api-extra/foo");
  });

  it("baseUrl 含 /api 段 + path 也带 /api → 以 baseUrl 为准剥掉（防 /api/api 双前缀）", () => {
    expect(normalizeApiPath("/api/users", "http://localhost:9000/api")).toBe("/users");
    expect(normalizeApiPath("/api/users", "/api")).toBe("/users");
  });

  it("path 不以 / 开头（相对路径误传）→ 补成 /api/<path>（防 baseUrl+path 坏 URL）", () => {
    expect(normalizeApiPath("users", "https://gw.example.com")).toBe("/api/users");
    expect(normalizeApiPath("users", "https://gw.example.com/api")).toBe("/users");
  });

  it("baseUrl 含 /api 段 + path 不带 / → 补 /（旧模式相对路径）", () => {
    expect(normalizeApiPath("users", "/api")).toBe("/users");
  });

  it("绝对 URL → 不动（健康检查直连等）", () => {
    expect(normalizeApiPath("http://localhost:9000/actuator/health", "")).toBe(
      "http://localhost:9000/actuator/health",
    );
  });

  it("空 path → 不动", () => {
    expect(normalizeApiPath("", "")).toBe("");
  });
});
