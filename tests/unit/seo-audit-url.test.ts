import { describe, expect, it } from "vitest";
import {
  InvalidSeoAuditUrlError,
  isDisallowedAuditHost,
  normalizeSeoAuditUrl
} from "@/lib/seo-audit-url";

describe("normalizeSeoAuditUrl", () => {
  it("prepends https:// to a bare domain", () => {
    expect(normalizeSeoAuditUrl("example.com")).toBe("https://example.com/");
  });

  it("preserves an explicit https:// URL", () => {
    expect(normalizeSeoAuditUrl("https://example.com/path")).toBe("https://example.com/path");
  });

  it("preserves an explicit http:// URL", () => {
    expect(normalizeSeoAuditUrl("http://example.com/path")).toBe("http://example.com/path");
  });

  it("is case-insensitive when detecting an existing http(s) scheme", () => {
    expect(normalizeSeoAuditUrl("HTTPS://example.com")).toBe("https://example.com/");
  });

  it("trims leading and trailing whitespace before parsing", () => {
    expect(normalizeSeoAuditUrl("  example.com  ")).toBe("https://example.com/");
  });

  it("throws InvalidSeoAuditUrlError for an empty string", () => {
    expect(() => normalizeSeoAuditUrl("")).toThrow(InvalidSeoAuditUrlError);
  });

  it("throws InvalidSeoAuditUrlError for whitespace-only input", () => {
    expect(() => normalizeSeoAuditUrl("   ")).toThrow(InvalidSeoAuditUrlError);
  });

  it("throws InvalidSeoAuditUrlError for unparsable garbage", () => {
    expect(() => normalizeSeoAuditUrl("not a url at all :::")).toThrow(InvalidSeoAuditUrlError);
  });

  describe("non-http(s) schemes are rejected outright by SCHEME_PATTERN", () => {
    it("throws for a javascript: URL", () => {
      expect(() => normalizeSeoAuditUrl("javascript:alert(1)")).toThrow(InvalidSeoAuditUrlError);
    });

    it("throws for a data: URL", () => {
      expect(() => normalizeSeoAuditUrl("data:text/html,<script>alert(1)</script>")).toThrow(
        InvalidSeoAuditUrlError
      );
    });

    it("throws for a file: URL", () => {
      expect(() => normalizeSeoAuditUrl("file:///etc/passwd")).toThrow(InvalidSeoAuditUrlError);
    });

    it("throws for an ftp: URL", () => {
      expect(() => normalizeSeoAuditUrl("ftp://example.com/file")).toThrow(InvalidSeoAuditUrlError);
    });

    it("throws for a mailto: URL", () => {
      expect(() => normalizeSeoAuditUrl("mailto:someone@example.com")).toThrow(
        InvalidSeoAuditUrlError
      );
    });

    it("throws for a ws: URL", () => {
      expect(() => normalizeSeoAuditUrl("ws://example.com/socket")).toThrow(InvalidSeoAuditUrlError);
    });

    it("is case-insensitive when matching a rejected scheme", () => {
      expect(() => normalizeSeoAuditUrl("JavaScript:alert(1)")).toThrow(InvalidSeoAuditUrlError);
      expect(() => normalizeSeoAuditUrl("FILE:///etc/passwd")).toThrow(InvalidSeoAuditUrlError);
    });
  });

  it("does not mistake a bare host:port for a scheme (SCHEME_PATTERN's (?!\\d) guard)", () => {
    // "example.com:8080" contains one colon, immediately followed by a digit,
    // so SCHEME_PATTERN's negative lookahead must not treat "example.com" as
    // a scheme name. This should normalize as host:port, not throw.
    expect(normalizeSeoAuditUrl("example.com:8080")).toBe("https://example.com:8080/");
  });

  it("throws InvalidSeoAuditUrlError when the host is disallowed", () => {
    expect(() => normalizeSeoAuditUrl("http://localhost/")).toThrow(InvalidSeoAuditUrlError);
    expect(() => normalizeSeoAuditUrl("http://127.0.0.1/")).toThrow(InvalidSeoAuditUrlError);
    expect(() => normalizeSeoAuditUrl("169.254.169.254")).toThrow(InvalidSeoAuditUrlError);
  });

  it("allows an ordinary public host end-to-end", () => {
    expect(normalizeSeoAuditUrl("1.1.1.1")).toBe("https://1.1.1.1/");
  });

  it("throws for a trailing-dot localhost (FQDN root dot is stripped before matching)", () => {
    expect(() => normalizeSeoAuditUrl("http://localhost./")).toThrow(InvalidSeoAuditUrlError);
  });

  it("throws for an IPv4-mapped IPv6 loopback address", () => {
    // "[::ffff:127.0.0.1]" is unwrapped by parseIpv6Hextets to the embedded
    // v4 address 127.0.0.1, which is loopback.
    expect(() => normalizeSeoAuditUrl("http://[::ffff:127.0.0.1]/")).toThrow(
      InvalidSeoAuditUrlError
    );
  });

  describe("known gap: alternate IPv4 literal encodings", () => {
    // Per this module's own top-of-file comment, the WHATWG URL parser
    // itself canonicalizes octal, decimal, and hex IPv4 literals to
    // dotted-decimal form before isDisallowedAuditHost ever sees them, so
    // these are covered today - but as a property of `new URL()`, not of
    // this module's own range-checking logic.
    it("rejects octal-encoded loopback (0177.0.0.1 -> 127.0.0.1)", () => {
      expect(() => normalizeSeoAuditUrl("http://0177.0.0.1/")).toThrow(InvalidSeoAuditUrlError);
    });

    it("rejects decimal-encoded loopback (2130706433 -> 127.0.0.1)", () => {
      expect(() => normalizeSeoAuditUrl("http://2130706433/")).toThrow(InvalidSeoAuditUrlError);
    });

    it("rejects hex-encoded loopback (0x7f000001 -> 127.0.0.1)", () => {
      expect(() => normalizeSeoAuditUrl("http://0x7f000001/")).toThrow(InvalidSeoAuditUrlError);
    });
  });
});

describe("isDisallowedAuditHost", () => {
  describe("rejects loopback and private ranges", () => {
    it.each([
      ["localhost", "localhost"],
      ["127.0.0.1", "127.0.0.1 (loopback)"],
      ["127.0.0.2", "other 127.0.0.0/8 address"],
      ["127.255.255.255", "top of 127.0.0.0/8"],
      ["0.0.0.0", "unspecified address"],
      ["169.254.169.254", "cloud metadata endpoint (AWS/GCP/Azure IMDS)"],
      ["169.254.1.1", "other 169.254.0.0/16 address"],
      ["10.0.0.1", "10.0.0.0/8 private range"],
      ["10.255.255.255", "top of 10.0.0.0/8"],
      ["172.16.0.1", "bottom of 172.16.0.0/12"],
      ["172.20.5.5", "middle of 172.16.0.0/12"],
      ["172.31.255.255", "top of 172.16.0.0/12"],
      ["192.168.0.1", "192.168.0.0/16 private range"],
      ["192.168.255.255", "top of 192.168.0.0/16"],
      ["::", "IPv6 unspecified address"],
      ["::1", "IPv6 loopback"],
      ["fe80::1", "IPv6 link-local (fe80::/10)"],
      ["fc00::1", "IPv6 unique local address (fc00::/7)"],
      ["fd00::1", "IPv6 unique local address (fc00::/7, fd half)"]
    ])("rejects %s (%s)", (host) => {
      expect(isDisallowedAuditHost(host)).toBe(true);
    });

    it("rejects a subdomain of localhost", () => {
      expect(isDisallowedAuditHost("foo.localhost")).toBe(true);
    });

    it("is case-insensitive", () => {
      expect(isDisallowedAuditHost("LOCALHOST")).toBe(true);
      expect(isDisallowedAuditHost("LocalHost")).toBe(true);
      expect(isDisallowedAuditHost("FE80::1")).toBe(true);
    });

    it("strips IPv6 brackets before matching", () => {
      expect(isDisallowedAuditHost("[::1]")).toBe(true);
      expect(isDisallowedAuditHost("[fe80::1]")).toBe(true);
    });
  });

  describe("allows ordinary public hosts", () => {
    it.each([
      ["example.com"],
      ["www.example.com"],
      ["1.1.1.1"],
      ["8.8.8.8"]
    ])("allows %s", (host) => {
      expect(isDisallowedAuditHost(host)).toBe(false);
    });
  });

  describe("allows near-miss addresses that look private but are not", () => {
    it.each([
      ["172.15.255.255", "just below 172.16.0.0/12"],
      ["172.32.0.0", "just above 172.16.0.0/12"],
      ["11.0.0.1", "not 10.0.0.0/8"],
      ["9.255.255.255", "not 10.0.0.0/8"],
      ["192.169.0.1", "not 192.168.0.0/16"],
      ["192.167.255.255", "not 192.168.0.0/16"],
      ["169.253.255.255", "just below 169.254.0.0/16"],
      ["169.255.0.0", "just above 169.254.0.0/16"],
      ["1.0.0.0", "not 0.0.0.0/8 (a=0 only)"],
      ["126.0.0.1", "just below 127.0.0.0/8"],
      ["128.0.0.1", "just above 127.0.0.0/8"]
    ])("allows %s (%s)", (host) => {
      expect(isDisallowedAuditHost(host)).toBe(false);
    });
  });

  describe("fc/fd unique-local range check is gated behind actually parsing as IPv6", () => {
    // The old implementation was a bare `host.startsWith("fc"/"fd")` string
    // check, which misclassified any domain name starting with those letters
    // as an IPv6 ULA. The fix requires the value to first parse as an IPv6
    // literal (i.e. contain a colon) before the fc00::/7 range check ever
    // runs, so ordinary domains - including a real one, fdic.gov - are no
    // longer false positives.
    it.each([
      ["fdic.gov", "a real public domain, not an IPv6 ULA"],
      ["fcbarcelona.com", "a real public domain starting with fc"],
      ["fdx.com", "another public domain starting with fd"]
    ])("allows %s (%s)", (host) => {
      expect(isDisallowedAuditHost(host)).toBe(false);
    });
  });

  describe("fe80::/10 is a real range check, not a literal-prefix match", () => {
    it.each([
      ["fe80::1", "start of the range"],
      ["fe90::1", "still within fe80::/10"],
      ["fea0::1", "still within fe80::/10"],
      ["febf::1", "end of the range"]
    ])("rejects %s (%s)", (host) => {
      expect(isDisallowedAuditHost(host)).toBe(true);
    });

    it("allows an address just outside fe80::/10", () => {
      expect(isDisallowedAuditHost("fec0::1")).toBe(false);
    });
  });

  describe("FQDN root dot is stripped before matching", () => {
    it("rejects an IPv4 loopback literal with a trailing dot", () => {
      expect(isDisallowedAuditHost("127.0.0.1.")).toBe(true);
    });

    it("rejects 'localhost.' the same as 'localhost'", () => {
      expect(isDisallowedAuditHost("localhost.")).toBe(true);
    });

    it("rejects multiple trailing dots", () => {
      expect(isDisallowedAuditHost("localhost..")).toBe(true);
      expect(isDisallowedAuditHost("127.0.0.1..")).toBe(true);
    });
  });

  describe("IPv4-mapped IPv6 (::ffff:a.b.c.d) unwraps to the v4 rules", () => {
    it("rejects a loopback address written as a dotted-quad tail (::ffff:127.0.0.1)", () => {
      expect(isDisallowedAuditHost("::ffff:127.0.0.1")).toBe(true);
    });

    it("rejects the same loopback address written as an all-hex tail (::ffff:7f00:1)", () => {
      expect(isDisallowedAuditHost("::ffff:7f00:1")).toBe(true);
    });

    it("rejects a 10.0.0.0/8 address wrapped in ::ffff:", () => {
      expect(isDisallowedAuditHost("::ffff:10.0.0.1")).toBe(true);
    });

    it("rejects a 192.168.0.0/16 address wrapped in ::ffff:", () => {
      expect(isDisallowedAuditHost("::ffff:192.168.1.1")).toBe(true);
    });

    it("allows a public v4 address wrapped in ::ffff: (mirrors the near-miss cases above)", () => {
      expect(isDisallowedAuditHost("::ffff:8.8.8.8")).toBe(false);
    });
  });

  describe("malformed IPv6 literals fail to parse and fall through unrejected", () => {
    // parseIpv6Hextets returns null for anything that isn't a well-formed
    // IPv6 literal. Since none of these also match the IPv4 pattern, they
    // fall all the way through isDisallowedAuditHost to `return false`. In
    // practice `new URL()` would already reject a malformed bracketed IPv6
    // host before normalizeSeoAuditUrl ever calls isDisallowedAuditHost, but
    // the exported function is directly callable, so this documents its
    // standalone behavior.
    it("does not reject a literal with two '::' groups (ambiguous expansion)", () => {
      expect(isDisallowedAuditHost("2001::db8::1")).toBe(false);
    });

    it("does not reject a literal with more than 8 hextets", () => {
      expect(isDisallowedAuditHost("1:2:3:4:5:6:7:8:9")).toBe(false);
    });

    it("does not reject a literal with a non-hex group", () => {
      expect(isDisallowedAuditHost("1:2:zzzz:4:5:6:7:8")).toBe(false);
    });
  });

  describe("public IPv6 addresses are allowed", () => {
    it.each([
      ["2606:4700:4700::1111", "Cloudflare public DNS"],
      ["2001:4860:4860::8888", "Google public DNS"]
    ])("allows %s (%s)", (host) => {
      expect(isDisallowedAuditHost(host)).toBe(false);
    });
  });
});
