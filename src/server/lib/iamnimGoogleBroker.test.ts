import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getIamnimGoogleBroker,
  iamnimGoogleAccessToken,
} from "./iamnimGoogleBroker";

describe("iamnim Google broker", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_MODE", "local_noauth");
    vi.stubEnv("IAMNIM_GOOGLE_BROKER_URL", "https://iamnim.test");
    vi.stubEnv("IAMNIM_ORG_SLUG", "club");
    vi.stubEnv("IAMNIM_PAT", "private-pat");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it("vends only the configured organization and explicit connection identity", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json({ access_token: "short", expires_in: 300 }),
      );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      iamnimGoogleAccessToken("local-admin", "iamnim:club", "google_analytics"),
    ).resolves.toBe("short");
    const [url, init] = fetcher.mock.calls[0];
    expect(url.toString()).toBe(
      "https://iamnim.test/api/organizations/club/vend/google/token?integration=google_analytics",
    );
    expect(init).toMatchObject({
      redirect: "error",
      cache: "no-store",
      headers: { Authorization: "Bearer private-pat" },
    });
    await expect(
      iamnimGoogleAccessToken("other", "iamnim:club", "google_analytics"),
    ).rejects.toThrow("identity");
    await expect(
      iamnimGoogleAccessToken(
        "local-admin",
        "iamnim:other",
        "google_analytics",
      ),
    ).rejects.toThrow("identity");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not reuse deployment credentials in hosted mode", async () => {
    vi.stubEnv("AUTH_MODE", "hosted");
    await expect(getIamnimGoogleBroker()).rejects.toThrow("single-user");
  });
  it("fails closed on missing authority, unsafe URL and refused grant", async () => {
    vi.stubEnv("IAMNIM_PAT", "");
    await expect(
      iamnimGoogleAccessToken(
        "local-admin",
        "iamnim:club",
        "google_search_console",
      ),
    ).rejects.toThrow("PAT");
    vi.stubEnv("IAMNIM_PAT", "private-pat");
    vi.stubEnv("IAMNIM_GOOGLE_BROKER_URL", "http://iamnim.test");
    await expect(getIamnimGoogleBroker()).rejects.toThrow("HTTPS");
    vi.stubEnv("IAMNIM_GOOGLE_BROKER_URL", "https://iamnim.test");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("private-upstream-secret", { status: 403 }),
        ),
    );
    await expect(
      iamnimGoogleAccessToken("local-admin", "iamnim:club", "google_analytics"),
    ).rejects.toThrow("HTTP 403");
    await expect(
      iamnimGoogleAccessToken("local-admin", "iamnim:club", "google_analytics"),
    ).rejects.not.toThrow("private-upstream-secret");
  });
  it("rejects expired and malformed broker tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ access_token: "short", expires_in: 0 }),
        ),
    );
    await expect(
      iamnimGoogleAccessToken("local-admin", "iamnim:club", "google_analytics"),
    ).rejects.toThrow("invalid short-lived");
  });
});
