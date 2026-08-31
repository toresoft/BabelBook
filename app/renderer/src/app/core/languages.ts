/**
 * The languages a book can be translated into.
 *
 * Declared once because two screens offer them — the one that creates a
 * project and the one that edits it — and a list that drifted between the two
 * would let a project be created in a language it could never be edited back to.
 */
export const TARGET_LANGUAGES = ["it", "en", "fr", "de", "es", "pt"] as const;
