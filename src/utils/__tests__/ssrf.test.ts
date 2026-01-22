import { describe, expect, test } from "bun:test";

import {
  checkSsrfUrl,
  createSsrfPolicy,
  fetchWithSsrfProtection,
} from "../ssrf";

const policy = {
  maxRedirects: 3,
  allowlistEnabled: false,
  allowlistHosts: [],
};

describe("ssrf", () => {
  test("blocks loopback/private/link-local/metadata IPv4", async () => {
    await expect(
      checkSsrfUrl(new URL("http://127.0.0.1/"), policy),
    ).resolves.toEqual({ allowed: false, reason: "ip_blocked" });
    await expect(
      checkSsrfUrl(new URL("http://10.0.0.1/"), policy),
    ).resolves.toEqual({ allowed: false, reason: "ip_blocked" });
    await expect(
      checkSsrfUrl(new URL("http://169.254.169.254/"), policy),
    ).resolves.toEqual({ allowed: false, reason: "ip_blocked" });
    await expect(
      checkSsrfUrl(new URL("http://100.100.100.200/"), policy),
    ).resolves.toEqual({ allowed: false, reason: "ip_blocked" });
  });

  test("allows a public IPv4 literal", async () => {
    await expect(
      checkSsrfUrl(new URL("http://1.1.1.1/"), policy),
    ).resolves.toEqual({ allowed: true });
  });

  test("blocks redirect to loopback before issuing second request", async () => {
    const calls: string[] = [];
    const fetchFn = async (input: string): Promise<Response> => {
      calls.push(input);
      return new Response("redirect", {
        status: 302,
        headers: {
          location: "http://127.0.0.1/secret",
        },
      });
    };

    await expect(
      fetchWithSsrfProtection(new URL("http://1.1.1.1/a"), {}, policy, fetchFn),
    ).rejects.toThrow(/SSRF blocked/);
    expect(calls).toHaveLength(1);
  });

  test("parses allowlist hosts from urls and strips ports", () => {
    const policy = createSsrfPolicy({
      SSRF_MAX_REDIRECTS: 3,
      SSRF_ALLOWLIST_ENABLED: true,
      SSRF_ALLOWLIST_HOSTS:
        "https://example.com:8443/path,example.com:8080,*.Example.com,.example.com:443",
    });
    expect(policy.allowlistHosts).toEqual(["example.com", ".example.com"]);
  });
});
