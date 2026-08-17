import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

import ts from "typescript";

import { parseSource } from "./project/inspect";
import type { SetupPlan } from "./types";

/**
 * Files a package manager owns and rewrites during its own `install`.
 *
 * {@link validateApplied} runs *after* that install, so comparing these byte for
 * byte asks the wrong question: pnpm 11 records a `minimumReleaseAgeExclude`
 * entry in `pnpm-workspace.yaml` for every recently published version it
 * accepted, which made a perfectly good starter report "written content differs
 * from plan". A package manager updating its own config is not a failed write.
 * The file still has to exist.
 */
const packageManagerOwned = new Set(["pnpm-workspace.yaml"]);

export function validatePlan(plan: SetupPlan): string[] {
  const errors = [...plan.errors];
  for (const action of plan.actions) {
    if (action.conflict) {
      errors.push(`${action.path ?? "project"}: ${action.conflict}`);
      continue;
    }
    if (!action.path || action.content === undefined) continue;
    if (!/\.(?:[cm]?[jt]sx?)$/.test(action.path)) continue;
    if (/\.d\.ts$/.test(action.path)) continue;
    try {
      parseSource(action.path, action.content);
      const diagnostics =
        ts.transpileModule(action.content, {
          fileName: action.path,
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
          reportDiagnostics: true,
        }).diagnostics ?? [];
      if (diagnostics.length > 0)
        errors.push(`${action.path}: generated source contains syntax errors.`);
    } catch (error) {
      errors.push(`${action.path}: generated source could not be parsed (${String(error)}).`);
    }
  }
  if (plan.inspection.mode === "existing" && plan.answers.framework === "next") {
    const route = plan.actions.find((action) => action.path?.includes("[...chatpack]"));
    if (!route && plan.inspection.chatpackRoutes.length === 0)
      errors.push("Next.js catch-all route is missing.");
  }
  if (
    plan.inspection.mode === "existing" &&
    plan.answers.adapter === "drizzle" &&
    !plan.answers.database
  )
    errors.push("Drizzle adapter has no confirmed database export.");
  return errors;
}

export function validateApplied(plan: SetupPlan): string[] {
  const errors: string[] = [];
  for (const action of plan.actions) {
    if (!action.path || action.content === undefined || action.conflict) continue;
    if (!existsSync(action.path)) {
      errors.push(`${action.path}: expected file was not written.`);
      continue;
    }
    if (packageManagerOwned.has(basename(action.path))) continue;
    if (readFileSync(action.path, "utf8") !== action.content)
      errors.push(`${action.path}: written content differs from plan.`);
  }
  return errors;
}
