import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const clearAuthSessionCookiesMock = vi.fn();

vi.mock("@/lib/server-auth", () => ({
  clearAuthSessionCookies: clearAuthSessionCookiesMock
}));

describe("/auth/logout route", () => {
  beforeEach(() => {
    clearAuthSessionCookiesMock.mockClear();
  });

  it("redirects + clears cookies on GET", async () => {
    const { GET } = await import("@/app/auth/logout/route");
    const response = await GET(new NextRequest("http://localhost/auth/logout"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/");
    expect(clearAuthSessionCookiesMock).toHaveBeenCalledTimes(1);
  });

  it("keeps POST logout behavior (redirect + cookie clear)", async () => {
    const { POST } = await import("@/app/auth/logout/route");
    const response = await POST(new NextRequest("http://localhost/auth/logout", { method: "POST" }));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/");
    expect(clearAuthSessionCookiesMock).toHaveBeenCalledTimes(1);
  });
});
