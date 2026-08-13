import type { SetupPlan } from "./types";

export function printPlan(plan: SetupPlan): void {
  console.log("\nChatpack setup plan\n");
  console.log(`Project:  ${plan.inspection.packageRoot}`);
  console.log(`Mode:      ${plan.inspection.mode}`);
  console.log(`Framework: ${plan.answers.framework}`);
  console.log(`Storage:   ${plan.answers.adapter}`);
  console.log(`Manager:   ${plan.answers.packageManager}`);
  if (plan.answers.authProvider) console.log(`Auth:      ${plan.answers.authProvider}`);
  if (plan.answers.packageName) console.log(`Package:   ${plan.answers.packageName}`);
  for (const action of plan.actions) {
    const target = action.command ?? action.path ?? "project";
    const state = action.conflict ? "CONFLICT" : action.reason;
    console.log(`- ${action.kind}: ${target} — ${state}`);
  }
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
  for (const action of created) console.log(`Created: ${action.path}`);
  for (const action of modified) console.log(`Modified: ${action.path}`);
  for (const action of skipped) console.log(`Skipped: ${action.path} — ${action.reason}`);
  for (const warning of plan.warnings) console.log(`Next step: ${warning}`);
}
