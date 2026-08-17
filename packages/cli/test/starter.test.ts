import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { parseArgs } from "../src/args";
import { applyFileAction } from "../src/modify";
import { makePlan } from "../src/plan";
import { inspectProject } from "../src/project/inspect";
import type { AuthProvider, CliArgs, Framework, PackageManager } from "../src/types";
import { validateApplied, validatePlan } from "../src/validate";

const roots: string[] = [];

async function emptyRepo(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chatpack-starter-"));
  roots.push(root);
  await mkdir(join(root, ".git"));
  for (const [path, value] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), value);
  }
  return root;
}

function args(
  cwd: string,
  framework: Framework,
  manager: PackageManager = "pnpm",
  provider?: AuthProvider,
): CliArgs {
  return {
    command: "init",
    cwd,
    framework,
    adapter: "drizzle",
    packageManager: manager,
    ...(provider ? { authProvider: provider } : {}),
    client: false,
    yes: true,
    dryRun: true,
    help: false,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("starter inspection and planning", () => {
  it("detects empty and allowed-doc repositories as starter mode", async () => {
    const empty = await emptyRepo();
    expect(inspectProject(empty).mode).toBe("starter");
    expect(inspectProject(empty).starterConflicts).toEqual([]);

    const documented = await emptyRepo({
      ".gitignore": ".env\n",
      "README.md": "# Existing\n",
      "LICENSE.txt": "license\n",
    });
    const inspection = inspectProject(documented);
    expect(inspection.mode).toBe("starter");
    expect(inspection.starterConflicts).toEqual([]);
    const plan = await makePlan(inspection, args(documented, "hono"));
    expect(plan.actions.find((action) => action.path?.endsWith("CHATPACK_SETUP.md"))).toBeTruthy();
    expect(plan.actions.find((action) => action.path?.endsWith("README.md"))).toBeUndefined();
  });

  // A `git init` on macOS, or a repo made from GitHub's web UI, already has
  // several of these before any code exists. Treating them as conflicts made
  // the starter unusable in exactly the situation it is meant for.
  it("ignores editor, CI and OS clutter when deciding a repository is empty", async () => {
    const cluttered = await emptyRepo({
      ".DS_Store": "\u0000",
      ".gitattributes": "* text=auto\n",
      ".editorconfig": "root = true\n",
      ".github/workflows/ci.yml": "name: ci\n",
      ".vscode/settings.json": "{}\n",
      "CONTRIBUTING.md": "# Contributing\n",
    });
    const inspection = inspectProject(cluttered);
    expect(inspection.mode).toBe("starter");
    expect(inspection.starterConflicts).toEqual([]);
    expect((await makePlan(inspection, args(cluttered, "hono"))).errors).toEqual([]);
  });

  it("reports unsafe pre-existing content before mutation", async () => {
    const root = await emptyRepo({
      "src/index.ts": "export {};\n",
      "vite.config.ts": "export {};\n",
    });
    const plan = await makePlan(inspectProject(root), args(root, "express"));
    expect(plan.errors).toEqual([
      "src: empty-repository starter mode does not allow this pre-existing entry.",
      "vite.config.ts: empty-repository starter mode does not allow this pre-existing entry.",
    ]);
    expect(validatePlan(plan)).toEqual([
      ...plan.errors,
      expect.stringContaining("src/index.ts: File exists with different content."),
    ]);
  });

  it("keeps package.json projects in existing-project mode", async () => {
    const root = await emptyRepo({ "package.json": "{}\n" });
    expect(inspectProject(root).mode).toBe("existing");
  });

  it.each(["better-auth", "authjs", "auth0"] as const)(
    "plans a complete Next starter for %s",
    async (provider) => {
      const root = await emptyRepo();
      const plan = await makePlan(inspectProject(root), args(root, "next", "pnpm", provider));
      expect(validatePlan(plan)).toEqual([]);
      expect(plan.answers.authProvider).toBe(provider);
      expect(
        plan.actions.find((action) => action.path?.endsWith("package.json"))?.content,
      ).toContain(`"authProvider": "${provider}"`);
      expect(
        plan.actions.some((action) => action.path?.includes("components/ui/sidebar.tsx")),
      ).toBe(true);
      expect(plan.actions.some((action) => action.path?.includes("api/profiles/route.ts"))).toBe(
        true,
      );
      const find = (suffix: string) =>
        plan.actions.find((action) => action.path?.endsWith(suffix))?.content;
      expect(find("profile-search.tsx")).toContain("setOpen(false)");
      expect(find("profile-search.tsx")).toContain("controller.signal.aborted");
      // Newest-first over the wire, oldest-first on screen.
      expect(find("message-list.tsx")).toContain("toReversed()");
      expect(find("message-row.tsx")).toContain('data-message-sender={isOwn ? "self" : "other"}');
      expect(find("message-row.tsx")).toContain('isOwn ? "justify-end" : "justify-start"');
      expect(find("conversation-header.tsx")).toContain('aria-label="Show conversations"');
      if (provider === "better-auth") {
        expect(find("src/lib/auth.ts")).toContain("user: users");
      }
      expect(plan.actions.at(-1)?.command).toBe("pnpm install");
    },
  );

  // The starter's job is to show the library, not a demo subset of it: the first
  // version shipped directs and send/list only, and a reader reasonably concluded
  // the rest did not exist. One assertion per feature, so removing a call site
  // fails here rather than quietly shrinking what the starter teaches.
  it("wires every Chatpack feature into the Next starter", async () => {
    const root = await emptyRepo();
    const plan = await makePlan(inspectProject(root), args(root, "next", "pnpm", "better-auth"));
    const find = (suffix: string) =>
      plan.actions.find((action) => action.path?.endsWith(suffix))?.content ?? "";

    const server = find("src/lib/chatpack.server.ts");
    for (const wiring of [
      "typing()",
      "presence()",
      "receipts()",
      "createApplicationFilepack",
      "createApplicationTransport",
      "canInvite",
      "canModerate",
      "beforeMessageSend",
    ]) {
      expect(server, `chatpack.server.ts is missing ${wiring}`).toContain(wiring);
    }

    const callSites: Array<[string, string]> = [
      ["conversation-sidebar.tsx", "client.useRealtimeStatus"],
      ["new-group-dialog.tsx", "client.conversations.createGroup"],
      ["message-list.tsx", "client.conversations.markRead"],
      ["message-list.tsx", "client.useTyping"],
      ["message-list.tsx", "client.useReceipts"],
      ["message-composer.tsx", "client.typing.start"],
      ["message-composer.tsx", "files.upload"],
      ["message-composer.tsx", "{ mentions }"],
      ["message-row.tsx", "client.messages.react"],
      ["message-row.tsx", "client.messages.edit"],
      ["message-row.tsx", "client.messages.delete"],
      ["forward-dialog.tsx", "client.messages.forward"],
      ["search-dialog.tsx", "client.useMessageSearch"],
      ["report-dialog.tsx", "client.moderation.report"],
      ["members-panel.tsx", "client.conversations.setParticipantRole"],
      ["members-panel.tsx", "client.invites.create"],
      ["members-panel.tsx", "client.joinRequests.resolve"],
      ["conversation-header.tsx", "client.conversations.update"],
      ["chat-shell.tsx", "client.moderation.muteConversation"],
      ["chat-shell.tsx", "client.moderation.blockUser"],
      ["chat-shell.tsx", "client.presence.get"],
      ["channel-directory.tsx", "client.channels.list"],
      ["channel-directory.tsx", "client.channels.join"],
      ["invite-accept.tsx", "client.invites.preview"],
      ["moderation-console.tsx", "client.moderation.listReports"],
      ["moderation-console.tsx", "client.moderation.banUser"],
    ];
    for (const [file, call] of callSites) {
      expect(find(file), `${file} is missing ${call}`).toContain(call);
    }

    for (const page of ["app/channels/page.tsx", "app/moderation/page.tsx", "app/invite"]) {
      expect(
        plan.actions.some((action) => action.path?.includes(page)),
        page,
      ).toBe(true);
    }

    // "Are you a moderator?" has no client-side answer - the console asks for the
    // queue and reads the refusal. NOT_MODERATOR (403) is that refusal; FORBIDDEN
    // is a different error and would leave the page stuck on a toast.
    expect(find("moderation-console.tsx")).toContain('"NOT_MODERATOR"');
  });

  it.each([
    ["next", "better-auth"],
    ["hono", undefined],
  ] as const)(
    "keeps attachments, moderators and Redis opt-in for %s",
    async (framework, provider) => {
      // A fresh clone has to run with no bucket, no Redis and no moderator list, so
      // these three live in .env.example only. Putting any of them in env.ts (which
      // throws on a missing value at import time) would break the first `dev`.
      const root = await emptyRepo();
      const plan = await makePlan(inspectProject(root), args(root, framework, "pnpm", provider));
      const find = (suffix: string) =>
        plan.actions.find((action) => action.path?.endsWith(suffix))?.content ?? "";

      const example = find(".env.example");
      for (const name of [
        "MODERATOR_EMAILS",
        "MODERATOR_USER_IDS",
        "FILE_STORAGE_DIRECTORY",
        "S3_BUCKET",
        "S3_ACCESS_KEY_ID",
        "REDIS_URL",
      ]) {
        expect(example, `.env.example is missing ${name}`).toContain(`# ${name}=`);
        expect(find("src/lib/env.ts"), `env.ts must not require ${name}`).not.toContain(name);
      }

      // Uploads land here by default, and a committed .chatpack-files directory is
      // both noise and a leak.
      expect(find(".gitignore")).toContain(".chatpack-files");

      const readme = find("README.md");
      expect(readme).toContain("## Optional features");
      expect(readme).toContain("## What is wired up");
      expect(plan.warnings.join("\n")).toContain("REDIS_URL");
      expect(plan.warnings.join("\n")).toContain("S3_BUCKET");
    },
  );

  // pnpm 11 appends a `minimumReleaseAgeExclude` entry to pnpm-workspace.yaml for
  // every recent version it accepted, and it does that during the install `init`
  // itself runs. Treating that file as ours to the byte made every pnpm starter
  // report "written content differs from plan" - a green setup called a failure -
  // and made a rerun report a hand-edit conflict.
  it("lets pnpm edit its own workspace file after install", async () => {
    const root = await emptyRepo();
    const plan = await makePlan(inspectProject(root), args(root, "hono", "pnpm"));
    for (const action of plan.actions) {
      if (action.kind === "create" || action.kind === "modify") applyFileAction(action);
    }
    const workspace = join(root, "pnpm-workspace.yaml");
    await writeFile(
      workspace,
      `${await readFile(workspace, "utf8")}minimumReleaseAgeExclude:\n  - '@chatpack/core@0.12.0'\n`,
    );

    expect(validateApplied(plan)).toEqual([]);

    const retry = await makePlan(inspectProject(root), args(root, "hono", "pnpm"));
    expect(validatePlan(retry)).toEqual([]);
    expect(
      retry.actions.find((action) => action.path?.endsWith("pnpm-workspace.yaml")),
    ).toMatchObject({ kind: "skip" });
  });

  it.each([
    ["hono", "npm"],
    ["express", "bun"],
  ] as const)("plans a fail-closed %s starter", async (framework, manager) => {
    const root = await emptyRepo();
    const plan = await makePlan(inspectProject(root), args(root, framework, manager));
    expect(validatePlan(plan)).toEqual([]);
    expect(
      plan.actions.find((action) => action.path?.endsWith("src/lib/chatpack.ts"))?.content,
    ).toContain("auth: async () => null");
    expect(plan.actions.find((action) => action.path?.endsWith("src/index.ts"))?.content).toContain(
      "/api/health",
    );
    expect(plan.actions.at(-1)?.command).toBe(`${manager} install`);
  });

  it.each(["hono", "express"] as const)(
    "loads the .env file %s is told to create",
    async (framework) => {
      // The backend starters are run by `tsx src/index.ts`, and neither Node nor
      // tsx reads a .env file on its own - only `next dev`/`next build` do. So
      // until src/lib/env.ts loaded one itself, following the generated README
      // exactly (copy .env.example to .env, then `dev`) threw
      // "Missing required environment variable: DATABASE_URL" with the file
      // sitting right there. `build` masked it: the CI recipe exports the
      // variables, so nothing ever read the file during the checks.
      const root = await emptyRepo();
      const plan = await makePlan(inspectProject(root), args(root, framework, "npm"));
      const find = (suffix: string) =>
        plan.actions.find((action) => action.path?.endsWith(suffix))?.content ?? "";

      const env = find("src/lib/env.ts");
      expect(env, "env.ts must load the file before validating it").toContain(
        "process.loadEnvFile(file)",
      );
      expect(env.indexOf("loadEnvFile")).toBeLessThan(env.indexOf("export const env"));
      // Both names work, in the order the scripts use them, because the README
      // says .env while drizzle.config.ts and scripts/ prefer .env.local.
      expect(env).toContain('[".env.local", ".env"]');
      expect(find("README.md")).toContain("Copy `.env.example` to `.env`");

      // Next loads .env* itself, so its env.ts (one per auth provider) has no copy
      // of this. Asserted so a later "let's share it" edit has to be deliberate.
      const nextRoot = await emptyRepo();
      const nextPlan = await makePlan(
        inspectProject(nextRoot),
        args(nextRoot, "next", "npm", "better-auth"),
      );
      expect(
        nextPlan.actions.find((action) => action.path?.endsWith("src/lib/env.ts"))?.content,
      ).not.toContain("loadEnvFile");
    },
  );

  it("writes pnpm's build approvals only for pnpm projects", async () => {
    // Without this file `pnpm install` exits non-zero on a fresh starter, and
    // the CLI reports the whole setup as failed. Nothing else reads it, so an
    // npm or Bun project must not be handed a stray pnpm config file.
    const withPnpm = await emptyRepo();
    const nextPlan = await makePlan(
      inspectProject(withPnpm),
      args(withPnpm, "next", "pnpm", "authjs"),
    );
    const nextConfig = nextPlan.actions.find((action) =>
      action.path?.endsWith("pnpm-workspace.yaml"),
    );
    expect(nextConfig?.content).toContain("sharp: true");
    expect(nextConfig?.content).toContain("onlyBuiltDependencies");

    const apiRoot = await emptyRepo();
    const apiPlan = await makePlan(inspectProject(apiRoot), args(apiRoot, "hono", "pnpm"));
    const apiConfig = apiPlan.actions.find((action) =>
      action.path?.endsWith("pnpm-workspace.yaml"),
    );
    expect(apiConfig?.content).toContain("esbuild: true");
    expect(apiConfig?.content).not.toContain("sharp");

    const npmRoot = await emptyRepo();
    const npmPlan = await makePlan(inspectProject(npmRoot), args(npmRoot, "hono", "npm"));
    expect(npmPlan.actions.some((action) => action.path?.endsWith("pnpm-workspace.yaml"))).toBe(
      false,
    );
  });

  it.each([
    ["next", "better-auth"],
    ["hono", undefined],
  ] as const)("ships the local-Postgres escape hatch for %s", async (framework, provider) => {
    // The proxy only helps if the script, the runner and the driver switch land
    // together, and it must stay opt-in: with NEON_WS_PROXY unset an app has to
    // reach Neon directly over TLS. Both frameworks are checked because Next
    // overrides src/lib/db.ts, so editing only the base layer silently skips it.
    const root = await emptyRepo();
    const plan = await makePlan(inspectProject(root), args(root, framework, "pnpm", provider));
    const find = (suffix: string) =>
      plan.actions.find((action) => action.path?.endsWith(suffix))?.content;

    expect(find("scripts/wsproxy.ts")).toContain("WebSocketServer");
    expect(find("package.json")).toContain('"db:proxy": "tsx scripts/wsproxy.ts"');
    expect(find("src/lib/db.ts")).toContain("if (process.env.NEON_WS_PROXY)");
    expect(find(".env.example")).toContain("# NEON_WS_PROXY=127.0.0.1:5480");
  });

  it.each([
    ["next", "better-auth"],
    ["hono", undefined],
    ["express", undefined],
  ] as const)(
    "keeps Filepack's tables out of drizzle-kit's schema for %s",
    async (framework, provider) => {
      // drizzle-kit loads src/db/schema.ts through CJS, and
      // `@filepack/adapter-drizzle` is ESM-only - its `exports` map has no
      // `require` condition and there is no `main`. Re-exporting its tables from
      // that file therefore makes drizzle-kit fail to read the schema and emit **no
      // migration at all**, while still exiting 0 - so `db:generate` reports
      // success and the app has no tables. Filepack publishes its own DDL instead,
      // which `db:migrate` applies after drizzle-kit. All three frameworks are
      // checked because each ships its own schema file.
      const root = await emptyRepo();
      const plan = await makePlan(inspectProject(root), args(root, framework, "pnpm", provider));
      const find = (suffix: string) =>
        plan.actions.find((action) => action.path?.endsWith(suffix))?.content ?? "";

      expect(find("src/db/schema.ts")).toContain('from "@chatpack/adapter-drizzle"');
      expect(
        find("src/db/schema.ts"),
        "schema.ts must not import @filepack/adapter-drizzle - drizzle-kit cannot load it",
      ).not.toContain('from "@filepack/adapter-drizzle"');
      expect(find("scripts/filepack-migrate.ts")).toContain("migrationStatements");
      expect(find("package.json")).toContain(
        '"db:migrate": "drizzle-kit migrate && tsx scripts/filepack-migrate.ts"',
      );

      // The other half of that decision. Filepack's record store takes a Drizzle
      // instance whose schema **is** its four tables, so the application `db` -
      // built from the schema.ts above, which does not have them - cannot be
      // passed to it. Filepack gets its own instance over the same pool instead.
      // Handing it `db` typechecks nowhere but fails only in a generated app, so
      // it is asserted here.
      expect(find("src/lib/filepack.ts")).toContain(
        "drizzleAdapter(drizzle({ client: options.pool, schema: filepackRecordsSchema }))",
      );
      const server = find(framework === "next" ? "chatpack.server.ts" : "src/lib/chatpack.ts");
      expect(server, `${framework} must hand Filepack the pool, not db`).toContain(
        "createApplicationFilepack({\n  pool,",
      );
    },
  );

  it("requires all non-interactive starter decisions", async () => {
    const root = await emptyRepo();
    const { framework: _framework, ...withoutFramework } = args(root, "next");
    await expect(makePlan(inspectProject(root), withoutFramework)).rejects.toThrow(
      "Starter framework is required",
    );
    const { packageManager: _manager, ...withoutManager } = args(root, "next");
    await expect(makePlan(inspectProject(root), withoutManager)).rejects.toThrow(
      "Package manager is required",
    );
    await expect(makePlan(inspectProject(root), args(root, "next"))).rejects.toThrow(
      "Next.js starter auth provider is required",
    );
  });

  it("rejects incompatible starter options and invalid names", async () => {
    const root = await emptyRepo();
    await expect(
      makePlan(inspectProject(root), { ...args(root, "web"), framework: "web" }),
    ).rejects.toThrow("existing projects");
    await expect(
      makePlan(inspectProject(root), { ...args(root, "hono"), authProvider: "auth0" }),
    ).rejects.toThrow("only available for Next.js");
    await expect(
      makePlan(inspectProject(root), { ...args(root, "hono"), adapter: "memory" }),
    ).rejects.toThrow("memory storage");
    await expect(
      makePlan(inspectProject(root), { ...args(root, "hono"), authPath: "auth.ts" }),
    ).rejects.toThrow("Existing-project option");
    await expect(
      makePlan(inspectProject(root), { ...args(root, "hono"), name: "Bad Name" }),
    ).rejects.toThrow("Invalid package name");
  });

  it("is immutable during planning and retry-safe after files are applied", async () => {
    const root = await emptyRepo();
    const options = { ...args(root, "express"), name: "retry-safe" };
    const plan = await makePlan(inspectProject(root), options);
    await expect(readFile(join(root, "package.json"))).rejects.toThrow();
    for (const action of plan.actions) {
      if (action.kind === "create" || action.kind === "modify") applyFileAction(action);
    }
    const retry = await makePlan(inspectProject(root), options);
    expect(retry.inspection.mode).toBe("starter");
    expect(
      retry.actions.filter((action) => action.kind === "create" || action.kind === "modify"),
    ).toEqual([]);
    expect(retry.actions.filter((action) => action.kind === "skip").length).toBeGreaterThan(5);
    expect(validatePlan(retry)).toEqual([]);
  });

  it("parses starter command options", () => {
    expect(
      parseArgs([
        "init",
        "--framework",
        "next",
        "--auth-provider",
        "auth0",
        "--name",
        "@scope/chat",
      ]),
    ).toMatchObject({ authProvider: "auth0", name: "@scope/chat" });
    expect(() => parseArgs(["init", "--auth-provider", "clerk"])).toThrow(
      "Unsupported auth provider",
    );
  });
});
