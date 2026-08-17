import { resolve } from "node:path";

import type { Adapter, AuthProvider, CliArgs, Framework, PackageManager } from "./types";

export type { CliArgs } from "./types";

const frameworks = new Set<Framework>(["next", "hono", "express", "web"]);
const adapters = new Set<Adapter>(["memory", "drizzle"]);
const packageManagers = new Set<PackageManager>(["npm", "pnpm", "yarn", "bun"]);
const authProviders = new Set<AuthProvider>(["better-auth", "authjs", "auth0"]);
const valueOptions = new Set([
  "cwd",
  "framework",
  "adapter",
  "package-manager",
  "auth-path",
  "auth-export",
  "auth-id-property",
  "db-path",
  "db-export",
  "auth-provider",
  "name",
]);

function valueAfter(argv: string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-") || value.length === 0)
    throw new Error(`${name} requires a value.`);
  return value;
}

export function parseArgs(argv: string[], initialCwd = process.cwd()): CliArgs {
  const result: CliArgs = {
    command: undefined,
    cwd: resolve(initialCwd),
    client: false,
    yes: false,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    if (!token.startsWith("-")) {
      if (result.command) throw new Error(`Unexpected argument: ${token}`);
      result.command = token;
      continue;
    }
    if (token === "-h" || token === "--help") {
      result.help = true;
      continue;
    }
    if (token === "--yes") {
      result.yes = true;
      continue;
    }
    if (token === "--dry-run") {
      result.dryRun = true;
      continue;
    }
    if (token === "--client") {
      result.client = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`Unknown option: ${token}`);

    const [parsedName, inlineValue] = token.slice(2).split("=", 2);
    const rawName = parsedName ?? "";
    const name = `--${rawName}`;
    if (!valueOptions.has(rawName)) throw new Error(`Unknown option: ${name}`);
    const value = inlineValue !== undefined ? inlineValue : valueAfter(argv, index++, name);
    if (value.length === 0) throw new Error(`${name} requires a value.`);
    switch (rawName) {
      case "cwd":
        result.cwd = resolve(result.cwd, value);
        break;
      case "framework":
        if (!frameworks.has(value as Framework)) throw new Error(`Unsupported framework: ${value}`);
        result.framework = value as Framework;
        break;
      case "adapter":
        if (!adapters.has(value as Adapter)) throw new Error(`Unsupported adapter: ${value}`);
        result.adapter = value as Adapter;
        break;
      case "package-manager":
        if (!packageManagers.has(value as PackageManager)) {
          throw new Error(`Unsupported package manager: ${value}`);
        }
        result.packageManager = value as PackageManager;
        break;
      case "auth-provider":
        if (!authProviders.has(value as AuthProvider)) {
          throw new Error(`Unsupported auth provider: ${value}`);
        }
        result.authProvider = value as AuthProvider;
        break;
      case "name":
        result.name = value;
        break;
      case "auth-path":
        result.authPath = value;
        break;
      case "auth-export":
        result.authExport = value;
        break;
      case "auth-id-property":
        result.authIdProperty = value;
        break;
      case "db-path":
        result.dbPath = value;
        break;
      case "db-export":
        result.dbExport = value;
        break;
      default:
        throw new Error(`Unknown option: ${name}`);
    }
  }

  if (result.authPath && !result.authExport) throw new Error("--auth-path requires --auth-export.");
  if (result.authExport && !result.authPath) throw new Error("--auth-export requires --auth-path.");
  if (result.authIdProperty && !/^[A-Za-z_$][\w$]*$/.test(result.authIdProperty)) {
    throw new Error(`Invalid auth id property: ${result.authIdProperty}`);
  }
  if (result.dbPath && !result.dbExport) throw new Error("--db-path requires --db-export.");
  if (result.dbExport && !result.dbPath) throw new Error("--db-export requires --db-path.");
  return result;
}

export function usage(): string {
  return `Chatpack CLI

Usage:
  chatpack init [options]

Options:
  --cwd <path>                         Project directory
  --framework <next|hono|express|web> Framework target
  --adapter <memory|drizzle>          Storage adapter
  --auth-path <path>                   Confirmed auth resolver module
  --auth-export <name>                 Confirmed auth resolver export
  --auth-id-property <name>            User id property (default: id)
  --db-path <path>                     Drizzle database module
  --db-export <name>                   Drizzle database export
  --package-manager <name>             npm, pnpm, yarn, or bun
  --auth-provider <name>               better-auth, authjs, or auth0 (Next starters)
  --name <package-name>                Package name for a new starter
  --client                             Generate client setup
  --yes                                Skip confirmation; never skips required decisions
  --dry-run                            Show plan without installing or writing
  -h, --help                           Show help`;
}
