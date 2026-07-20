/**
 * Project slug rules, kept free of filesystem and store imports so every layer
 * (HTTP, MCP, store) can share one definition of what a slug is.
 *
 * A slug names a page under the brain's projects directory. It is not a path:
 * writing "projects/genai-monitoring" where "genai-monitoring" belongs splits a
 * project's history in two, because nothing downstream can match the two forms.
 */

/** Only well-formed slugs may touch the filesystem / shell. */
export function isValidProjectId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,80}$/i.test(id);
}

/**
 * Coerce a caller's project value to the canonical slug, or null when it carries
 * no project at all. Handles the accidents seen in practice — a brain path or a
 * filename instead of a slug, stray case, spaces or underscores for hyphens.
 * Returns null when nothing valid survives, so callers can reject explicitly
 * rather than persist a value no lookup will ever match.
 */
export function normalizeProjectId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  // A trailing separator means the value names a directory, not a project — there
  // is no slug in "projects/", and the container's name is not one.
  if (/[\\/]$/.test(trimmed)) return null;

  // A path where a slug belongs: keep the last segment, drop a .md extension.
  const basename = trimmed.split(/[\\/]/).filter((part) => part !== "").pop() ?? "";
  const slug = basename
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");

  return slug !== "" && isValidProjectId(slug) ? slug : null;
}
