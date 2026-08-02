import type { PackageJson } from "./package-json";

export type Framework = "next" | "hono" | "express" | "web";
export type Adapter = "memory" | "drizzle";
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
export type Language = "typescript" | "javascript";

export interface CliArgs {
  command: string | undefined;
  cwd: string;
  framework?: Framework;
  adapter?: Adapter;
  authPath?: string;
  authExport?: string;
  authIdProperty?: string;
  dbPath?: string;
  dbExport?: string;
  packageManager?: PackageManager;
  client: boolean;
  yes: boolean;
  dryRun: boolean;
  help: boolean;
}

export interface FileInfo {
  path: string;
  relativePath: string;
  content: string;
}

export interface ProjectInspection {
  cwd: string;
  packageRoot: string;
  workspaceRoot: string;
  packageJsonPath: string;
  packageJson: PackageJson;
  sourceRoot: string;
  language: Language;
  packageManager?: PackageManager;
  packageManagerEvidence: string[];
  framework?: Framework;
  frameworkEvidence: string[];
  aliases: Record<string, string[]>;
  files: FileInfo[];
  chatpackConfig?: { path: string; exportName: string };
  chatpackConfigs: string[];
  chatpackRoutes: string[];
  databaseCandidates: Array<{ path: string; exportName: string }>;
  authCandidates: string[];
  serverEntrypoints: string[];
}

export interface SetupAnswers {
  framework: Framework;
  adapter: Adapter;
  packageManager: PackageManager;
  auth?: { path: string; exportName: string; idProperty: string };
  database?: { path: string; exportName: string };
  client: boolean;
}

export type ActionKind = "install" | "create" | "modify" | "skip";

export interface PlanAction {
  kind: ActionKind;
  path?: string;
  command?: string;
  content?: string;
  reason: string;
  conflict?: string;
}

export interface SetupPlan {
  inspection: ProjectInspection;
  answers: SetupAnswers;
  actions: PlanAction[];
  warnings: string[];
  errors: string[];
}
