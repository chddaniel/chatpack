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
 * `pnpm-workspace.yaml` is pnpm's file; the starter only seeds the build
 * approvals a fresh clone needs. pnpm then edits it during `install` - pnpm 11
 * appends a `minimumReleaseAgeExclude` entry for every recent version it
 * accepted - so a rerun of `init` must not read those additions as a hand-edited
 * file it is about to clobber. If our keys are already there, there is nothing
 * left to do.
 */
function mergePnpmWorkspace(path: string, generated: string): PlanAction {
  const reason = "Pre-approve the install scripts the starter needs.";
  if (!existsSync(path)) return actionForFile(path, generated, reason);
  const current = readFileSync(path, "utf8");
  if (current === generated) {
    return { kind: "skip", path, reason: `${reason} (already current)` };
  }
  // Both spellings, because pnpm 10 reads one and pnpm 11 the other.
  const missing = ["onlyBuiltDependencies:", "allowBuilds:"].filter(
    (key) => !current.includes(key),
  );
  if (missing.length === 0) {
    return { kind: "skip", path, reason: "pnpm build approvals are already present." };
  }
  const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  return actionForFile(
    path,
    `${current}${separator}${generated}`,
    "Add the starter's pnpm build approvals while preserving existing settings.",
    "modify",
  );
}

/**
 * Where every Chatpack feature lives in the generated app. The starter wires all
 * of them up, so the README has to say where to look - a reader who cannot find
 * the moderation queue assumes it was left out.
 */
function featureTour(framework: StarterFramework): string[] {
  if (framework !== "next") {
    return [
      "## What is wired up",
      "",
      "`src/lib/chatpack.ts` mounts the whole Chatpack HTTP surface on one catch-all",
      "route: directs, groups and public channels, messages with reactions,",
      "quote-replies, edits, soft deletes, mentions and forwarding, invite links and",
      "join requests, search, read receipts, the moderation routes, file attachments,",
      "and the `/stream` SSE endpoint. There is no second handler to add later.",
      "",
      "It is also the only file that decides anything: permissions, who counts as a",
      "moderator, the message-length cap, the file plugin and the transport all live",
      "there. Read it before you read anything else.",
    ];
  }
  return [
    "## What is wired up",
    "",
    "Every Chatpack feature is in this app, not just the ones a demo needs:",
    "",
    "| Page | Features |",
    "| ---- | -------- |",
    "| `/` | directs, groups and channels; reactions, quote-replies, edit, delete, forward, report; mentions, attachments, typing signals, presence dots, unread counts, members and roles, invites, the join queue, mute, search |",
    "| `/channels` | the public channel directory, with open joins and approval requests |",
    "| `/invite/[code]` | invite-link preview and accept |",
    "| `/moderation` | the report queue, bans, and the people you have blocked |",
    "",
    "`src/lib/chatpack.server.ts` is the only file that decides anything: permissions,",
    "who counts as a moderator, the message-length cap, the file plugin and the",
    "transport all live there, and one handler on a catch-all route serves every route",
    "above plus `/stream`. Read the server file first.",
    "",
    "The UI is application-owned React. Nothing under `src/components` is a Chatpack",
    "API - delete whatever your product does not need.",
  ];
}

/**
 * The features that stay off until an environment variable turns them on. A
 * fresh clone has to run with no extra services, so the starter defaults to
 * local disk and in-memory fan-out - and says so, rather than failing in
 * production once there are two servers.
 */
function optionalFeatureNotes(framework: StarterFramework): string[] {
  const moderationSurface = framework === "next" ? "`/moderation`" : "the moderation routes";
  return [
    "## Optional features",
    "",
    "Three things stay off until you set an environment variable (all of them are",
    "listed, commented out, in `.env.example`):",
    "",
    "- **Moderation queue** - `MODERATOR_EMAILS` or `MODERATOR_USER_IDS`. With both",
    `  empty nobody is a moderator, so ${moderationSurface} answers with a refusal.`,
    "  Reporting and blocking need no configuration; reviewing reports and banning do.",
    "- **File attachments** - uploads go to `.chatpack-files` on local disk. Set",
    "  `S3_BUCKET` and the other `S3_*` values to store them in any S3-compatible",
    "  bucket (AWS, R2, B2, MinIO) instead. Do that before you deploy: a serverless",
    "  filesystem is not shared between invocations and does not outlive one.",
    "- **Multi-node realtime** - `REDIS_URL`. A single process fans events out in",
    "  memory. Two or more need Redis, or a message sent on server A never reaches a",
    "  listener on server B. Presence needs one more step: this starter uses the",
    "  per-process default, so pass `presence({ store: redisPresenceStore({ client })",
    "  })` to report users connected to another node as online",
    "  (`docs/decisions/0025`).",
  ];
}

/**
 * The one part of the generated README that genuinely differs per starter.
 * Kept here rather than in three README variants so the shared setup steps stay
 * in one file.
 */
function starterNotes(framework: StarterFramework, authProvider: AuthProvider | undefined): string {
  const notes = [...featureTour(framework), ""];
  if (framework !== "next") {
    notes.push(
      "## Wire up your own authentication",
      "",
      "`src/lib/chatpack.ts` ships an auth hook that returns `null`, so **every request",
      "answers 401 until you replace it** with your host application's verified session.",
      "That is deliberate - a backend starter must not guess who the caller is.",
    );
  } else {
    notes.push(
      "## Authentication",
      "",
      `Sign-in is wired with ${authProvider ?? "your provider"}. \`src/lib/chatpack.server.ts\` passes the`,
      "signed-in user id to Chatpack and validates ids against the `profiles` table, so a",
      "conversation can never be opened with someone who does not exist.",
    );
    if (authProvider === "better-auth") {
      notes.push(
        "",
        "Email verification is **disabled** so the starter runs immediately. Turn it on in",
        "`src/lib/auth.ts` before accepting untrusted public sign-ups.",
      );
    }
  }
  notes.push("", ...optionalFeatureNotes(framework));
  if (framework === "next") {
    notes.push(
      "",
      "## Deploy to Vercel",
      "",
      "Import the repository, add the same environment variables, and deploy. The Neon Pool",
      "is registered with the Vercel Functions lifecycle helper in `src/lib/db.ts`.",
    );
  }
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
    if (relativePath === ".gitignore") actions.push(mergeGitignore(target, content));
    else if (relativePath === "pnpm-workspace.yaml")
      actions.push(mergePnpmWorkspace(target, content));
    else actions.push(actionForFile(target, content, `Create ${framework} starter file.`));
  }
  actions.push({
    kind: "install",
    command: `${packageManager} install`,
    reason: "Install the pinned starter dependencies.",
  });
  const warnings = [
    `Copy .env.example to ${envFile}, add real secrets, then run ${packageManager} run db:generate and ${packageManager} run db:migrate.`,
    "Generation does not provision Neon, write secrets, run migrations, or deploy the application.",
    // The three optional features, called out here because each one is silently
    // fine in development and wrong in production if it is left alone.
    "File attachments are stored on local disk (.chatpack-files) until you set S3_BUCKET. Set it before deploying to serverless - that filesystem does not outlive a single invocation.",
    "Nobody is a moderator until you set MODERATOR_EMAILS or MODERATOR_USER_IDS. Reporting and blocking work without it; reviewing reports and banning do not.",
    "Realtime fan-out is in-memory. Set REDIS_URL before running more than one server process, or a message sent on one will not reach listeners on another.",
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
