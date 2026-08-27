import { describe, expect, it, vi } from "vitest";
import { PROVIDER_PACKAGES } from "../engine/backends/registry.ts";
import { parseSpec, resolveModel } from "../engine/backends/resolve.ts";
import { sdkBackend } from "../engine/backends/sdk.ts";

const fakeModule = { createAcme: (opts: unknown) => (id: string) => ({ id, opts }) };
const packages = {
  acme: { specifier: "@ai-sdk/acme", load: async () => fakeModule },
  broken: {
    specifier: "@ai-sdk/broken",
    load: async () => { throw new Error("Cannot find package '@ai-sdk/broken'"); },
  },
};

describe("parseSpec", () => {
  it("cuts at the first colon, because model ids carry their own", () => {
    expect(parseSpec("bedrock:arn:aws:foo:0")).toEqual({ route: "bedrock", id: "arn:aws:foo:0" });
  });

  it("refuses a spec with no route", () => {
    expect(() => parseSpec("claude-opus")).toThrow(/MISSING_ROUTE/);
  });

  it("refuses a route that could not be a package name", () => {
    expect(() => parseSpec("../evil:m1")).toThrow(/INVALID_ROUTE/);
  });

  it("refuses a route with no model after it", () => {
    expect(() => parseSpec("acme:")).toThrow(/MISSING_ID/);
  });
});

describe("resolveModel", () => {
  it("fails before anything is opened when the package is absent", async () => {
    await expect(resolveModel("broken:m1", { packages, apiKey: "k", baseUrl: null }))
      .rejects.toMatchObject({ code: "PACKAGE_MISSING" });
  });

  it("fails when the key is missing, naming the provider", async () => {
    await expect(resolveModel("acme:m1", { packages, apiKey: null, baseUrl: null }))
      .rejects.toMatchObject({ code: "MISSING_KEY", spec: "acme:m1" });
  });

  it("lets a keyless endpoint through when it was given a base URL", async () => {
    const resolved = await resolveModel("acme:m1", {
      packages, apiKey: null, baseUrl: "http://localhost:11434/v1",
    });
    expect((resolved.model as { opts: { baseURL: string } }).opts.baseURL)
      .toBe("http://localhost:11434/v1");
  });

  it("carries the provider options into the resolved model", async () => {
    const resolved = await resolveModel("acme:m1", {
      packages, apiKey: "k", baseUrl: null, options: { acme: { thinking: { type: "disabled" } } },
    });
    expect(resolved.modelId).toBe("acme:m1");
    expect(resolved.options).toMatchObject({ acme: { thinking: { type: "disabled" } } });
  });

  it("hands the factory the id after the route, not the whole spec", async () => {
    const resolved = await resolveModel(
      "acme:arn:aws:foo:0", { packages, apiKey: "k", baseUrl: null },
    );
    expect((resolved.model as { id: string }).id).toBe("arn:aws:foo:0");
  });

  it("says so when the package serves no provider factory", async () => {
    const empty = async () => ({ somethingElse: 1 });
    const emptyPackages = {
      acme: { specifier: "@ai-sdk/acme", load: empty },
    };
    await expect(resolveModel("acme:m1", {
      packages: emptyPackages, apiKey: "k", baseUrl: null,
    }))
      .rejects.toMatchObject({ code: "FACTORY_MISSING" });
  });

  it("refuses a route the registry does not name, before anything is loaded", async () => {
    await expect(resolveModel("nowhere:m1", { packages, apiKey: "k", baseUrl: null }))
      .rejects.toThrow(/UNSUPPORTED_ROUTE/);
  });

  it("finds a factory for every route the registry names", async () => {
    const failures: string[] = [];

    for (const route of Object.keys(PROVIDER_PACKAGES)) {
      try {
        // A key that is never used: building a model does not call the endpoint,
        // and no test of this suite may.
        const resolved = await resolveModel(`${route}:a-model`, {
          apiKey: "not-a-real-key", baseUrl: null,
        });
        expect(resolved.modelId).toBe(`${route}:a-model`);
        expect((resolved.model as { specificationVersion?: string }).specificationVersion)
          .toBe("v4");
      } catch (error) {
        // FACTORY_FAILED is an allowed answer, and the reason this test asserts
        // on codes rather than on success: Bedrock wants a region, Vertex a
        // project, and refusing a model without them is correct behaviour. That
        // refusal still proves what is being tested — the package loaded and its
        // factory was found. UNSUPPORTED_ROUTE or PACKAGE_MISSING would not.
        const code = (error as { code?: string }).code;
        if (code !== "FACTORY_FAILED") {
          failures.push(`${route}: ${code ?? "?"} — ${(error as Error).message}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });
});

describe("sdkBackend", () => {
  it("passes the options through and reports the finish reason", async () => {
    const generate = vi.fn().mockResolvedValue({
      text: "Uno", usage: { inputTokens: 10, outputTokens: 3 }, finishReason: "stop",
    });
    const backend = sdkBackend({ model: {}, modelId: "acme:m1", options: { acme: {} } }, generate);
    const result = await backend.call({ prompt: "One" });
    expect(result).toMatchObject({ text: "Uno", tokensIn: 10, tokensOut: 3, finishReason: "stop" });
    expect(generate.mock.calls[0][0].providerOptions).toEqual({ acme: {} });
  });

  it("reports truncation as such, so the engine can split the chunk", async () => {
    const generate = vi.fn().mockResolvedValue({
      text: "Un", usage: { inputTokens: 10, outputTokens: 4096 }, finishReason: "length",
    });
    const backend = sdkBackend({ model: {}, modelId: "acme:m1" }, generate);
    expect((await backend.call({ prompt: "One" })).finishReason).toBe("length");
  });

  it("calls every other finish reason other, rather than inventing one", async () => {
    const generate = vi.fn().mockResolvedValue({ text: "", finishReason: "content-filter" });
    const backend = sdkBackend({ model: {}, modelId: "acme:m1" }, generate);
    const result = await backend.call({ prompt: "One" });
    // A usage the provider omitted counts as zero, never as NaN: the run
    // summary adds these up, and one NaN poisons the whole total.
    expect(result).toMatchObject({ finishReason: "other", tokensIn: 0, tokensOut: 0 });
  });
});
