# @chatpack/mcp

A read-only MCP server for coding agents integrating Chatpack. It includes the
repository's documentation, authoritative `llms.txt` reference, framework guides,
and React UI source. It runs locally over stdio and needs Node.js 20 or later.

The server uses bundled content and makes no network requests. Each response
includes a content snapshot hash and the package versions represented by the
snapshot. Compare these versions with your installed Chatpack packages. For an
installed package, its own `llms.txt` remains the authoritative reference.

## Connect

After this package is published, add it to your MCP client's server configuration:

```json
{
  "mcpServers": {
    "chatpack": {
      "command": "npx",
      "args": ["-y", "@chatpack/mcp"]
    }
  }
}
```

The exact configuration location depends on your client. Pin the MCP package
version when you need a repeatable documentation snapshot.

To try it from this repository before publication:

```sh
pnpm install
pnpm --filter @chatpack/mcp build
```

Set your client's command to `node` and its arguments to the absolute path of
`packages/mcp/dist/cli.js`. The process reserves stdout for MCP messages.

## Tools

| Tool                    | Input                                       | Result                                                                 |
| ----------------------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| `search_docs`           | `query`, optional `limit` (1–20, default 5) | Matching document ids, links, and excerpts                             |
| `get_document`          | `id`                                        | Complete document; `llms` returns the integration reference            |
| `get_integration_guide` | `framework`                                 | Framework setup guide, authentication guide, and integration reference |
| `list_ui_blocks`        | None                                        | Public runtime exports from `@chatpack/ui`                             |
| `get_ui_block`          | `name`, optional `includeSupportingFiles`   | Source module, supporting UI source, stylesheet, and usage guide       |

Supported framework values: `nextjs`, `express`, `hono`, `elysia`,
`tanstack-start`, and `bun-deno-workers`.

The `chatpack://docs/llms` resource also provides the integration reference.
For troubleshooting, search for an error code such as `UNAUTHENTICATED`, then
read the matching document. The server returns guidance; it does not inspect
or change your application's configuration.

UI source files share helpers and public client contracts. Prefer installing
`@chatpack/ui` and following the returned usage guide when using its components.
Set `includeSupportingFiles` to `true` to include the package's UI modules and
stylesheet when tracing imports. By default, the response includes only the
export's implementation module and usage guide.

## Scope and releases

The server reads only its built-in catalog. It does not read your project files,
run commands, accept arbitrary URLs or paths, or access conversations, messages,
authentication credentials, or databases.

`pnpm --filter @chatpack/mcp test` builds the package and exercises its stdio
entrypoint through an MCP client. Build and prepack regenerate the catalog from
repository sources. Changes to bundled documentation or UI source require a new
MCP release to reach clients.
