import { spawn } from "node:child_process";

import type { PackageManager } from "./types";

const installCommands: Record<PackageManager, string> = {
  npm: "npm install",
  pnpm: "pnpm add",
  yarn: "yarn add",
  bun: "bun add",
};

const projectInstallCommands: Record<PackageManager, [string, string[]]> = {
  npm: ["npm", ["install"]],
  pnpm: ["pnpm", ["install"]],
  yarn: ["yarn", ["install"]],
  bun: ["bun", ["install"]],
};

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with code ${code ?? "unknown"}.`)),
    );
  });
}

export function installCommand(manager: PackageManager, packages: string[]): string {
  if (packages.length === 0) return "";
  return `${installCommands[manager]} ${packages.join(" ")}`;
}

export async function installPackages(
  manager: PackageManager,
  packages: string[],
  cwd: string,
): Promise<void> {
  if (packages.length === 0) return;
  const [command, ...args] = installCommand(manager, packages).split(" ");
  await run(command!, args, cwd);
}

export async function installProject(manager: PackageManager, cwd: string): Promise<void> {
  const [command, args] = projectInstallCommands[manager];
  await run(command, args, cwd);
}
