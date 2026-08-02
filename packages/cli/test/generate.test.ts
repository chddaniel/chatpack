import { describe, expect, it } from "vitest";

import {
  renderExpressIntegration,
  renderHonoIntegration,
  renderNextRoute,
  renderServer,
} from "../src/generate";
import { parseSource } from "../src/project/inspect";
import type { SetupAnswers } from "../src/types";

const answers: SetupAnswers = {
  framework: "next",
  adapter: "memory",
  packageManager: "pnpm",
  client: false,
};

describe("generated setup", () => {
  it("creates one HMR-safe server instance and a catch-all route", () => {
    const server = renderServer(answers, "typescript");
    const route = renderNextRoute(
      "/tmp/src/app/api/chat/[...chatpack]/route.ts",
      "/tmp/src/lib/chatpack.server.ts",
      "typescript",
    );
    expect(server).toContain("globalThis");
    expect(server).toContain("memoryAdapter()");
    expect(route).toContain("GET, POST, PATCH, DELETE");
    expect(route).toContain('from "../../../../lib/chatpack.server.js"');
    expect(route).not.toContain("chatpack.server.ts");
    expect(() => parseSource("chatpack.server.ts", server)).not.toThrow();
    expect(() => parseSource("route.ts", route)).not.toThrow();
  });

  it("generates a streaming Express bridge", () => {
    const source = renderExpressIntegration("/tmp/src/lib/chatpack.server.ts", "typescript");
    expect(source).toContain("originalUrl");
    expect(source).toContain("response.body.getReader");
    expect(() => parseSource("chatpack.express.ts", source)).not.toThrow();
  });

  it("generates valid JavaScript for the Express bridge", () => {
    const source = renderExpressIntegration("/tmp/src/lib/chatpack.server.js", "javascript");
    expect(source).not.toContain("chunks: Buffer[]");
    expect(source).not.toContain(": [string, string]");
    expect(source).not.toContain(" as [string, string]");
    expect(() => parseSource("chatpack.express.js", source)).not.toThrow();
  });

  it("uses native ESM extensions for generated JavaScript imports", () => {
    const hono = renderHonoIntegration("/tmp/src/lib/chatpack.server.js", "javascript");
    const express = renderExpressIntegration("/tmp/src/lib/chatpack.server.js", "javascript");
    expect(hono).toContain('from "./chatpack.server.js"');
    expect(express).toContain('from "./chatpack.server.js"');
  });

  it("does not emit TypeScript auth syntax in JavaScript", () => {
    const source = renderServer(
      {
        ...answers,
        auth: { path: "./auth.mjs", exportName: "getUser", idProperty: "id" },
      },
      "javascript",
    );
    expect(source).toContain('from "./auth.mjs"');
    expect(source).toContain("async function resolveChatpackUser(request) {");
    expect(source).not.toContain("request: Request");
    expect(() => parseSource("chatpack.server.js", source)).not.toThrow();
  });
});
