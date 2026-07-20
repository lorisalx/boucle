import type { Provider } from "./providers/types.ts";
import type { TicketKind } from "./store.ts";

const KINDS = new Set<TicketKind>(["task", "idea", "conv", "scope"]);

function responseText(content: Awaited<ReturnType<Provider["chat"]>>["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part.text ?? "").join("\n");
}

// Ordered by specificity. Each entry is [kind, prefixes/words]. A word is matched when it
// appears at a word boundary in the lowercased title. Keep the lists short and high-precision:
// false positives are worse than falling back to "idea".
const KEYWORD_RULES: Array<[TicketKind, RegExp]> = [
  // "scope" first — a design or plan is worth calling out before we see "task" keywords.
  [
    "scope",
    /\b(plan|design|spec|rfc|roadmap|strategy|research|architecture|proposal|blueprint|initiative|epic|breakdown)\b/,
  ],
  // "conv" — any pointer to a conversation or meeting.
  [
    "conv",
    /\b(call|meeting|sync|chat|discuss|catch[- ]up|talked|interviewed|debrief|standup|retro|review session)\b/,
  ],
  // "task" — imperative verbs that signal an actionable item.
  [
    "task",
    /\b(fix|add|update|implement|create|remove|delete|write|build|deploy|set[- ]?up|refactor|migrate|ship|launch|release|enable|disable|configure|test|validate|send|schedule|book|pay|review|approve|merge|rebase|rename|move|extract|document|upgrade|downgrade|install|uninstall|integrate|automate|monitor|alert|debug|investigate|analyse|analyze|close|open|publish|draft|finalize|prepare|submit|register|cancel)\b/,
  ],
];

/**
 * Classify a capture title using keyword rules, without calling any provider.
 * Returns `null` when no rule fires so callers can decide the fallback themselves.
 */
export function inferCaptureKindOffline(title: string): TicketKind | null {
  const lower = title.toLowerCase();
  for (const [kind, re] of KEYWORD_RULES) {
    if (re.test(lower)) return kind;
  }
  return null;
}

/** Infer the same four kinds used by smart capture.
 *
 * When the provider is configured the LLM classifies the title; this is more accurate and
 * understands project context. When the provider is absent or the call fails, a lightweight
 * keyword heuristic fires instead of always returning "idea", so Auto kind remains useful
 * without an API key (e.g. during self-hosted setup or with a local-only runner).
 */
export async function inferCaptureKind(
  provider: Provider,
  title: string,
  project: string | null,
): Promise<TicketKind> {
  if (!provider.isConfigured()) {
    return inferCaptureKindOffline(title) ?? "idea";
  }
  try {
    const projectHint = project ? `\nProject hint: ${project}` : "";
    const response = await provider.chat([
      {
        role: "system",
        content: "Classify one Boucle capture. Reply with exactly one lowercase label: task, idea, conv, or scope. " +
          "task is actionable; idea is worth remembering but not yet actionable; conv points to a conversation; " +
          "scope is a larger design or body of work to break down.",
      },
      { role: "user", content: `Capture: ${title}${projectHint}` },
    ], []);
    const match = responseText(response.content).toLowerCase().match(/\b(task|idea|conv|scope)\b/);
    const kind = match?.[1] as TicketKind | undefined;
    return kind && KINDS.has(kind) ? kind : "idea";
  } catch {
    // Provider call failed; fall back to offline heuristics rather than blindly returning "idea".
    return inferCaptureKindOffline(title) ?? "idea";
  }
}
