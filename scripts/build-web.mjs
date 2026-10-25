// Construit la page autonome (un seul fichier HTML, sans dépendance réseau)
// -> app/index.html  (embarqué dans l'application Electron)
// -> docs/index.html (version web, publiable sur GitHub Pages)
import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const result = await build({
  entryPoints: [join(root, "web/app.js")],
  bundle: true,
  format: "iife",
  minify: true,
  target: "chrome110",
  write: false,
  legalComments: "none",
});

const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const template = await readFile(join(root, "web/index.html"), "utf8");
if (!template.includes("/*__BUNDLE__*/")) throw new Error("Marqueur /*__BUNDLE__*/ absent de web/index.html");
const html = template.replace("/*__BUNDLE__*/", () => js);

for (const dir of ["app", "docs"]) {
  await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, dir, "index.html"), html);
}
console.log(`Page construite (${(html.length / 1024).toFixed(0)} Ko) -> app/index.html, docs/index.html`);
