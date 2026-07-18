/**
 * ClickUp client — creates a task directly from a ticket via the ClickUp v2 API.
 *
 * The personal API token (pk_…) is read from boucle_meta (UI-configurable) then env,
 * and goes in the Authorization header verbatim (no "Bearer"). A ticket's project routes
 * it to the matching list under the "Projects - Loris" folder; anything unmatched falls
 * back to "Loris - Other Projects".
 */
import type { BoucleStore } from "./store.ts";

export interface ClickupConfig {
  readonly token: string;
}

/** Read the ClickUp token from boucle_meta (UI-configurable) then env. */
export function getClickupConfig(store: BoucleStore): ClickupConfig | null {
  const token = (store.getMeta("clickupToken") ?? process.env.CLICKUP_TOKEN ?? "").trim();
  return token.length > 0 ? { token } : null;
}

/** Lists in the "Projects - Loris" folder (workspace "Dataiku" → space "EDA - GenAI Engineering"). */
const FALLBACK = { listId: "901215830449", label: "Loris - Other Projects" };
const ROUTES: ReadonlyArray<{ test: RegExp; listId: string; label: string }> = [
  { test: /genai|monitoring/, listId: "901217137252", label: "GenAI Monitoring" },
  { test: /companion/, listId: "901214300968", label: "Companion Agent" },
  { test: /salesforce|sfdc|slack-sf/, listId: "901216355861", label: "Salesforce updated from Slack Chat" },
  { test: /legal/, listId: "901214305235", label: "Legal Document Process Automation" },
  { test: /vector|knowledge|externalise|(^|[-_])kbs?([-_]|$)/, listId: "901214996476", label: "Externalise KBs" },
  { test: /dataiklaw/, listId: "901216990119", label: "Dataiklaw" },
];

export function resolveList(project: string | null): { listId: string; label: string } {
  const slug = (project ?? "").toLowerCase();
  return ROUTES.find((r) => r.test.test(slug)) ?? FALLBACK;
}

export interface CreateTaskInput {
  readonly title: string;
  readonly body: string;
  readonly nextAction: string | null;
  readonly project: string | null;
  readonly requester: string | null;
  readonly permalink: string | null;
}

export interface CreatedTask {
  readonly id: string;
  readonly url: string;
  readonly listLabel: string;
}

export async function createClickupTask(cfg: ClickupConfig, input: CreateTaskInput): Promise<CreatedTask> {
  const { listId, label } = resolveList(input.project);

  const parts: string[] = [];
  if (input.body.trim().length > 0) parts.push(input.body.trim());
  if (input.nextAction) parts.push(`Next action: ${input.nextAction}`);
  const meta: string[] = [];
  if (input.requester) meta.push(`From: ${input.requester}`);
  if (input.permalink) meta.push(`Slack: ${input.permalink}`);
  meta.push("Promoted from Boucle");
  parts.push(meta.join(" · "));

  const res = await fetch(`https://api.clickup.com/api/v2/list/${listId}/task`, {
    method: "POST",
    headers: { authorization: cfg.token, "content-type": "application/json" },
    body: JSON.stringify({ name: input.title, description: parts.join("\n\n") }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ClickUp task create failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const task = (await res.json()) as { id: string; url?: string };
  return { id: task.id, url: task.url ?? `https://app.clickup.com/t/${task.id}`, listLabel: label };
}
