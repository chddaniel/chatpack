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

if (process.argv[1]?.endsWith("/index.js") || process.argv[1]?.endsWith("\\index.js")) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
