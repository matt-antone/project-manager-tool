/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: true,
  /**
   * `@matt-antone/seo-audit`'s crawler.js imports BrowserPool from browser.js at
   * module scope, so `playwright` lands on the module graph for every consumer —
   * including the hosted-API path, which parses with linkedom and never launches
   * a browser. Bundling it fails: webpack cannot parse playwright-core's
   * `fsevents.node` binary and cannot resolve its optional `chromium-bidi` dep.
   *
   * Marking these external leaves them as runtime requires against node_modules
   * instead. Playwright is never actually invoked on this path (`runApiAudit`
   * passes `makeLiteParser()` with `render: false`), and no Chromium binary is
   * downloaded — Playwright 1.38+ dropped its install script.
   */
  serverExternalPackages: ["@matt-antone/seo-audit", "playwright", "playwright-core"]
};

export default nextConfig;
