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
import { chatpackVersions } from "./versions";

const templateRoot = resolve(__dirname, "../templates");

type StarterFramework = Exclude<Framework, "web">;

function requirePackageName(value: string): string {
  if (
    value.length > 214 ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/.test(value)
  ) {
    throw new Error(`Invalid package name: ${value}`);
  }
  return value;
}

async function chooseStarterFramework(args: CliArgs): Promise<StarterFramework> {
  if (args.framework === "web") {
    throw new Error("The web framework target is only available for existing projects.");
  }
  if (args.framework) return args.framework;
  if (args.yes)
    throw new Error("Starter framework is required. Supply --framework next, hono, or express.");
  return select(
    "Choose a starter",
    [
      { value: "next", label: "Next.js", hint: "Full chat app with UI and authentication" },
      { value: "hono", label: "Hono", hint: "Backend API starter" },
      { value: "express", label: "Express", hint: "Backend API starter" },
    ] as const,
    "next",
  );
}

async function chooseStarterManager(args: CliArgs): Promise<PackageManager> {
  if (args.packageManager) return args.packageManager;
  if (args.yes) throw new Error("Package manager is required. Supply --package-manager.");
  return select(
    "Choose a package manager",
    [
      { value: "pnpm", label: "pnpm", hint: "Recommended" },
      { value: "npm", label: "npm" },
      { value: "yarn", label: "Yarn" },
      { value: "bun", label: "Bun" },
    ] as const,
    "pnpm",
  );
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
  return select(
    "Choose an authentication provider",
    [
      { value: "better-auth", label: "Better Auth", hint: "Email and password" },
      { value: "authjs", label: "Auth.js", hint: "GitHub OAuth" },
      { value: "auth0", label: "Auth0", hint: "Universal Login" },
    ] as const,
    "better-auth",
  );
}

async function chooseStarterName(inspection: ProjectInspection, args: CliArgs): Promise<string> {
  const fallback = basename(inspection.packageRoot)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");
  if (args.name) return requirePackageName(args.name);
  if (args.yes) return requirePackageName(fallback);
  return requirePackageName(
    await prompt("Package name", fallback, (value) => {
      try {
        requirePackageName(value);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }),
  );
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

/**
 * The one part of the generated README that genuinely differs per starter.
 * Kept here rather than in three README variants so the shared setup steps stay
 * in one file.
 */
function starterNotes(framework: StarterFramework, authProvider: AuthProvider | undefined): string {
  if (framework !== "next") {
    return [
      "## Wire up your own authentication",
      "",
      "`src/lib/chatpack.ts` ships an auth hook that returns `null`, so **every request",
      "answers 401 until you replace it** with your host application's verified session.",
      "That is deliberate - a backend starter must not guess who the caller is.",
    ].join("\n");
  }
  const notes = [
    "## Authentication",
    "",
    `Sign-in is wired with ${authProvider ?? "your provider"}. \`src/lib/chatpack.server.ts\` passes the`,
    "signed-in user id to Chatpack and validates ids against the `profiles` table, so a",
    "conversation can never be opened with someone who does not exist.",
  ];
  if (authProvider === "better-auth") {
    notes.push(
      "",
      "Email verification is **disabled** so the starter runs immediately. Turn it on in",
      "`src/lib/auth.ts` before accepting untrusted public sign-ups.",
    );
  }
  notes.push(
    "",
    "## Deploy to Vercel",
    "",
    "Import the repository, add the same environment variables, and deploy. The Neon Pool",
    "is registered with the Vercel Functions lifecycle helper in `src/lib/db.ts`.",
  );
  return notes.join("\n");
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
  // pnpm needs its install-script approvals on disk or `pnpm install` exits
  // non-zero on a fresh clone. Nobody else reads the file, so an npm or Bun
  // project should not be handed a stray pnpm config.
  if (packageManager !== "pnpm") files.delete("pnpm-workspace.yaml");
  const envFile = framework === "next" ? ".env.local" : ".env";
  const values = {
    PACKAGE_NAME: packageName,
    AUTH_PROVIDER: authProvider ?? "host",
    FRAMEWORK: framework,
    PACKAGE_MANAGER: packageManager,
    ENV_FILE: envFile,
    STARTER_NOTES: starterNotes(framework, authProvider),
    ...chatpackVersions,
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
    `Copy .env.example to ${envFile}, add real secrets, then run ${packageManager} run db:generate and ${packageManager} run db:migrate.`,
    "Generation does not provision Neon, write secrets, run migrations, or deploy the application.",
  ];
  if (framework !== "next") {
    warnings.push(
      "src/lib/chatpack.ts returns null from its auth hook, so every request answers 401 until you wire it to your own session.",
    );
  }
  if (authProvider === "better-auth") {
    warnings.push(
      "Better Auth email verification is disabled by design in this starter. Enable verification before accepting untrusted public sign-ups.",
    );
  }
  return { inspection, answers, actions, warnings, errors };
}
