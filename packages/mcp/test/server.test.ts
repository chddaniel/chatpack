import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as LegacyStdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { readFile } from "node:fs/promises";

const client = new Client({ name: "chatpack-test", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/cli.js", import.meta.url))],
  cwd: tmpdir(),
  stderr: "pipe",
});
const documentSchema = z.object({ id: z.string(), path: z.string(), content: z.string() });
const metadataSchema = z.object({
  snapshot: z.string().length(64),
  versions: z.record(z.string(), z.string()),
});
function parseText(result: CallToolResult) {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("Expected text result");
  return JSON.parse(first.text);
}

beforeAll(async () => {
  await client.connect(transport);
});
afterAll(async () => {
  await client.close();
});

describe("published stdio entrypoint", () => {
  it("discovers only read-only tools and the reference resource", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_document",
      "get_integration_guide",
      "get_ui_block",
      "list_ui_blocks",
      "search_docs",
    ]);
    expect(
      tools.every(
        (tool) =>
          tool.annotations?.readOnlyHint &&
          !tool.annotations.destructiveHint &&
          !tool.annotations.openWorldHint,
      ),
    ).toBe(true);
    expect((await client.listResources()).resources.map((resource) => resource.uri)).toEqual([
      "chatpack://docs/llms",
    ]);
  });

  it("returns the real authoritative reference and matching package versions", async () => {
    const result = z
      .object({ document: documentSchema })
      .and(metadataSchema)
      .parse(parseText(await client.callTool({ name: "get_document", arguments: { id: "llms" } })));
    expect(result.document.content).toBe(
      await readFile(new URL("../../../llms.txt", import.meta.url), "utf8"),
    );
    const core = JSON.parse(
      await readFile(new URL("../../core/package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(result.versions["@chatpack/core"]).toBe(core.version);
    const resource = await client.readResource({ uri: "chatpack://docs/llms" });
    expect(resource.contents[0]).toMatchObject({
      uri: "chatpack://docs/llms",
      mimeType: "application/json",
    });
    const content = resource.contents[0];
    if (!content || !("text" in content)) throw new Error("Expected text resource");
    expect(
      z.object({ document: documentSchema }).and(metadataSchema).parse(JSON.parse(content.text)),
    ).toEqual(result);
  });

  it("finds troubleshooting and caps search results", async () => {
    const schema = z.object({
      results: z.array(z.object({ id: z.string(), excerpt: z.string() })),
    });
    const found = schema.parse(
      parseText(
        await client.callTool({
          name: "search_docs",
          arguments: { query: "UNAUTHENTICATED", limit: 2 },
        }),
      ),
    );
    expect(found.results.length).toBeGreaterThan(0);
    expect(found.results.length).toBeLessThanOrEqual(2);
    expect(found.results.some((doc) => doc.excerpt.includes("UNAUTHENTICATED"))).toBe(true);
    expect(
      schema.parse(
        parseText(
          await client.callTool({
            name: "search_docs",
            arguments: { query: "zzzznothingmatchesthis" },
          }),
        ),
      ).results,
    ).toEqual([]);
  });

  it.each(["nextjs", "express", "hono", "elysia", "tanstack-start", "bun-deno-workers"])(
    "returns actual %s guide and auth contract",
    async (framework) => {
      const result = z
        .object({ documents: z.array(documentSchema) })
        .parse(
          parseText(
            await client.callTool({ name: "get_integration_guide", arguments: { framework } }),
          ),
        );
      expect(result.documents).toHaveLength(3);
      expect(result.documents.map((doc) => doc.id)).toContain("concepts/authentication");
      const guide = result.documents.find((doc) => doc.id.startsWith("integrations/"));
      expect(guide).toBeDefined();
      expect(guide?.content).toBe(
        await readFile(new URL(`../../../${guide?.path}`, import.meta.url), "utf8"),
      );
    },
  );

  it("retrieves both direct and wildcard UI exports with real source and styles", async () => {
    const result = z
      .object({ blocks: z.array(z.object({ name: z.string(), path: z.string() })) })
      .parse(parseText(await client.callTool({ name: "list_ui_blocks", arguments: {} })));
    expect(result.blocks.map((block) => block.name)).toEqual(
      expect.arrayContaining(["ChatWindow", "ConversationHeader", "ChatpackUIProvider"]),
    );
    expect(result.blocks.map((block) => block.name)).not.toContain("ChatpackUIProviderProps");
    for (const name of ["ChatWindow", "ConversationHeader"]) {
      const block = z
        .object({
          block: z.object({ name: z.string(), path: z.string() }),
          files: z.array(z.object({ path: z.string(), content: z.string() })),
        })
        .parse(
          parseText(
            await client.callTool({
              name: "get_ui_block",
              arguments: { name, includeSupportingFiles: true },
            }),
          ),
        );
      const source = block.files.find((file) => file.path === block.block.path);
      expect(source?.content).toBe(
        await readFile(new URL(`../../../${block.block.path}`, import.meta.url), "utf8"),
      );
      expect(block.files.some((file) => file.path === "packages/ui/styles.css")).toBe(true);
    }
  });

  it("returns only the requested source module by default", async () => {
    const result = z
      .object({ files: z.array(z.object({ path: z.string() })) })
      .parse(
        parseText(
          await client.callTool({ name: "get_ui_block", arguments: { name: "ChatWindow" } }),
        ),
      );
    expect(result.files.map((file) => file.path)).toEqual(["packages/ui/src/blocks.tsx"]);
  });

  it("rejects unbounded inputs and unsupported frameworks", async () => {
    for (const args of [
      { query: " " },
      { query: "chat", limit: 1000 },
      { query: "x".repeat(201) },
    ]) {
      expect((await client.callTool({ name: "search_docs", arguments: args })).isError).toBe(true);
    }
    expect(
      (
        await client.callTool({
          name: "get_integration_guide",
          arguments: { framework: "arbitrary" },
        })
      ).isError,
    ).toBe(true);
  });

  it("treats paths and URLs as catalog ids, with no filesystem or network access", async () => {
    for (const id of ["../../../../etc/passwd", "https://example.com", "file:///etc/passwd"]) {
      const result = await client.callTool({ name: "get_document", arguments: { id } });
      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("Unknown document"),
      });
    }
    expect(
      (await client.callTool({ name: "get_ui_block", arguments: { name: "../../private" } }))
        .isError,
    ).toBe(true);
  });
});

it("serves MCP clients using the 2025 initialize handshake", async () => {
  const legacy = new LegacyClient({ name: "legacy-client", version: "1.0.0" });
  const legacyTransport = new LegacyStdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/cli.js", import.meta.url))],
    cwd: tmpdir(),
    stderr: "pipe",
  });
  try {
    await legacy.connect(legacyTransport);
    expect((await legacy.listTools()).tools).toHaveLength(5);
    const result = await legacy.callTool({
      name: "get_document",
      arguments: { id: "concepts/authentication" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("authentication") }),
    ]);
  } finally {
    await legacy.close();
  }
});
