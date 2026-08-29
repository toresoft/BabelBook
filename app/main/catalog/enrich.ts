import type { ProviderModel } from "../../shared/dto.ts";
import type { CatalogProvider } from "./shape.ts";

/**
 * The merge the whole design rests on: the endpoint says which models exist,
 * the catalogue says what they cost and what they can do.
 *
 * Neither outranks the other. A model the endpoint serves and the catalogue
 * has never heard of is kept, priced at null — the list is the endpoint's,
 * the metadata is the catalogue's, and neither is invented here.
 */
export function enrichModels(ids: string[], entry: CatalogProvider | null): ProviderModel[] {
  return ids.map((id) => {
    const known = entry?.models.find((model) => model.id === id) ?? null;
    return {
      id,
      displayName: known?.name ?? id,
      contextWindow: known?.limit.context ?? null,
      priceIn: known?.cost?.input ?? null,
      priceOut: known?.cost?.output ?? null,
      capabilities: known === null ? null : {
        toolCall: known.toolCall,
        reasoning: known.reasoning,
        structuredOutput: known.structuredOutput,
        attachment: known.attachment,
      },
      reasoningLevel: null,
    };
  });
}
