import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { probeLocalRuntimes } from "../main/catalog/local.ts";

/**
 * Two runtimes that are not running: everything here is served by in-process
 * fakes on the ports the probe is told to look at. The one thing this suite
 * cannot certify is a real Ollama or LM Studio answering — the plan says so,
 * and that check has to happen against live servers before the task is called
 * done.
 */
interface Fake {
  server: Server;
  port: number;
  seen: Array<{ authorization?: string }>;
}

async function serving(models: string[]): Promise<Fake> {
  const seen: Fake["seen"] = [];
  const server = createServer((req, res) => {
    seen.push({ authorization: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port, seen };
}

/** A port where nothing listens: bound, then released. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const open: Array<Server> = [];
afterEach(async () => {
  while (open.length > 0) {
    const server = open.pop()!;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("probing for local runtimes", () => {
  it("finds both when both answer, with the models each server declares", async () => {
    // Deliberately not the three models the catalogue lists for `lmstudio`:
    // the list must come from the running server, not from what somebody
    // catalogued somewhere.
    const ollama = await serving(["gemma3:12b", "my-own-finetune:latest"]);
    const lmstudio = await serving(["a-model-only-i-have"]);
    open.push(ollama.server, lmstudio.server);

    const found = await probeLocalRuntimes({
      ports: { ollama: ollama.port, lmstudio: lmstudio.port },
    });

    expect(found).toEqual([
      {
        id: "ollama", name: "Ollama",
        baseUrl: `http://127.0.0.1:${ollama.port}/v1`,
        apiKey: "ollama",
        models: ["gemma3:12b", "my-own-finetune:latest"],
      },
      {
        id: "lmstudio", name: "LM Studio",
        baseUrl: `http://127.0.0.1:${lmstudio.port}/v1`,
        apiKey: null,
        models: ["a-model-only-i-have"],
      },
    ]);
  });

  it("sends the key Ollama wants and none for LM Studio", async () => {
    const ollama = await serving(["x"]);
    const lmstudio = await serving(["y"]);
    open.push(ollama.server, lmstudio.server);

    await probeLocalRuntimes({ ports: { ollama: ollama.port, lmstudio: lmstudio.port } });

    // The documented difference between the two: Ollama requires a key in the
    // header and ignores its value, LM Studio takes none.
    expect(ollama.seen[0]!.authorization).toBe("Bearer ollama");
    expect(lmstudio.seen[0]!.authorization).toBeUndefined();
  });

  it("treats a closed port as an absent runtime, not an error", async () => {
    const found = await probeLocalRuntimes({
      ports: { ollama: await closedPort(), lmstudio: await closedPort() },
    });
    expect(found).toEqual([]);
  });

  it("keeps the wait short: a port that never answers is absent, fast", async () => {
    const silent = createServer(() => {
      /* listens, never answers */
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    open.push(silent);
    const port = (silent.address() as AddressInfo).port;

    const started = performance.now();
    const found = await probeLocalRuntimes({
      ports: { ollama: port, lmstudio: await closedPort() },
      timeoutMs: 100,
    });

    expect(found).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
