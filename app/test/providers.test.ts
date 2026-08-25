import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import {
  createProvider, deleteProvider, getProvider, listProviders, PRESETS, readKey, updateProvider,
} from "../main/providers/store.ts";

/**
 * A stand-in for the keyring that actually hides what it is given.
 *
 * Base64 rather than a `enc:` prefix over the plaintext: a fake whose output
 * still contains the key cannot be used to check that the key is not stored in
 * the clear, which is the one thing this suite exists to check.
 */
const crypto = {
  isAvailable: () => true,
  encrypt: (plain: string) => Buffer.from(Buffer.from(`enc:${plain}`, "utf8").toString("base64"), "utf8"),
  decrypt: (blob: Buffer) => Buffer.from(blob.toString("utf8"), "base64").toString("utf8").replace(/^enc:/, ""),
};

function db() {
  const d = openDatabase(":memory:");
  migrate(d, loadMigrations("app/main/db/migrations"));
  return d;
}

const acme = {
  name: "Acme", route: "acme", baseUrl: "https://api.acme.test/v1",
  headers: {}, options: {},
  models: [{ id: "m1", displayName: "M1", contextWindow: 128_000, priceIn: 1, priceOut: 5 }],
};

describe("providers", () => {
  it("never stores the key in the clear", () => {
    const d = db();
    const p = createProvider(d, crypto, { ...acme, apiKey: "sk-secret" });
    const row = d.prepare("SELECT api_key_encrypted FROM provider WHERE id = ?")
      .get(p.id) as { api_key_encrypted: Uint8Array };
    // node:sqlite hands a BLOB back as a plain Uint8Array, whose
    // `toString("utf8")` is a comma-joined list of decimal byte values: read
    // that way the assertion would hold even on a key written in the clear.
    // Copying into a Buffer first is what makes it mean what it says.
    expect(Buffer.from(row.api_key_encrypted).toString("utf8")).not.toContain("sk-secret");
    expect(readKey(d, crypto, p.id)).toBe("sk-secret");
  });

  it("tells the renderer whether a key is there, and nothing more", () => {
    const d = db();
    createProvider(d, crypto, { ...acme, apiKey: "sk-secret" });
    const listed = listProviders(d);
    expect(listed[0].hasKey).toBe(true);
    expect(JSON.stringify(listed)).not.toContain("sk-secret");
  });

  it("keeps the existing key when an update does not carry one", () => {
    const d = db();
    const p = createProvider(d, crypto, { ...acme, apiKey: "sk-secret" });
    updateProvider(d, crypto, p.id, { name: "Acme Inc" });
    expect(readKey(d, crypto, p.id)).toBe("sk-secret");
  });

  it("refuses to store a key when the OS keyring is unavailable", () => {
    const d = db();
    const unavailable = { ...crypto, isAvailable: () => false };
    expect(() => createProvider(d, unavailable, { ...acme, apiKey: "sk-secret" }))
      .toThrow(/KEYRING_UNAVAILABLE/);
  });

  it("clears the key only when clearing is said on purpose", () => {
    const d = db();
    const p = createProvider(d, crypto, { ...acme, apiKey: "sk-secret" });
    updateProvider(d, crypto, p.id, { apiKey: null });
    expect(readKey(d, crypto, p.id)).toBeNull();
    expect(getProvider(d, p.id)!.hasKey).toBe(false);
  });

  it("takes a provider and its models away together", () => {
    const d = db();
    const p = createProvider(d, crypto, { ...acme, apiKey: "sk-secret" });
    expect(deleteProvider(d, p.id)).toBe(true);
    expect(getProvider(d, p.id)).toBeNull();
    expect(d.prepare("SELECT count(*) AS n FROM provider_model").get()).toMatchObject({ n: 0 });
  });

  it("ships a preset that reaches any OpenAI-compatible endpoint", () => {
    expect(PRESETS.map((p) => p.name)).toContain("OpenAI-compatible");
    const deepseek = PRESETS.find((p) => p.route === "deepseek")!;
    expect(deepseek.options).toMatchObject({ deepseek: { thinking: { type: "disabled" } } });
  });
});
