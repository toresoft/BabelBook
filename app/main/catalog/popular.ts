/**
 * The providers this application puts first.
 *
 * Not a catalogue fact: models.dev carries no notion of popularity, and this
 * is an opinion about what someone translating a book should try before the
 * other hundred and ninety. It lives in the code for the same reason
 * `routeDefaults` does — it is a statement about how this application behaves,
 * not about what the endpoint serves.
 *
 * The order is the order shown. A test holds that each is still in the
 * catalogue and still has its sentence; nothing can hold that it is still a
 * good answer, and that stays a decision to revisit.
 */
export const POPULAR: readonly string[] = [
  "anthropic", "openai", "google", "openrouter", "mistral",
  "groq", "xai", "deepseek", "togetherai", "cerebras",
];
