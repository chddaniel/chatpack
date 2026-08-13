import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import { actionForFile } from "./modify";
import { prompt, select } from "./prompts";
import type {
  AuthProvider,
  CliArgs,
  Framework,
  PackageManager,
  PlanAction,
  ProjectInspection,
  SetupAnswers,
  SetupPlan,
} from "./types";

const authProviders = ["better-auth", "authjs", "auth0"] as const;
const starterFrameworks = ["next", "hono", "express"] as const;
const templateRoot = resolve(__dirname, "../templates");

function requirePackageName(value: string): string {
  if (
    value.length > 214 ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/.test(value)
  ) {
    throw new Error(`Invalid package name: ${value}`);
  }
  return value;
}

async function chooseStarterFramework(args: CliArgs): Promise<(typeof starterFrameworks)[number]> {
  if (args.framework === "web") {
    throw new Error("The web framework target is only available for existing projects.");
  }
  if (args.framework) return args.framework;
  if (args.yes)
    throw new Error("Starter framework is required. Supply --framework next, hono, or express.");
  return select("Starter framework", starterFrameworks, "next");
}

async function chooseStarterManager(args: CliArgs): Promise<PackageManager> {
  if (args.packageManager) return args.packageManager;
  if (args.yes) throw new Error("Package manager is required. Supply --package-manager.");
  return select("Package manager", ["npm", "pnpm", "yarn", "bun"] as const, "pnpm");
}

async function chooseStarterAuth(
  framework: Framework,
  args: CliArgs,
): Promise<AuthProvider | undefined> {
  if (framework !== "next") {
    if (args.authProvider) {
      throw new Error("--auth-provider is only available for Next.js starters.");
    }
    return undefined;
  }
  if (args.authProvider) return args.authProvider;
  if (args.yes) {
    throw new Error(
      "Next.js starter auth provider is required. Supply --auth-provider better-auth, authjs, or auth0.",
    );
  }
  return select("Authentication provider", authProviders, "better-auth");
}

async function chooseStarterName(inspection: ProjectInspection, args: CliArgs): Promise<string> {
  const fallback = basename(inspection.packageRoot)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");
  if (args.name) return requirePackageName(args.name);
  if (args.yes) return requirePackageName(fallback);
  return requirePackageName(await prompt("Package name", fallback));
}

function assertStarterFlags(args: CliArgs): void {
  const existingOnly = [
    [args.authPath, "--auth-path"],
    [args.authExport, "--auth-export"],
    [args.authIdProperty, "--auth-id-property"],
    [args.dbPath, "--db-path"],
    [args.dbExport, "--db-export"],
    [args.client, "--client"],
  ] as const;
  const invalid = existingOnly.filter(([value]) => Boolean(value)).map(([, flag]) => flag);
  if (invalid.length > 0) {
    throw new Error(
      `Existing-project option(s) cannot be used for a starter: ${invalid.join(", ")}.`,
    );
  }
  if (args.adapter === "memory") {
    throw new Error(
      "Starter projects require production Drizzle storage; memory storage is not supported.",
    );
  }
}

function filesInLayer(layer: string): Array<{ relativePath: string; content: string }> {
  const root = join(templateRoot, layer);
  if (!existsSync(root)) throw new Error(`Published starter template layer is missing: ${layer}`);
  const result: Array<{ relativePath: string; content: string }> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else result.push({ relativePath: relative(root, path), content: readFileSync(path, "utf8") });
    }
  };
  visit(root);
  return result;
}

function render(content: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (current, [name, value]) => current.replaceAll(`{{${name}}}`, value),
    content,
  );
}

function mergeGitignore(path: string, generated: string): PlanAction {
  if (!existsSync(path)) return actionForFile(path, generated, "Create starter ignore rules.");
  const current = readFileSync(path, "utf8");
  const currentLines = new Set(current.split(/\r?\n/));
  const additions = generated.split(/\r?\n/).filter((line) => line && !currentLines.has(line));
  if (additions.length === 0) {
    return { kind: "skip", path, reason: "Starter ignore rules are already present." };
  }
  const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  return actionForFile(
    path,
    `${current}${separator}${additions.join("\n")}\n`,
    "Add starter ignore rules while preserving existing rules.",
    "modify",
  );
}

export async function makeStarterPlan(
  inspection: ProjectInspection,
  args: CliArgs,
): Promise<SetupPlan> {
  assertStarterFlags(args);
  const framework = await chooseStarterFramework(args);
  const packageManager = await chooseStarterManager(args);
  const authProvider = await chooseStarterAuth(framework, args);
  const packageName = await chooseStarterName(inspection, args);
  const answers: SetupAnswers = {
    framework,
    adapter: "drizzle",
    packageManager,
    client: framework === "next",
    packageName,
    ...(authProvider ? { authProvider } : {}),
  };
  const errors = inspection.starterConflicts.map(
    (path) => `${path}: empty-repository starter mode does not allow this pre-existing entry.`,
  );
  const layers = ["base", framework, ...(authProvider ? [`auth/${authProvider}`] : [])];
  const files = new Map<string, string>();
  for (const layer of layers) {
    for (const file of filesInLayer(layer)) files.set(file.relativePath, file.content);
  }
  const values = {
    PACKAGE_NAME: packageName,
    AUTH_PROVIDER: authProvider ?? "host",
    FRAMEWORK: framework,
  };
  const actions: PlanAction[] = [];
  for (const [templatePath, source] of [...files.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    let relativePath = templatePath.replace(/\.template$/, "");
    if (relativePath === "README.md" && inspection.existingReadme)
      relativePath = "CHATPACK_SETUP.md";
    const target = join(inspection.packageRoot, relativePath);
    const content = render(source, values);
    actions.push(
      relativePath === ".gitignore"
        ? mergeGitignore(target, content)
        : actionForFile(target, content, `Create ${framework} starter file.`),
    );
  }
  actions.push({
    kind: "install",
    command: `${packageManager} install`,
    reason: "Install the pinned starter dependencies.",
  });
  const warnings = [
    "Copy .env.example to .env.local (Next.js) or .env (Hono/Express), add real secrets, then run the migration commands.",
    "Generation does not provision Neon, write secrets, run migrations, or deploy the application.",
  ];
  if (authProvider === "better-auth") {
    warnings.push(
      "Better Auth email verification is disabled by design in this starter. Enable verification before accepting untrusted public sign-ups.",
    );
  }
  return { inspection, answers, actions, warnings, errors };
}
