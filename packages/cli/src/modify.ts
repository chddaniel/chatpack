import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname, relative } from "node:path";

import { parseSource } from "./project/inspect";
import type { Framework, PlanAction } from "./types";

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.chatpack-${process.pid}.tmp`;
  writeFileSync(temporary, content, "utf8");
  try {
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* Best effort cleanup. */
    }
    throw error;
  }
}

export function actionForFile(
  path: string,
  content: string,
  reason: string,
  kind: "create" | "modify" = "create",
): PlanAction {
  if (!existsSync(path)) return { kind, path, content, reason };
  const current = readFileSync(path, "utf8");
  if (current === content) return { kind: "skip", path, reason: `${reason} (already current)` };
  return { kind, path, content, reason, conflict: "File exists with different content." };
}

function importStatement(entrypoint: string, integration: string, name: string): string {
  const normalized = relative(dirname(entrypoint), integration).replaceAll("\\", "/");
  const hasRuntimeExtension = /\.(?:c?js|mjs|jsx)$/.test(normalized);
  const extensionless = hasRuntimeExtension
    ? normalized
    : normalized.replace(/\.[cm]?[jt]sx?$/, "");
  const path = hasRuntimeExtension ? normalized : `${extensionless}.js`;
  return `import { ${name} } from "${path.startsWith(".") ? path : `./${path}`}";`;
}

export function mountAction(
  entrypoint: string,
  integration: string,
  framework: Framework,
): PlanAction {
  const source = readFileSync(entrypoint, "utf8");
  const isHono = framework === "hono";
  const importName = isHono ? "chatpackHandler" : "chatpackExpress";
  const alreadyMounted = isHono
    ? /chatpackHandler|\/api\/chat\/\*/.test(source)
    : /chatpackExpress|\/api\/chat/.test(source);
  if (alreadyMounted)
    return { kind: "modify", path: entrypoint, reason: "Chatpack mount already appears present." };
  const application = isHono
    ? /(?:const|let|var)\s+(\w+)\s*=\s*new\s+Hono\s*\(/g
    : /(?:const|let|var)\s+(\w+)\s*=\s*express\s*\(\s*\)/g;
  const matches = [...source.matchAll(application)];
  if (matches.length !== 1) {
    return {
      kind: "modify",
      path: entrypoint,
      reason: `Could not safely identify one ${framework} application.`,
      conflict: "Ambiguous application entrypoint.",
    };
  }
  const appName = matches[0]?.[1] ?? "app";
  const importLine = importStatement(entrypoint, integration, importName);
  const mount = isHono
    ? `\n${appName}.all("/api/chat/*", (c) => ${importName}.fetch(c.req.raw));\n`
    : `\n${appName}.use("/api/chat", ${importName});\n`;
  const shebangEnd = source.startsWith("#!") ? source.indexOf("\n") + 1 : 0;
  const updated = `${source.slice(0, shebangEnd)}${importLine}\n${source.slice(shebangEnd)}${mount}`;
  parseSource(entrypoint, updated);
  return {
    kind: "modify",
    path: entrypoint,
    content: updated,
    reason: `Mount Chatpack in detected ${framework} entrypoint.`,
  };
}

export function applyFileAction(action: PlanAction): void {
  if (!action.path || action.content === undefined || action.conflict) return;
  atomicWrite(action.path, action.content);
}
