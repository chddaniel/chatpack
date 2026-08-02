import { inspectProject } from "../project/inspect";
import { installPackages } from "../install";
import { applyFileAction } from "../modify";
import { makePlan } from "../plan";
import { confirm } from "../prompts";
import { printPlan, printResult } from "../output";
import { validateApplied, validatePlan } from "../validate";
import type { CliArgs } from "../args";

export async function runInit(args: CliArgs): Promise<number> {
  if (!args.yes && !process.stdin.isTTY) {
    console.error(
      "Error: non-interactive init requires --yes; review the plan with --dry-run before applying it.",
    );
    return 1;
  }
  const inspection = inspectProject(args.cwd);
  const plan = await makePlan(inspection, args);
  printPlan(plan);
  const errors = validatePlan(plan);
  if (errors.length > 0) {
    for (const error of errors) console.error(`Error: ${error}`);
    return 1;
  }
  if (args.dryRun) {
    console.log("\nDry run complete. No packages installed and no files changed.");
    return 0;
  }
  if (!args.yes) {
    if (!(await confirm("Apply this plan?", false))) {
      console.log("No changes made.");
      return 0;
    }
  }
  const install = plan.actions.find((action) => action.kind === "install" && action.command);
  if (install?.command) {
    const packages = install.command.split(" ").slice(2);
    try {
      await installPackages(plan.answers.packageManager, packages, plan.inspection.packageRoot);
    } catch (error) {
      console.error(`Error: dependency installation failed: ${String(error)}`);
      return 1;
    }
  }
  try {
    for (const action of plan.actions) {
      if (action.kind === "create" || (action.kind === "modify" && action.content !== undefined))
        applyFileAction(action);
    }
  } catch (error) {
    console.error(
      `Error: setup stopped after dependency installation; inspect the reported files and retry: ${String(error)}`,
    );
    return 1;
  }
  const appliedErrors = validateApplied(plan);
  if (appliedErrors.length > 0) {
    for (const error of appliedErrors) console.error(`Error: ${error}`);
    return 1;
  }
  printResult(plan);
  return 0;
}
