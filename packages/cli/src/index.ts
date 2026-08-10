import { realpathSync } from "node:fs";

import { parseArgs, usage } from "./args";
import { runInit } from "./commands/init";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.help || !args.command) {
      console.log(usage());
      return args.help ? 0 : 1;
    }
    if (args.command !== "init")
      throw new Error(`Unknown command: ${args.command}. Only init is available in v1.`);
    return await runInit(args);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function isCliEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(__filename);
  } catch {
    return false;
  }
}

if (isCliEntrypoint()) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
