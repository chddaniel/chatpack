import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import ts from "typescript";

import { allDependencies, type PackageJson } from "../package-json";
import type { FileInfo, Framework, Language, PackageManager, ProjectInspection } from "../types";

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const ignoredDirectories = new Set(["node_modules", ".git", ".next", "dist", "coverage", ".turbo"]);

function readJson(path: string): PackageJson {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
  } catch {
    return {};
  }
}

function findUp(start: string, names: string[]): string | undefined {
  let current = resolve(start);
  for (;;) {
    for (const name of names) {
      const candidate = join(current, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = resolve(current, "..");
    if (parent === current) return undefined;
    current = parent;
  }
}

function collectFiles(root: string): FileInfo[] {
  const result: FileInfo[] = [];
  function visit(directory: string): void {
    let entries: Array<{ isDirectory(): boolean; name: string }>;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) visit(join(directory, entry.name));
        continue;
      }
      const path = join(directory, entry.name);
      if (!sourceExtensions.has(path.slice(path.lastIndexOf(".")))) continue;
      try {
        result.push({
          path,
          relativePath: relative(root, path),
          content: readFileSync(path, "utf8"),
        });
      } catch {
        // A file can disappear while a project is being inspected. Ignore it.
      }
    }
  }
  visit(root);
  return result;
}

function packageManager(
  root: string,
  packageJson: PackageJson,
): { manager?: PackageManager; evidence: string[] } {
  const evidence: string[] = [];
  const declared = packageJson.packageManager?.split("@")[0] as PackageManager | undefined;
  if (declared && ["npm", "pnpm", "yarn", "bun"].includes(declared)) {
    evidence.push(`package.json packageManager=${declared}`);
    return { manager: declared, evidence };
  }
  const lockfiles: Array<[string, PackageManager]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
  ];
  const found = lockfiles.filter(([file]) => existsSync(join(root, file)));
  evidence.push(...found.map(([file, manager]) => `${file}=${manager}`));
  const manager = found.length === 1 ? found[0]?.[1] : undefined;
  return manager ? { manager, evidence } : { evidence };
}

function language(root: string, files: FileInfo[]): Language {
  return existsSync(join(root, "tsconfig.json")) ||
    files.some((file) => /\.(ts|tsx)$/.test(file.path))
    ? "typescript"
    : "javascript";
}

function aliases(root: string): Record<string, string[]> {
  const configPath = ["tsconfig.json", "jsconfig.json"]
    .map((name) => join(root, name))
    .find(existsSync);
  if (!configPath) return {};
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      compilerOptions?: { paths?: Record<string, string[]> };
    };
    return config.compilerOptions?.paths ?? {};
  } catch {
    return {};
  }
}

function parseFramework(
  files: FileInfo[],
  dependencies: Record<string, string>,
): {
  framework?: Framework;
  evidence: string[];
} {
  const source = files.map((file) => file.content).join("\n");
  const candidates = [
    {
      framework: "next" as const,
      detected: Boolean(dependencies.next || /from ["']next\//.test(source)),
      evidence: "next dependency or import",
    },
    {
      framework: "hono" as const,
      detected: Boolean(
        dependencies.hono || /from ["']hono["']/.test(source) || /new Hono\s*\(/.test(source),
      ),
      evidence: "hono dependency or Hono application",
    },
    {
      framework: "express" as const,
      detected: Boolean(
        dependencies.express ||
        /from ["']express["']/.test(source) ||
        /express\s*\(\s*\)/.test(source),
      ),
      evidence: "express dependency or Express application",
    },
  ].filter((candidate) => candidate.detected);

  return {
    ...(candidates.length === 1 ? { framework: candidates[0]!.framework } : {}),
    evidence: candidates.map(
      (candidate) =>
        `${candidate.framework}: ${candidate.evidence}${candidates.length > 1 ? " (ambiguous)" : ""}`,
    ),
  };
}

function chatpackConfig(files: FileInfo[]): {
  path?: string;
  exportName: string;
  configs: string[];
} {
  const configs = files
    .filter((file) => /@chatpack\/core/.test(file.content) && /chatpack\s*\(/.test(file.content))
    .map((file) => file.path);
  const first = configs[0];
  if (!first) return { exportName: "chat", configs };
  const content = files.find((file) => file.path === first)?.content ?? "";
  const match = /export\s+(?:const|let|var)\s+(\w+)\s*=\s*(?:\([^)]*\)\s*=>\s*)?chatpack\s*\(/.exec(
    content,
  );
  return { path: first, exportName: match?.[1] ?? "chat", configs };
}

function databaseCandidates(
  files: FileInfo[],
  dependencies: Record<string, string>,
): Array<{ path: string; exportName: string }> {
  if (
    !dependencies["drizzle-orm"] &&
    !files.some((file) => /drizzle-orm|drizzle\s*\(/.test(file.content))
  )
    return [];
  return files
    .filter((file) => /drizzle-orm|export\s+(?:const|let|var)\s+db\b/.test(file.content))
    .flatMap((file) => {
      const matches = [
        ...file.content.matchAll(
          /export\s+(?:const|let|var)\s+(\w+)\s*=\s*(?:drizzle|createDb|db)/g,
        ),
      ];
      return matches.length > 0
        ? matches.map((match) => ({ path: file.path, exportName: match[1] ?? "db" }))
        : [{ path: file.path, exportName: "db" }];
    });
}

function authCandidates(files: FileInfo[], dependencies: Record<string, string>): string[] {
  const known = [
    "better-auth",
    "next-auth",
    "@auth/core",
    "@clerk/nextjs",
    "@supabase/supabase-js",
    "firebase",
  ];
  return files
    .filter(
      (file) =>
        known.some((name) => file.content.includes(name)) ||
        /(^|\/)(auth|session|user|security)[^/]*\.[cm]?[jt]sx?$/.test(file.relativePath),
    )
    .map((file) => file.path)
    .concat(known.filter((name) => dependencies[name]).map((name) => `dependency:${name}`));
}

function entrypoints(files: FileInfo[], framework: Framework | undefined): string[] {
  let marker: RegExp;
  switch (framework) {
    case "hono":
      marker = /new Hono\s*\(|\.all\s*\(/;
      break;
    case "express":
      marker = /express\s*\(\s*\)|app\.listen\s*\(/;
      break;
    case "next":
    case "web":
    case undefined:
      return [];
  }
  return files.filter((file) => marker.test(file.content)).map((file) => file.path);
}

function routes(files: FileInfo[], framework: Framework | undefined): string[] {
  if (framework === "next")
    return files
      .filter((file) =>
        /(?:^|src\/)app\/api\/chat\/\[\.\.\.chatpack\]\/route\.[cm]?[jt]sx?$/.test(
          file.relativePath,
        ),
      )
      .map((file) => file.path);
  return files
    .filter((file) => /api\/chat|chatpackHandler|chatpackExpress/.test(file.content))
    .map((file) => file.path);
}

export function inspectProject(cwd: string): ProjectInspection {
  const packageJsonPath = findUp(cwd, ["package.json"]);
  if (!packageJsonPath) throw new Error(`No package.json found from ${cwd}.`);
  const packageRoot = packageJsonPath.slice(0, -"package.json".length).replace(/[\\/]$/, "");
  const workspaceMarker = findUp(packageRoot, [
    "pnpm-workspace.yaml",
    "yarn.lock",
    "pnpm-lock.yaml",
    "package-lock.json",
    "bun.lock",
    "bun.lockb",
  ]);
  const workspaceRoot = workspaceMarker
    ? workspaceMarker.slice(0, -workspaceMarker.split(/[\\/]/).pop()!.length).replace(/[\\/]$/, "")
    : packageRoot;
  const packageJson = readJson(packageJsonPath);
  const files = collectFiles(packageRoot);
  const dependencies = allDependencies(packageJson);
  const manager = packageManager(workspaceRoot, packageJson);
  const parsedFramework = parseFramework(files, dependencies);
  const config = chatpackConfig(files);
  const sourceRoot = existsSync(join(packageRoot, "src")) ? join(packageRoot, "src") : packageRoot;
  const db = databaseCandidates(files, dependencies);
  return {
    cwd: resolve(cwd),
    packageRoot,
    workspaceRoot,
    packageJsonPath,
    packageJson,
    sourceRoot,
    language: language(packageRoot, files),
    ...(manager.manager ? { packageManager: manager.manager } : {}),
    packageManagerEvidence: manager.evidence,
    ...(parsedFramework.framework ? { framework: parsedFramework.framework } : {}),
    frameworkEvidence: parsedFramework.evidence,
    aliases: aliases(packageRoot),
    files,
    ...(config.path
      ? { chatpackConfig: { path: config.path, exportName: config.exportName } }
      : {}),
    chatpackConfigs: config.configs,
    chatpackRoutes: routes(files, parsedFramework.framework),
    databaseCandidates: db,
    authCandidates: authCandidates(files, dependencies),
    serverEntrypoints: entrypoints(files, parsedFramework.framework),
  };
}

export function parseSource(path: string, content: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx")
      ? ts.ScriptKind.TSX
      : path.endsWith(".jsx")
        ? ts.ScriptKind.JSX
        : path.endsWith(".js")
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS,
  );
}
