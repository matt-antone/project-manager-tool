import { FEATURED_FEEDS, parseFeedPosts, sortFeedPostsByPublishedDate } from "@/lib/featured-feed";
import { serverError } from "@/lib/http";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Browsers must always revalidate (max-age=0) so the feed can never freeze on a
// client's first-ever response (the Firefox stale-feed bug). The CDN may cache for
// 10 minutes and serve stale-while-revalidate for an hour to spare the function.
const FEED_CACHE_CONTROL = "public, max-age=0, s-maxage=600, stale-while-revalidate=3600";

let latestSuccessfulPosts: ReturnType<typeof sortFeedPostsByPublishedDate> = [];

function feedResponse(posts: ReturnType<typeof sortFeedPostsByPublishedDate>) {
  return NextResponse.json({ posts }, { headers: { "Cache-Control": FEED_CACHE_CONTROL } });
}

export async function GET() {
  const results = await Promise.all(
    FEATURED_FEEDS.map(async (source) => {
      try {
        const response = await fetch(source.url, {
          headers: {
            Accept: "application/rss+xml, application/xml, text/xml"
          },
          // Refresh the upstream RSS roughly in step with the CDN window so the
          // end-to-end feed stays within ~10 minutes of the source.
          next: { revalidate: 600 }
        });

        if (!response.ok) {
          throw new Error(`Feed request failed: ${response.status}`);
        }

        const xml = await response.text();
        return { posts: parseFeedPosts(xml, source, 5), error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown feed failure";
        return { posts: [], error: `${source.name}: ${message}` };
      }
    })
  );

  const pool = sortFeedPostsByPublishedDate(results.flatMap((result) => result.posts)).slice(0, 2);

  if (pool.length) {
    latestSuccessfulPosts = pool;
    return feedResponse(pool);
  }

  if (latestSuccessfulPosts.length) {
    return feedResponse(latestSuccessfulPosts);
  }

  const errors = results.flatMap((result) => (result.error ? [result.error] : []));
  console.error("featured_feed_latest_failed", errors);
  return serverError("Unable to load featured feed");
}
