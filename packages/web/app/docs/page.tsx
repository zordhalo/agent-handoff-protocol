import { readFile } from "node:fs/promises";
import path from "node:path";
import { marked } from "marked";

async function loadDesignDoc(): Promise<string> {
  const candidates = [
    path.join(process.cwd(), "docs", "DESIGN.md"),
    path.join(process.cwd(), "..", "..", "docs", "DESIGN.md"),
    path.join(process.cwd(), "..", "docs", "DESIGN.md"),
  ];
  for (const p of candidates) {
    try {
      return await readFile(p, "utf-8");
    } catch {
      // try next candidate
    }
  }
  return "# Design doc unavailable\n\nCouldn't locate `docs/DESIGN.md` from this deployment's working directory.";
}

export default async function DocsPage() {
  const raw = await loadDesignDoc();
  // Source is docs/DESIGN.md, a static file checked into this repo — not
  // user input — so rendering without a sanitizer is safe here.
  const html = await marked.parse(raw);

  return (
    <main>
      <section>
        <div className="wrap markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
      </section>
    </main>
  );
}
