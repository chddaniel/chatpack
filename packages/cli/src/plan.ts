import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { allDependencies } from "./package-json";
import { actionForFile, mountAction } from "./modify";
import {
  clientPath,
  nextRoutePath,
  renderClient,
  renderExpressIntegration,
  renderHonoIntegration,
  renderNextRoute,
  renderSchema,
  renderServer,
  schemaPath,
  serverPath,
} from "./generate";
import { installCommand } from "./install";
import { makeStarterPlan } from "./starter";
import type { CliArgs } from "./args";
import { confirm, prompt, select } from "./prompts";
import type {
  Adapter,
  Framework,
  PackageManager,
  ProjectInspection,
  SetupAnswers,
  SetupPlan,
} from "./types";

function importPath(from: string, target: string, useRuntimeExtension = true): string {
  const normalized = relative(dirname(from), target).replaceAll("\\", "/");
  const hasRuntimeExtension = /\.(?:c?js|mjs|jsx)$/.test(normalized);
  const extensionless = hasRuntimeExtension
    ? normalized
    : normalized.replace(/\.[cm]?[jt]sx?$/, "");
  const value = hasRuntimeExtension
    ? normalized
    : useRuntimeExtension
      ? `${extensionless}.js`
      : extensionless;
  return value.startsWith(".") ? value : `./${value}`;
}

function dependencyExists(inspection: ProjectInspection, name: string): boolean {
  return Boolean(allDependencies(inspection.packageJson)[name]);
}

function requireModulePath(root: string, path: string, label: string): string {
  const target = resolve(root, path);
  const candidates = [
    target,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map((extension) => `${target}${extension}`),
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map(
      (extension) => `${target}/index${extension}`,
    ),
  ];
  const existing = candidates.find(existsSync);
  if (!existing) throw new Error(`${label} module not found: ${path}`);
  return existing;
}

function requireAuthProperty(value: string): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(value)) throw new Error(`Invalid auth id property: ${value}`);
  return value;
}

function supportedFramework(value: Framework | undefined): value is Framework {
  return value === "next" || value === "hono" || value === "express" || value === "web";
}

async function chooseFramework(inspection: ProjectInspection, args: CliArgs): Promise<Framework> {
  if (args.framework) return args.framework;
  if (supportedFramework(inspection.framework)) return inspection.framework;
  if (args.yes)
    throw new Error("Framework is unknown. Supply --framework next, hono, express, or web.");
  return select("Framework", ["next", "hono", "express", "web"], "next");
}

async function chooseAdapter(inspection: ProjectInspection, args: CliArgs): Promise<Adapter> {
  if (args.adapter) return args.adapter;
  if (inspection.chatpackConfig) {
    const source =
      inspection.files.find((file) => file.path === inspection.chatpackConfig?.path)?.content ?? "";
    if (source.includes("@chatpack/adapter-drizzle")) return "drizzle";
    if (source.includes("@chatpack/adapter-memory")) return "memory";
  }
  if (args.yes)
    throw new Error("Storage adapter is required. Supply --adapter memory or --adapter drizzle.");
  return select("Storage adapter", ["memory", "drizzle"] as const);
}

async function chooseManager(
  inspection: ProjectInspection,
  args: CliArgs,
): Promise<PackageManager> {
  if (args.packageManager) return args.packageManager;
  if (inspection.packageManager) return inspection.packageManager;
  if (args.yes) throw new Error("Package manager is unknown. Supply --package-manager.");
  const detected = [
    ...new Set(
      inspection.packageManagerEvidence
        .map((item) => item.split("=")[1])
        .filter(
          (item): item is PackageManager =>
            item !== undefined && ["npm", "pnpm", "yarn", "bun"].includes(item),
        ),
    ),
  ];
  if (detected.length > 1) return select("Multiple package managers detected", detected);
  throw new Error(
    "No package manager lockfile found. Supply --package-manager npm, pnpm, yarn, or bun.",
  );
}

async function chooseAuth(
  inspection: ProjectInspection,
  args: CliArgs,
  serverFile: string,
  useRuntimeExtension: boolean,
): Promise<SetupAnswers["auth"]> {
  if (args.authPath && args.authExport) {
    const target = requireModulePath(inspection.packageRoot, args.authPath, "Auth");
    return {
      path: importPath(serverFile, target, useRuntimeExtension),
      exportName: args.authExport,
      idProperty: requireAuthProperty(args.authIdProperty ?? "id"),
    };
  }
  if (args.yes) return undefined;
  if (
    inspection.authCandidates.length > 0 &&
    (await confirm("Use an existing auth resolver?", true))
  ) {
    const path = await prompt(
      "Auth resolver module path",
      inspection.authCandidates[0]?.startsWith("/")
        ? relative(inspection.packageRoot, inspection.authCandidates[0]!)
        : "src/lib/auth",
    );
    const exportName = await prompt("Auth resolver export", "getSessionUser");
    const idProperty = requireAuthProperty(await prompt("User id property", "id"));
    const target = requireModulePath(inspection.packageRoot, path, "Auth");
    return {
      path: importPath(serverFile, target, useRuntimeExtension),
      exportName,
      idProperty,
    };
  }
  return undefined;
}

async function chooseDatabase(
  inspection: ProjectInspection,
  args: CliArgs,
  serverFile: string,
  adapter: Adapter,
  useRuntimeExtension: boolean,
): Promise<SetupAnswers["database"]> {
  if (adapter === "memory") return undefined;
  if (args.dbPath && args.dbExport) {
    const target = requireModulePath(inspection.packageRoot, args.dbPath, "Database");
    return {
      path: importPath(serverFile, target, useRuntimeExtension),
      exportName: args.dbExport,
    };
  }
  if (args.yes) throw new Error("Drizzle setup requires --db-path and --db-export.");
  const candidate =
    inspection.databaseCandidates.length === 1 ? inspection.databaseCandidates[0] : undefined;
  const path = await prompt(
    "Drizzle database module path",
    candidate ? relative(inspection.packageRoot, candidate.path) : "src/lib/db",
  );
  const exportName = await prompt("Drizzle database export", candidate?.exportName ?? "db");
  const target = requireModulePath(inspection.packageRoot, path, "Database");
  return {
    path: importPath(serverFile, target, useRuntimeExtension),
    exportName,
  };
}

async function chooseClient(args: CliArgs): Promise<boolean> {
  if (args.client) return true;
  if (args.yes) return false;
  return confirm("Generate Chatpack client setup?", false);
}

function existingFile(inspection: ProjectInspection, path: string): boolean {
  return existsSync(path) || inspection.files.some((file) => file.path === path);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported framework: ${String(value)}`);
}

function planFrameworkActions(
  inspection: ProjectInspection,
  framework: Framework,
  configPath: string,
  language: ProjectInspection["language"],
): Pick<SetupPlan, "actions" | "warnings" | "errors"> {
  const actions = [] as SetupPlan["actions"];
  const warnings: string[] = [];
  const errors: string[] = [];

  switch (framework) {
    case "next": {
      const route = nextRoutePath(inspection.sourceRoot, language);
      if (inspection.chatpackRoutes.length === 0) {
        actions.push(
          actionForFile(
            route,
            renderNextRoute(route, configPath),
            "Create the Next.js catch-all Chatpack route.",
          ),
        );
      } else {
        const existingRoute = inspection.files.find((file) =>
          inspection.chatpackRoutes.includes(file.path),
        );
        if (
          existingRoute &&
          !/GET[\s\S]*POST[\s\S]*PATCH[\s\S]*DELETE/.test(existingRoute.content)
        ) {
          errors.push(
            `${existingRoute.path}: existing Chatpack route does not export all required HTTP methods.`,
          );
        }
      }
      break;
    }
    case "hono": {
      const integration = resolve(
        inspection.sourceRoot,
        "lib",
        `chatpack.hono${language === "typescript" ? ".ts" : ".js"}`,
      );
      if (!existingFile(inspection, integration))
        actions.push(
          actionForFile(
            integration,
            renderHonoIntegration(configPath, language),
            "Create the Hono Chatpack handler module.",
          ),
        );
      const entrypoint =
        inspection.serverEntrypoints.length === 1 ? inspection.serverEntrypoints[0] : undefined;
      if (entrypoint) actions.push(mountAction(entrypoint, integration, "hono"));
      else
        warnings.push(
          "Mount chatpackHandler on /api/chat/* in your Hono entrypoint; no unique entrypoint was detected.",
        );
      break;
    }
    case "express": {
      const integration = resolve(
        inspection.sourceRoot,
        "lib",
        `chatpack.express${language === "typescript" ? ".ts" : ".js"}`,
      );
      if (!existingFile(inspection, integration))
        actions.push(
          actionForFile(
            integration,
            renderExpressIntegration(configPath, language),
            "Create the streaming Express Chatpack bridge.",
          ),
        );
      const entrypoint =
        inspection.serverEntrypoints.length === 1 ? inspection.serverEntrypoints[0] : undefined;
      if (entrypoint) {
        actions.push(mountAction(entrypoint, integration, "express"));
        warnings.push(
          "Mount the Express bridge before body parsers and catch-all middleware so it can read the raw request body.",
        );
      } else
        warnings.push(
          "Mount chatpackExpress on /api/chat in your Express entrypoint; no unique entrypoint was detected.",
        );
      break;
    }
    case "web":
      warnings.push(
        "Framework-agnostic Web setup needs a manual handler.fetch mount; no route file was generated.",
      );
      break;
    default:
      assertNever(framework);
  }

  return { actions, warnings, errors };
}

export async function makePlan(inspection: ProjectInspection, args: CliArgs): Promise<SetupPlan> {
  if (inspection.mode === "starter") return makeStarterPlan(inspection, args);
  if (args.authProvider || args.name) {
    throw new Error("--auth-provider and --name are only available for new starter projects.");
  }
  const framework = await chooseFramework(inspection, args);
  const adapter = await chooseAdapter(inspection, args);
  const manager = await chooseManager(inspection, args);
  const language = inspection.language;
  const provisionalServerFile = serverPath(inspection.sourceRoot, language);
  const useRuntimeExtension = framework !== "next";
  const auth = await chooseAuth(inspection, args, provisionalServerFile, useRuntimeExtension);
  const database = await chooseDatabase(
    inspection,
    args,
    provisionalServerFile,
    adapter,
    useRuntimeExtension,
  );
  const client = await chooseClient(args);
  const answers: SetupAnswers = {
    framework,
    adapter,
    packageManager: manager,
    client,
    ...(auth ? { auth } : {}),
    ...(database ? { database } : {}),
  };
  const actions = [] as SetupPlan["actions"];
  const warnings: string[] = [];
  const errors: string[] = [];
  const dependencies: string[] = [];

  if (!dependencyExists(inspection, "@chatpack/core")) dependencies.push("@chatpack/core");
  if (adapter === "memory" && !dependencyExists(inspection, "@chatpack/adapter-memory"))
    dependencies.push("@chatpack/adapter-memory");
  if (adapter === "drizzle" && !dependencyExists(inspection, "@chatpack/adapter-drizzle"))
    dependencies.push("@chatpack/adapter-drizzle");
  if (framework === "next" && !dependencyExists(inspection, "@chatpack/next"))
    dependencies.push("@chatpack/next");
  if (client && !dependencyExists(inspection, "@chatpack/client"))
    dependencies.push("@chatpack/client");
  const command = installCommand(manager, dependencies);
  if (command)
    actions.push({ kind: "install", command, reason: "Install Chatpack runtime packages." });

  let configPath = inspection.chatpackConfig?.path;
  if (inspection.chatpackConfigs.length > 1)
    errors.push("Multiple chatpack() instances found. Choose one manually before running init.");
  if (!configPath) {
    configPath = provisionalServerFile;
    actions.push(
      actionForFile(
        configPath,
        renderServer(answers, language),
        "Create the single Chatpack server instance.",
      ),
    );
  }
  if (adapter === "memory")
    warnings.push(
      "Memory storage loses data on process restart and is not suitable for serverless production.",
    );
  if (adapter === "drizzle") {
    const schema = schemaPath(inspection.sourceRoot, language);
    if (
      !inspection.files.some((file) => /chatpack\.schema\.[cm]?[jt]sx?$/.test(file.relativePath))
    ) {
      actions.push(
        actionForFile(schema, renderSchema(), "Create the Chatpack Drizzle schema export."),
      );
      warnings.push(
        "Add the generated Chatpack schema module to your Drizzle configuration and run your normal migration command.",
      );
    }
  }
  if (!auth && !inspection.chatpackConfig)
    warnings.push(
      "Connect resolveChatpackUser before using the API; the placeholder returns null and requests receive 401.",
    );

  const frameworkPlan = planFrameworkActions(inspection, framework, configPath, language);
  actions.push(...frameworkPlan.actions);
  warnings.push(...frameworkPlan.warnings);
  errors.push(...frameworkPlan.errors);

  if (client) {
    const path = clientPath(inspection.sourceRoot, language);
    actions.push(
      actionForFile(path, renderClient(framework), "Create the optional Chatpack client setup."),
    );
  }
  return { inspection, answers, actions, warnings, errors };
}
