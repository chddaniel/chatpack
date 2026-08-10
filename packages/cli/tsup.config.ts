import { defineConfig } from "tsup";

const esmBanner = `#!/usr/bin/env node
import { createRequire as __chatpackCreateRequire } from "node:module";
import { fileURLToPath as __chatpackFileURLToPath } from "node:url";
import { dirname as __chatpackDirname } from "node:path";
const require = __chatpackCreateRequire(import.meta.url);
const __filename = __chatpackFileURLToPath(import.meta.url);
const __dirname = __chatpackDirname(__filename);`;

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  minify: true,
  sourcemap: false,
  target: "es2022",
  noExternal: ["typescript"],
  banner: {
    js: "#!/usr/bin/env node",
  },
  esbuildOptions(options, context) {
    if (context.format === "esm") {
      options.banner = { js: esmBanner };
    }
  },
});
