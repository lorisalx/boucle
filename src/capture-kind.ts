import type { Provider } from "./providers/types.ts";
import type { TicketKind } from "./store.ts";

const KINDS = new Set<TicketKind>(["task", "idea", "conv", "scope"]);

function responseText(content: Awaited<ReturnType<Provider["chat"]>>["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part.text ?? "").join("\n");
}

/** Infer the same four kinds used by smart capture, degrading to idea when inference is unavailable. */
export async function inferCaptureKind(
  provider: Provider,
  title: string,
  project: string | null,
): Promise<TicketKind> {
  if (!provider.isConfigured()) return "idea";
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
    return "idea";
  }
}
