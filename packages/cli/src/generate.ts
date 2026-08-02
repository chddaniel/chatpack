import { dirname, relative, resolve } from "node:path";

import type { Language, SetupAnswers } from "./types";

function ext(language: Language): string {
  return language === "typescript" ? ".ts" : ".js";
}

function importPath(from: string, target: string): string {
  const normalized = relative(dirname(from), target).replaceAll("\\", "/");
  const hasRuntimeExtension = /\.(?:c?js|mjs|jsx)$/.test(normalized);
  const extensionless = hasRuntimeExtension
    ? normalized
    : normalized.replace(/\.[cm]?[jt]sx?$/, "");
  const value = hasRuntimeExtension ? normalized : `${extensionless}.js`;
  return value.startsWith(".") ? value : `./${value}`;
}

function authBlock(answers: SetupAnswers, language: Language): string {
  if (!answers.auth) {
    const type = language === "typescript" ? ": Request" : "";
    return `function resolveChatpackUser(_request${type}) {
  // TODO: connect this function to your application authentication.
  // Return { id: userId } for an authenticated request, or null otherwise.
  return null;
}
`;
  }
  const property = answers.auth.idProperty || "id";
  const type = language === "typescript" ? ": Request" : "";
  return `import { ${answers.auth.exportName} as resolveUser } from "${answers.auth.path}";

async function resolveChatpackUser(request${type}) {
  const user = await resolveUser(request);
  return user ? { id: String(user.${property}) } : null;
}
`;
}

function storageBlock(answers: SetupAnswers): { imports: string; value: string } {
  if (answers.adapter === "memory") {
    return {
      imports: 'import { memoryAdapter } from "@chatpack/adapter-memory";',
      value: "memoryAdapter()",
    };
  }
  if (!answers.database) throw new Error("Drizzle setup requires a database module and export.");
  return {
    imports: `import { drizzleAdapter } from "@chatpack/adapter-drizzle";
import { ${answers.database.exportName} as db } from "${answers.database.path}";`,
    value: "drizzleAdapter(db)",
  };
}

export function serverPath(sourceRoot: string, language: Language): string {
  return resolve(sourceRoot, "lib", `chatpack.server${ext(language)}`);
}

export function renderServer(answers: SetupAnswers, language: Language): string {
  const storage = storageBlock(answers);
  const isTs = language === "typescript";
  const coreImport = isTs
    ? 'import { chatpack, type ChatpackInstance } from "@chatpack/core";'
    : 'import { chatpack } from "@chatpack/core";';
  const guard = isTs
    ? `const globalState = globalThis as typeof globalThis & { __chatpack__?: ChatpackInstance };
export const chat = (globalState.__chatpack__ ??= chatpack({
  storage: ${storage.value},
  auth: resolveChatpackUser,
}));`
    : `const globalState = globalThis;
export const chat = (globalState.__chatpack__ ??= chatpack({
  storage: ${storage.value},
  auth: resolveChatpackUser,
}));`;
  return `${coreImport}
${storage.imports}
${authBlock(answers, language)}
${guard}
`;
}

export function nextRoutePath(sourceRoot: string, language: Language): string {
  return resolve(sourceRoot, "app", "api", "chat", "[...chatpack]", `route${ext(language)}`);
}

export function renderNextRoute(routePath: string, serverFile: string, language: Language): string {
  const path = importPath(routePath, serverFile);
  const helper =
    language === "typescript"
      ? 'import { toNextRouteHandlers } from "@chatpack/next";'
      : 'import { toNextRouteHandlers } from "@chatpack/next";';
  return `${helper}
import { chat } from "${path}";

export const { GET, POST, PATCH, DELETE } = toNextRouteHandlers(chat);
`;
}

export function renderHonoIntegration(serverFile: string, language: Language): string {
  const integrationFile = resolve(dirname(serverFile), `chatpack.hono${ext(language)}`);
  const path = importPath(integrationFile, serverFile);
  return `import { chat } from "${path}";

// Import chatpackHandler in your Hono entrypoint and mount it on /api/chat/*.
export const chatpackHandler = chat.handler();
`;
}

export function renderExpressIntegration(serverFile: string, language: Language): string {
  const integrationFile = resolve(dirname(serverFile), `chatpack.express${ext(language)}`);
  const path = importPath(integrationFile, serverFile);
  const types =
    language === "typescript"
      ? 'import type { IncomingMessage, ServerResponse } from "node:http";\n'
      : "";
  const annotations =
    language === "typescript" ? "req: ExpressRequest, res: ServerResponse" : "req, res";
  return `import { Buffer } from "node:buffer";
${types}import { chat } from "${path}";

${language === "typescript" ? "type ExpressRequest = IncomingMessage & { originalUrl?: string };\n" : ""}

const handler = chat.handler();

async function readBody(req${language === "typescript" ? ": ExpressRequest" : ""}) {
  const chunks${language === "typescript" ? ": Buffer[]" : ""} = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function chatpackExpress(${annotations}) {
  const url = "http://" + (req.headers.host ?? "localhost") + (req.originalUrl ?? req.url ?? "/");
  const body = await readBody(req);
  const request = new Request(url, {
    method: req.method ?? "GET",
    headers: Object.entries(req.headers).flatMap(([name, value]) =>
      value === undefined ? [] : Array.isArray(value)
        ? value.map(${language === "typescript" ? "(item): [string, string] =>" : "(item) =>"} [name, item])
        : ${language === "typescript" ? "[[name, value] as [string, string]]" : "[[name, value]]"},
    ),
    body: body.length ? new Uint8Array(body) : null,
  });
  const response = await handler.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body) {
    const reader = response.body.getReader();
    req.on("close", () => void reader.cancel().catch(() => {}));
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {
      // Client disconnected.
    }
  }
  res.end();
}
`;
}

export function clientPath(sourceRoot: string, language: Language): string {
  return resolve(sourceRoot, "lib", `chatpack.client${ext(language)}`);
}

export function renderClient(language: Language): string {
  const directive = language === "typescript" ? '"use client";\n\n' : '"use client";\n\n';
  return `${directive}import { createChatClient } from "@chatpack/client";

export const chatClient = createChatClient({
  credentials: "include",
});
`;
}

export function schemaPath(sourceRoot: string, language: Language): string {
  return resolve(sourceRoot, "db", `chatpack.schema${ext(language)}`);
}

export function renderSchema(): string {
  return `// Add this module to your Drizzle schema configuration.
export * from "@chatpack/adapter-drizzle";
`;
}
