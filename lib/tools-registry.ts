import type { Route } from "next";

export type ToolDescriptor = {
  slug: string;
  title: string;
  description: string;
  href: Route;
};

export const TOOLS_REGISTRY: ToolDescriptor[] = [
  {
    slug: "qr-code",
    title: "QR Code Generator",
    description: "Type or paste any text or URL to get a downloadable QR code.",
    href: "/tools/qr-code",
  },
  {
    slug: "seo-audit",
    title: "SEO Audit",
    description: "Audit a URL for SEO and AI-readiness issues.",
    href: "/tools/seo-audit",
  },
];
