#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(cliRoot, "../..");
const runtimePackages = ["core", "client", "adapter-drizzle", "file", "transport-redis"];
const supportedFrameworks = new Set(["next", "hono", "express"]);
const supportedManagers = new Set(["npm", "pnpm", "yarn", "bun"]);
const supportedProviders = new Set(["better-auth", "authjs", "auth0"]);
const yarnVersion = "4.18.0";
const children = new Set();

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value) throw new Error(`Invalid argument: ${flag ?? ""}`);
    values[flag.slice(2)] = value;
  }

  const framework = values.framework;
  const packageManager = values["package-manager"];
  const authProvider = values["auth-provider"];
  if (!supportedFrameworks.has(framework)) {
    throw new Error("--framework must be next, hono, or express.");
  }
  if (!supportedManagers.has(packageManager)) {
    throw new Error("--package-manager must be npm, pnpm, yarn, or bun.");
  }
  if (framework === "next" && !supportedProviders.has(authProvider)) {
    throw new Error("Next fixtures require --auth-provider better-auth, authjs, or auth0.");
  }
  if (framework !== "next" && authProvider) {
    throw new Error("--auth-provider is only valid with --framework next.");
  }
  return { framework, packageManager, authProvider };
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    console.log(`> ${command} ${args.join(" ")}`);
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      stdio: options.stdio ?? "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code ?? signal ?? "an unknown status"}.`));
    });
  });
}

function start(command, args, options) {
  console.log(`> ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

async function stop(child) {
  if (!children.has(child)) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
  ]);
  if (children.has(child)) child.kill("SIGKILL");
}

function packageScript(manager, script, args = []) {
  if (manager === "yarn") return ["corepack", ["yarn", script, ...args]];
  if (manager === "bun") return ["bun", ["run", script, ...args]];
  if (manager === "pnpm") return ["pnpm", ["run", script, ...args]];
  return ["npm", ["run", script, ...(args.length > 0 ? ["--", ...args] : [])]];
}

async function runPackageScript(manager, script, cwd, env) {
  const [command, args] = packageScript(manager, script);
  await run(command, args, { cwd, env });
}

async function freePort() {
  return await new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a local port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePromise(address.port)));
    });
  });
}

async function waitForPort(port, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Process exited before port ${port} opened.`);
    const connected = await new Promise((resolvePromise) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolvePromise(true);
      });
      socket.once("error", () => resolvePromise(false));
    });
    if (connected) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Timed out waiting for port ${port}.`);
}

async function waitForHttp(url, child) {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited before ${url} became ready.`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`${url} returned ${response.status}: ${await response.text()}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}.`);
}

async function packLocalPackages(packDirectory) {
  const packageDirectories = [...runtimePackages, "cli"];
  await run("pnpm", [
    ...packageDirectories.flatMap((name) => ["--filter", `@chatpack/${name}`]),
    "build",
  ]);

  const tarballs = new Map();
  for (const directory of packageDirectories) {
    const packageRoot = join(repositoryRoot, "packages", directory);
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    await run("pnpm", ["pack", "--pack-destination", packDirectory], { cwd: packageRoot });
    const expected = `${manifest.name.slice(1).replace("/", "-")}-${manifest.version}.tgz`;
    const entries = await readdir(packDirectory);
    if (!entries.includes(expected)) throw new Error(`pnpm pack did not create ${expected}.`);
    const tarball = join(packDirectory, expected);
    const localDependencies = Object.keys(manifest.dependencies ?? {}).filter((name) =>
      name.startsWith("@chatpack/"),
    );
    if (localDependencies.length > 0) {
      const extracted = join(packDirectory, `.rewrite-${directory}`);
      await mkdir(extracted);
      await run("tar", ["-xzf", tarball, "-C", extracted]);
      const packedManifestPath = join(extracted, "package", "package.json");
      const packedManifest = JSON.parse(await readFile(packedManifestPath, "utf8"));
      for (const name of localDependencies) {
        const dependencyTarball = tarballs.get(name);
        if (!dependencyTarball) {
          throw new Error(`${manifest.name} depends on ${name}, which was not packed first.`);
        }
        packedManifest.dependencies[name] = `file:${dependencyTarball}`;
      }
      await writeFile(packedManifestPath, `${JSON.stringify(packedManifest, null, 2)}\n`);
      await rm(tarball);
      await run("tar", ["-czf", tarball, "-C", extracted, "package"]);
      await rm(extracted, { recursive: true, force: true });
    }
    tarballs.set(manifest.name, tarball);
  }
  return tarballs;
}

async function extractCli(cliTarball, target) {
  await mkdir(target, { recursive: true });
  await run("tar", ["-xzf", cliTarball, "-C", target]);
  return join(target, "package", "dist", "index.js");
}

async function makeInstallStub(directory, manager) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, manager);
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
}

async function generateFixture(options, cliEntrypoint, fixtureRoot, fakeBin) {
  await mkdir(join(fixtureRoot, ".git"), { recursive: true });
  const args = [
    cliEntrypoint,
    "init",
    "--cwd",
    fixtureRoot,
    "--framework",
    options.framework,
    "--package-manager",
    options.packageManager,
    "--name",
    `chatpack-${options.framework}-${options.authProvider ?? "api"}-fixture`,
    "--yes",
  ];
  if (options.authProvider) args.push("--auth-provider", options.authProvider);
  await run(process.execPath, args, {
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
  });
}

async function useLocalPackages(fixtureRoot, tarballs, packageManager) {
  const manifestPath = join(fixtureRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const sectionName of ["dependencies", "devDependencies"]) {
    const section = manifest[sectionName] ?? {};
    for (const name of Object.keys(section)) {
      const tarball = tarballs.get(name);
      if (tarball) section[name] = `file:${tarball}`;
    }
  }
  // Pin modern Yarn for this isolated check. The generated application remains
  // manager-version agnostic; this only makes CI exercise one reproducible Yarn.
  if (packageManager === "yarn") manifest.packageManager = `yarn@${yarnVersion}`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function installFixture(manager, fixtureRoot) {
  const commands = {
    npm: ["npm", ["install", "--no-audit", "--no-fund"]],
    pnpm: ["pnpm", ["install", "--frozen-lockfile=false"]],
    yarn: ["corepack", ["yarn", "install"]],
    bun: ["bun", ["install"]],
  };
  const [command, args] = commands[manager];
  const env =
    manager === "yarn"
      ? {
          ...process.env,
          // CI enables immutable installs, and public pull requests also enable
          // hardened mode. This disposable fixture intentionally starts without
          // a lockfile, so its real install must be allowed to create one.
          YARN_ENABLE_HARDENED_MODE: "0",
          YARN_ENABLE_IMMUTABLE_INSTALLS: "0",
        }
      : process.env;
  await run(command, args, { cwd: fixtureRoot, env });
}

function fixtureEnvironment(proxyPort, appPort) {
  const secret = "fixture-secret-that-is-longer-than-thirty-two-characters";
  return {
    ...process.env,
    CI: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    DATABASE_URL:
      process.env.STARTER_DATABASE_URL ??
      "postgresql://postgres:postgres@127.0.0.1:5432/chatpack?sslmode=disable",
    NEON_WS_PROXY: `127.0.0.1:${proxyPort}`,
    WSPROXY_PORT: String(proxyPort),
    BETTER_AUTH_SECRET: secret,
    BETTER_AUTH_URL: `http://127.0.0.1:${appPort}`,
    AUTH_SECRET: secret,
    AUTH_GITHUB_ID: "fixture-github-client",
    AUTH_GITHUB_SECRET: secret,
    AUTH0_DOMAIN: "https://fixture.us.auth0.com",
    AUTH0_CLIENT_ID: "fixture-auth0-client",
    AUTH0_CLIENT_SECRET: secret,
    AUTH0_SECRET: secret,
    APP_BASE_URL: `http://127.0.0.1:${appPort}`,
    PORT: String(appPort),
  };
}

async function validateFixture(options, fixtureRoot) {
  const proxyPort = await freePort();
  const appPort = await freePort();
  const env = fixtureEnvironment(proxyPort, appPort);

  await runPackageScript(options.packageManager, "db:generate", fixtureRoot, env);
  await runPackageScript(options.packageManager, "typecheck", fixtureRoot, env);
  await runPackageScript(options.packageManager, "lint", fixtureRoot, env);
  await runPackageScript(options.packageManager, "build", fixtureRoot, env);

  const [proxyCommand, proxyArgs] = packageScript(options.packageManager, "db:proxy");
  const proxy = start(proxyCommand, proxyArgs, { cwd: fixtureRoot, env });
  try {
    await waitForPort(proxyPort, proxy);
    await runPackageScript(options.packageManager, "db:migrate", fixtureRoot, env);
    await runPackageScript(options.packageManager, "setup:check", fixtureRoot, env);

    const [serverCommand, commandArgs] = packageScript(options.packageManager, "start");
    const server = start(serverCommand, commandArgs, { cwd: fixtureRoot, env });
    try {
      await waitForHttp(`http://127.0.0.1:${appPort}/api/health`, server);
      const unauthorized = await fetch(`http://127.0.0.1:${appPort}/api/chat/conversations`);
      if (unauthorized.status !== 401) {
        throw new Error(`Unauthenticated Chatpack route returned ${unauthorized.status}, not 401.`);
      }
    } finally {
      await stop(server);
    }
  } finally {
    await stop(proxy);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const temporaryRoot = await mkdtemp(join(tmpdir(), "chatpack-generated-starter-"));
  const fixtureRoot = join(temporaryRoot, "fixture");
  try {
    const packDirectory = join(temporaryRoot, "packs");
    await mkdir(packDirectory);
    const tarballs = await packLocalPackages(packDirectory);
    const cliEntrypoint = await extractCli(
      tarballs.get("@chatpack/cli"),
      join(temporaryRoot, "cli"),
    );
    const fakeBin = join(temporaryRoot, "fake-bin");
    await makeInstallStub(fakeBin, options.packageManager);
    await generateFixture(options, cliEntrypoint, fixtureRoot, fakeBin);
    await useLocalPackages(fixtureRoot, tarballs, options.packageManager);
    await installFixture(options.packageManager, fixtureRoot);
    await validateFixture(options, fixtureRoot);
    console.log(
      `Generated ${options.framework}/${options.authProvider ?? "generic"} starter passed with ${options.packageManager}.`,
    );
  } finally {
    for (const child of [...children]) await stop(child);
    if (process.env.CHATPACK_KEEP_FIXTURE === "1") {
      console.log(`Fixture kept at ${fixtureRoot}`);
    } else {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
