import { afterEach, describe, expect, it, vi } from "vitest";
import { FEATURED_FEEDS } from "@/lib/featured-feed";

describe("GET /feeds/latest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("returns the newest two merged feed posts in descending published order", async () => {
    const responses = new Map(
      FEATURED_FEEDS.map((source, index) => {
        const day = String(index + 1).padStart(2, "0");
        return [
          source.url,
          `<?xml version="1.0" encoding="UTF-8"?>
            <rss version="2.0">
              <channel>
                <item>
                  <title>${source.name} post</title>
                  <link>https://example.com/${index + 1}</link>
                  <description><![CDATA[<p>Summary ${index + 1}</p>]]></description>
                  <pubDate>2024-03-${day}T09:00:00Z</pubDate>
                </item>
              </channel>
            </rss>`
        ];
      })
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const body = responses.get(url);
        if (!body) {
          return new Response("Not found", { status: 404 });
        }
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/xml"
          }
        });
      })
    );

    const { GET } = await import("@/app/feeds/latest/route");
    const response = await GET();
    const payload = (await response.json()) as { posts: Array<{ sourceName: string; publishedAt: string | null }> };

    expect(response.status).toBe(200);
    expect(payload.posts).toHaveLength(2);
    expect(payload.posts.map((post) => post.sourceName)).toEqual([
      FEATURED_FEEDS[FEATURED_FEEDS.length - 1].name,
      FEATURED_FEEDS[FEATURED_FEEDS.length - 2].name
    ]);
    expect(payload.posts[0]?.publishedAt).toBe("2024-03-09T09:00:00.000Z");
    expect(payload.posts[1]?.publishedAt).toBe("2024-03-08T09:00:00.000Z");
  });

  it("sets a Cache-Control that forces browser revalidation (no indefinite stale feed)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><item>` +
            `<title>Post</title><link>https://example.com/1</link>` +
            `<description><![CDATA[<p>Summary</p>]]></description>` +
            `<pubDate>2024-03-01T09:00:00Z</pubDate></item></channel></rss>`,
          { status: 200, headers: { "Content-Type": "application/xml" } }
        )
      )
    );

    const { GET } = await import("@/app/feeds/latest/route");
    const response = await GET();
    const cacheControl = response.headers.get("cache-control") ?? "";

    // Must NOT let browsers freeze the feed: no `force-cache`-friendly long max-age.
    expect(cacheControl).toContain("max-age=0");
    expect(cacheControl).toContain("s-maxage");
  });

  it("returns the last successful feed payload when a later refresh fully fails", async () => {
    const successResponses = new Map(
      FEATURED_FEEDS.map((source, index) => [
        source.url,
        `<?xml version="1.0" encoding="UTF-8"?>
          <rss version="2.0">
            <channel>
              <item>
                <title>${source.name} post</title>
                <link>https://example.com/${index + 1}</link>
                <description><![CDATA[<p>Summary ${index + 1}</p>]]></description>
                <pubDate>2024-04-${String(index + 1).padStart(2, "0")}T09:00:00Z</pubDate>
              </item>
            </channel>
          </rss>`
      ])
    );

    let callCount = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      callCount += 1;
      if (callCount <= FEATURED_FEEDS.length) {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const body = successResponses.get(url);
        return new Response(body ?? "Not found", {
          status: body ? 200 : 404,
          headers: {
            "Content-Type": "application/xml"
          }
        });
      }

      throw new Error("Network down");
    });

    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("@/app/feeds/latest/route");

    const firstResponse = await GET();
    const firstPayload = (await firstResponse.json()) as { posts: Array<{ title: string }> };

    const secondResponse = await GET();
    const secondPayload = (await secondResponse.json()) as { posts: Array<{ title: string }> };

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(secondPayload.posts).toEqual(firstPayload.posts);
  });
});
