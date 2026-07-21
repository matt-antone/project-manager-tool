import Link from "next/link";
import { TOOLS_REGISTRY } from "@/lib/tools-registry";

export default function ToolsPage() {
  return (
    <main className="toolsPage">
      <header className="toolsPageHeader">
        <h1 className="toolsPageTitle">Tools</h1>
        <p className="toolsPageSubtitle">A small kit of utilities. More to come.</p>
      </header>

      <section className="toolsGrid" aria-label="Available tools">
        {TOOLS_REGISTRY.map((tool) => (
          <Link key={tool.slug} href={tool.href} className="toolsCard toolsCardLink">
            <h2 className="toolsCardTitle">{tool.title}</h2>
            <p className="toolsCardHint">{tool.description}</p>
          </Link>
        ))}
      </section>
    </main>
  );
}
