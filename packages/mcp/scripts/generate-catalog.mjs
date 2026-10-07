import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path) => readFile(join(root, path), "utf8");
const docsRoot = "apps/docs/content/docs";
const documents = [];
async function collectDocs(directory) {
  for (const entry of (await readdir(join(root, directory), { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await collectDocs(path);
    else if (entry.name.endsWith(".mdx")) {
      const content = await read(path);
      const id = relative(docsRoot, path).replace(/\.mdx$/, "");
      documents.push({
        id,
        title: content.match(/^title: (.+)$/m)?.[1] ?? id,
        path,
        url: `https://docs.chatpack.dev/docs/${id === "index" ? "" : id}`,
        content,
      });
    }
  }
}
await collectDocs(docsRoot);
documents.unshift({
  id: "llms",
  title: "Authoritative integration reference",
  path: "llms.txt",
  url: "https://raw.githubusercontent.com/chddaniel/chatpack/main/llms.txt",
  content: await read("llms.txt"),
});
const uiRoot = "packages/ui/src";
const modules = [];
for (const name of (await readdir(join(root, uiRoot))).sort()) {
  if (/\.tsx?$/.test(name))
    modules.push({ path: `${uiRoot}/${name}`, content: await read(`${uiRoot}/${name}`) });
}
modules.push({ path: "packages/ui/styles.css", content: await read("packages/ui/styles.css") });
// Read public value exports with the TypeScript parser, including export *.
const blocks = [];
function collectExports(path) {
  const module = modules.find((item) => item.path === path);
  if (!module) throw new Error(`Missing UI module: ${path}`);
  const ast = ts.createSourceFile(path, module.content, ts.ScriptTarget.Latest, true);
  for (const statement of ast.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const stem = join(dirname(path), statement.moduleSpecifier.text);
      const target = modules.find(
        (item) => item.path === `${stem}.ts` || item.path === `${stem}.tsx`,
      );
      if (!target) throw new Error(`Missing export target: ${stem}`);
      if (!statement.exportClause) collectExports(target.path);
      else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (!element.isTypeOnly) blocks.push({ name: element.name.text, path: target.path });
        }
      }
    } else if (
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      if (
        (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
        statement.name
      )
        blocks.push({ name: statement.name.text, path });
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) blocks.push({ name: declaration.name.text, path });
        }
      }
    }
  }
}
collectExports(`${uiRoot}/index.ts`);
blocks.sort((a, b) => a.name.localeCompare(b.name));
const versions = {};
for (const entry of (await readdir(join(root, "packages"))).sort()) {
  const manifest = JSON.parse(await read(`packages/${entry}/package.json`));
  versions[manifest.name] = manifest.version;
}
const payload = { documents, blocks, modules, versions };
const snapshot = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
await writeFile(
  join(root, "packages/mcp/src/catalog.generated.json"),
  JSON.stringify({ snapshot, ...payload }),
);
const registryManifest = JSON.parse(await read("packages/mcp/server.json"));
registryManifest.version = versions["@chatpack/mcp"];
for (const entry of registryManifest.packages) {
  if (entry.identifier === "@chatpack/mcp") entry.version = versions["@chatpack/mcp"];
}
await writeFile(
  join(root, "packages/mcp/server.json"),
  JSON.stringify(registryManifest, null, 2) + "\n",
);
