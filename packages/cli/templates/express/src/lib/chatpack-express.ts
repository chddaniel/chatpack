import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";

import { chat } from "@/lib/chatpack.js";

type ExpressRequest = IncomingMessage & { originalUrl?: string };
const handler = chat.handler();

async function readBody(request: ExpressRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function chatpackExpress(
  request: ExpressRequest,
  response: ServerResponse,
): Promise<void> {
  const url =
    "http://" + (request.headers.host ?? "localhost") + (request.originalUrl ?? request.url ?? "/");
  const body = await readBody(request);
  const webResponse = await handler.fetch(
    new Request(url, {
      method: request.method ?? "GET",
      headers: Object.entries(request.headers).flatMap(([name, value]) =>
        value === undefined
          ? []
          : Array.isArray(value)
            ? value.map((item): [string, string] => [name, item])
            : [[name, value] as [string, string]],
      ),
      body: body.length ? new Uint8Array(body) : null,
    }),
  );
  response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()));
  if (webResponse.body) {
    const reader = webResponse.body.getReader();
    request.on("close", () => void reader.cancel().catch(() => undefined));
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      response.write(value);
    }
  }
  response.end();
}
