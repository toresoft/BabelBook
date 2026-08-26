import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { discoverModels } from "../main/catalog/discover.ts";

/**
 * A fake endpoint, in-process. Every fact this suite checks is a fact about
 * what babelBook does with an answer, so the answer is manufactured here and
 * the network is never reached.
 */
interface Fake {
  server: Server;
  /** A base URL with a `/v1`, as the OpenAI-compatible convention writes it. */
  baseUrl: string;
  seen: Array<{ url: string; authorization?: string }>;
}

async function serving(
  handler: (req: Fake["seen"][number], res: import("node:http").ServerResponse) => void,
): Promise<Fake> {
  const seen: Fake["seen"] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", authorization: req.headers.authorization });
    handler(seen[seen.length - 1]!, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    seen,
  };
}

const open: Array<Server> = [];
afterEach(async () => {
  while (open.length > 0) {
    const server = open.pop()!;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

describe("discovering what an endpoint serves", () => {
  it("turns an OpenAI-shaped answer into a list of model ids", async () => {
    const fake = await serving((_req, res) => json(res, 200, {
      data: [{ id: "acme-mini" }, { id: "acme-large" }],
    }));
    open.push(fake.server);

    const found = await discoverModels({ baseUrl: fake.baseUrl, apiKey: "sk-test" });

    expect(found).toEqual([
      { id: "acme-mini", source: "endpoint" },
      { id: "acme-large", source: "endpoint" },
    ]);
    // The key rides the standard header, and the path is the one convention
    // settled on: the base URL's own `/v1`, then `/models`.
    expect(fake.seen[0]).toEqual({ url: "/v1/models", authorization: "Bearer sk-test" });
  });

  it("asks without a key when none is given, as LM Studio expects", async () => {
    const fake = await serving((_req, res) => json(res, 200, { data: [{ id: "local-model" }] }));
    open.push(fake.server);

    const found = await discoverModels({ baseUrl: fake.baseUrl, apiKey: null });
    expect(found).toEqual([{ id: "local-model", source: "endpoint" }]);
    expect(fake.seen[0]!.authorization).toBeUndefined();
  });

  it("reduces a 401 to a code, never to the provider's own words", async () => {
    const fake = await serving((_req, res) => json(res, 401, {
      error: { message: "Incorrect API key provided: sk-test" },
    }));
    open.push(fake.server);

    const failure = await discoverModels({ baseUrl: fake.baseUrl, apiKey: "sk-wrong" })
      .then(() => null, (error: { code?: string }) => error);
    expect(failure).not.toBeNull();
    expect(failure!.code).toBe("unauthorized");
    // The provider's sentence, which quotes the key back, stops at the door.
    expect((failure as Error).message).not.toContain("sk-wrong");
  });

  it("says unreachable when nothing answers on the port", async () => {
    const fake = await serving((_req, res) => json(res, 200, { data: [] }));
    const baseUrl = fake.baseUrl;
    fake.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));

    const failure = await discoverModels({ baseUrl, apiKey: null })
      .then(() => null, (error: { code?: string }) => error);
    expect(failure).not.toBeNull();
    expect(failure!.code).toBe("unreachable");
  });

  it("refuses an answer that is not a model list, rather than reading it as empty", async () => {
    for (const body of [
      "<html>gateway error</html>",     // not JSON at all
      "{}",                              // JSON, but no list to read
      '{ "data": "acme" }',              // a list that is not one
      '{ "data": [{ "name": "no id" }] }', // models that cannot be named
    ]) {
      const fake = await serving((_req, res) => json(res, 200, body));
      open.push(fake.server);

      const failure = await discoverModels({ baseUrl: fake.baseUrl, apiKey: null })
        .then(() => null, (error: { code?: string }) => error);
      // "No models" is an answer; "I could not read the answer" is a failure.
      // They must not share a screen sentence.
      expect(failure).not.toBeNull();
      expect(failure!.code).toBe("bad-response");
    }
  });

  it("takes an empty list for what it is: an endpoint that serves nothing", async () => {
    const fake = await serving((_req, res) => json(res, 200, { data: [] }));
    open.push(fake.server);

    expect(await discoverModels({ baseUrl: fake.baseUrl, apiKey: null })).toEqual([]);
  });

  it("stops waiting: a port that never answers is unreachable, not a frozen screen", async () => {
    const fake = await serving(() => {
      /* accepts the connection and never answers */
    });
    open.push(fake.server);

    const failure = await discoverModels({
      baseUrl: fake.baseUrl, apiKey: null, timeoutMs: 100,
    }).then(() => null, (error: { code?: string }) => error);
    expect(failure).not.toBeNull();
    expect(failure!.code).toBe("unreachable");
  });
});
