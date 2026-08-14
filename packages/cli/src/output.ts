import { relative } from "node:path";

import type { PlanAction, SetupPlan } from "./types";

/**
 * Above this many file actions the plan prints a grouped summary instead of one
 * line per file - a Next.js starter writes fifty-plus files, and that wall of
 * paths is what motivated dropping the list. Conflicts, modifications,
 * warnings and errors are never summarised away, and `--dry-run` lists
 * everything, because inspecting the file list is the point of a dry run.
 */
const FILE_LIST_LIMIT = 12;

export interface PrintPlanOptions {
  /** List every file action instead of grouping them. Set by `--dry-run`. */
  verbose?: boolean;
}

function target(plan: SetupPlan, action: PlanAction): string {
  if (action.command) return action.command;
  if (!action.path) return "project";
  return relative(plan.inspection.packageRoot, action.path);
}

function describe(plan: SetupPlan, action: PlanAction): string {
  const state = action.conflict ? `CONFLICT: ${action.conflict}` : action.reason;
  return `- ${action.kind}: ${target(plan, action)} - ${state}`;
}

function topLevel(plan: SetupPlan, action: PlanAction): string {
  const segments = target(plan, action).split("/");
  const [first = ""] = segments;
  return segments.length > 1 ? `${first}/` : first;
}

export function printPlan(plan: SetupPlan, options: PrintPlanOptions = {}): void {
  console.log("\nChatpack setup plan\n");
  const rows: Array<[string, string]> = [
    ["Project", plan.inspection.packageRoot],
    ["Mode", plan.inspection.mode],
    ["Framework", plan.answers.framework],
    ["Storage", plan.answers.adapter],
    ["Manager", plan.answers.packageManager],
  ];
  if (plan.answers.authProvider) rows.push(["Auth", plan.answers.authProvider]);
  if (plan.answers.packageName) rows.push(["Package", plan.answers.packageName]);
  const labelWidth = Math.max(...rows.map(([label]) => label.length)) + 2;
  for (const [label, value] of rows) console.log(`${`${label}:`.padEnd(labelWidth)}${value}`);

  const files = plan.actions.filter((action) => action.kind !== "install");
  const installs = plan.actions.filter((action) => action.kind === "install" && action.command);
  if (files.length > 0 || installs.length > 0) console.log("");

  if (options.verbose || files.length <= FILE_LIST_LIMIT) {
    for (const action of files) console.log(describe(plan, action));
  } else {
    // Only the bulk `create` list collapses. A conflict or a modification to a
    // file the developer already owns has to stay visible at any plan size.
    const creates = files.filter((action) => action.kind === "create" && !action.conflict);
    for (const action of files) {
      if (!creates.includes(action)) console.log(describe(plan, action));
    }
    const groups = new Map<string, number>();
    for (const action of creates) {
      const group = topLevel(plan, action);
      groups.set(group, (groups.get(group) ?? 0) + 1);
    }
    console.log(`- create: ${creates.length} file(s)`);
    for (const [group, count] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
      console.log(`    ${group} (${count})`);
    }
    console.log("  Re-run with --dry-run to list every file.");
  }
  for (const action of installs) console.log(describe(plan, action));

  for (const warning of plan.warnings) console.log(`Warning: ${warning}`);
  for (const error of plan.errors) console.log(`Error: ${error}`);
}

export function printResult(plan: SetupPlan): void {
  const created = plan.actions.filter(
    (action) => action.kind === "create" && !action.conflict && action.content !== undefined,
  );
  const modified = plan.actions.filter(
    (action) => action.kind === "modify" && !action.conflict && action.content !== undefined,
  );
  const skipped = plan.actions.filter((action) => action.kind === "skip");
  const installs = plan.actions.filter((action) => action.kind === "install" && action.command);
  console.log(
    `\nChatpack setup complete. Created ${created.length} file(s), modified ${modified.length} file(s).`,
  );
  for (const action of installs) console.log(`Installed: ${action.command}`);
  if (created.length <= FILE_LIST_LIMIT) {
    for (const action of created) console.log(`Created: ${target(plan, action)}`);
  }
  for (const action of modified) console.log(`Modified: ${target(plan, action)}`);
  for (const action of skipped) console.log(`Skipped: ${target(plan, action)} - ${action.reason}`);
  // These are the only instructions telling the reader what setup could not do
  // for them: a handler left unmounted, a secret to fill in, a migration to run.
  for (const warning of plan.warnings) console.log(`Next step: ${warning}`);
}
