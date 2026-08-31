import type { DatabaseSync } from "node:sqlite";

/**
 * A choice the request had to carry and did not.
 *
 * Three codes rather than one message: "the provider is wrong" leaves the
 * interface to guess whether nothing was chosen, whether the provider was
 * disconnected since, or whether the model belongs to somebody else — three
 * different sentences, and only the boundary knows which one is true.
 */
export class ProviderChoiceError extends Error {
  code: "PROVIDER_REQUIRED" | "UNKNOWN_PROVIDER" | "UNKNOWN_MODEL";

  constructor(code: "PROVIDER_REQUIRED" | "UNKNOWN_PROVIDER" | "UNKNOWN_MODEL") {
    super(code);
    this.name = "ProviderChoiceError";
    this.code = code;
  }
}

/**
 * The provider and the model exist, or the request is not a request.
 *
 * This is where the invariant "a project has a provider" lives. It cannot live
 * in the schema: `project.provider_id` is nullable and stays that way, because
 * databases already out there hold projects created before the rule, and the
 * only way to make the column NOT NULL would be to pick a model on their
 * owner's behalf.
 *
 * Both create and update call it, and both call it *before* doing anything
 * that would have to be undone.
 */
export function assertProviderChosen(
  db: DatabaseSync,
  providerId: string | null | undefined,
  modelId: string | null | undefined,
): void {
  if (providerId === undefined || providerId === null || providerId === ""
    || modelId === undefined || modelId === null || modelId === "") {
    throw new ProviderChoiceError("PROVIDER_REQUIRED");
  }

  const provider = db.prepare("SELECT 1 AS ok FROM provider WHERE id = ?").get(providerId);
  if (provider === undefined) throw new ProviderChoiceError("UNKNOWN_PROVIDER");

  // The pair, not the model alone: `provider_model` is unique on
  // (provider_id, model_id), so a model that belongs to another endpoint is a
  // different question with the same name.
  const model = db.prepare(
    "SELECT 1 AS ok FROM provider_model WHERE provider_id = ? AND model_id = ?",
  ).get(providerId, modelId);
  if (model === undefined) throw new ProviderChoiceError("UNKNOWN_MODEL");
}
