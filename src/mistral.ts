import { SPAWNED_CHAT_GUARDRAILS } from "./config.ts";
import { executeBoucleTool, MISTRAL_BOUCLE_TOOLS } from "./boucle-tools.ts";
import { getProjectPage } from "./projects.ts";
import type { BoucleStore, Ticket } from "./store.ts";

const API_BASE = "https://api.mistral.ai";
const MODEL = "mistral-medium-3.5";
const MAX_TOOL_ROUNDS = 20;

export interface SpawnResult {
  readonly threadId: string;
  readonly project: string;
  readonly openUrl: string;
}

interface FunctionCallEntry {
  readonly type: "function.call";
  readonly name: string;
  readonly arguments: string | Record<string, unknown>;
  readonly tool_call_id: string;
}

interface ConversationResponse {
  readonly conversation_id: string;
  readonly outputs: unknown[];
}

interface ConversationHistory {
  readonly conversation_id: string;
  readonly entries: unknown[];
}

interface TranscriptionResponse {
  readonly text: string;
}

export interface ChatEntry {
  readonly role: "user" | "assistant" | "tool";
  readonly text: string;
  readonly toolName?: string;
}

export interface ChatTranscript {
  readonly conversationId: string;
  readonly entries: ChatEntry[];
}

function apiKey(): string {
  const key = (process.env.MISTRAL_API_KEY ?? "").trim();
  if (key.length === 0) throw new Error("MISTRAL_API_KEY is not configured.");
  return key;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${apiKey()}`);
  if (!(init?.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Mistral API failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return response.json() as Promise<T>;
}

export async function transcribe(file: Blob, filename: string): Promise<string> {
  const body = new FormData();
  body.append("file", file, filename);
  body.append("model", "voxtral-mini-latest");
  const response = await request<TranscriptionResponse>("/v1/audio/transcriptions", { method: "POST", body });
  const text = response.text?.trim();
  if (!text) throw new Error("Mistral transcription returned no text.");
  return text;
}

function isFunctionCall(entry: unknown): entry is FunctionCallEntry {
  if (typeof entry !== "object" || entry === null) return false;
  const value = entry as Partial<FunctionCallEntry>;
  return value.type === "function.call" && typeof value.name === "string" && typeof value.tool_call_id === "string";
}

function parseArguments(value: FunctionCallEntry["arguments"]): Record<string, unknown> {
  if (typeof value !== "string") return value;
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("function arguments must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function resultEntry(call: FunctionCallEntry, store: BoucleStore): Record<string, unknown> {
  try {
    const result = executeBoucleTool(store, call.name, parseArguments(call.arguments));
    return { type: "function.result", tool_call_id: call.tool_call_id, result: JSON.stringify(result) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { type: "function.result", tool_call_id: call.tool_call_id, result: JSON.stringify({ error: message }) };
  }
}

async function relay(store: BoucleStore, initial: ConversationResponse): Promise<ConversationResponse> {
  let response = initial;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const calls = response.outputs.filter(isFunctionCall);
    if (calls.length === 0) return response;
    response = await request<ConversationResponse>(`/v1/conversations/${encodeURIComponent(response.conversation_id)}`, {
      method: "POST",
      body: JSON.stringify({ inputs: calls.map((call) => resultEntry(call, store)), store: true }),
    });
  }
  if (response.outputs.some(isFunctionCall)) throw new Error(`Mistral tool relay exceeded ${MAX_TOOL_ROUNDS} rounds.`);
  return response;
}

const INSTRUCTIONS = `You are Boucle's in-browser work assistant for the fictional company Brumeline. Use the provided Boucle tools when you need current ticket or synthetic project information. Be concise and explicit about changes you make.\n\n${SPAWNED_CHAT_GUARDRAILS}`;

async function startChat(store: BoucleStore, title: string, prompt: string): Promise<SpawnResult> {
  const response = await request<ConversationResponse>("/v1/conversations", {
    method: "POST",
    body: JSON.stringify({
      model: MODEL,
      name: title,
      instructions: INSTRUCTIONS,
      inputs: prompt,
      tools: MISTRAL_BOUCLE_TOOLS,
      store: true,
    }),
  });
  await relay(store, response);
  return { threadId: response.conversation_id, project: "mistral", openUrl: `/chats/${response.conversation_id}` };
}

export function buildTicketChatPrompt(ticket: Ticket): string {
  const lines = [`Help me with this task: ${ticket.title}`];
  if (ticket.body.trim().length > 0) lines.push("", ticket.body.trim());
  if (ticket.project) lines.push("", `Project: ${ticket.project}`);
  if (ticket.requester) lines.push(`Requested by: ${ticket.requester}`);
  lines.push(`Source: ${ticket.source}${ticket.permalink ? ` — ${ticket.permalink}` : ""}`);
  if (ticket.nextAction) lines.push(`Next action: ${ticket.nextAction}`);
  const page = ticket.project ? getProjectPage(ticket.project) : null;
  if (page) lines.push("", `Current synthetic project page (${page.projectId}):`, page.body);
  return lines.join("\n");
}

export async function spawnMistralChat(store: BoucleStore, ticket: Ticket, prompt?: string): Promise<SpawnResult> {
  let seededPrompt = prompt ?? buildTicketChatPrompt(ticket);
  if (prompt && ticket.project) {
    const page = getProjectPage(ticket.project);
    if (page) seededPrompt += `\n\nCurrent synthetic project page (${page.projectId}):\n${page.body}`;
  }
  const result = await startChat(store, ticket.title, seededPrompt);
  store.setFields({ ticketId: ticket.ticketId, threadId: result.threadId });
  return result;
}

export async function spawnMistralProjectChat(store: BoucleStore, title: string, prompt: string): Promise<SpawnResult> {
  return startChat(store, title, prompt);
}

export async function appendMistralMessage(store: BoucleStore, conversationId: string, text: string): Promise<void> {
  const response = await request<ConversationResponse>(`/v1/conversations/${encodeURIComponent(conversationId)}`, {
    method: "POST",
    body: JSON.stringify({ inputs: text, store: true }),
  });
  await relay(store, response);
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export async function getMistralTranscript(conversationId: string): Promise<ChatTranscript> {
  const history = await request<ConversationHistory>(`/v1/conversations/${encodeURIComponent(conversationId)}/history`);
  const entries: ChatEntry[] = [];
  for (const raw of history.entries) {
    if (isFunctionCall(raw)) {
      entries.push({ role: "tool", text: `Used tool ${raw.name}`, toolName: raw.name });
      continue;
    }
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as { role?: unknown; content?: unknown; type?: unknown };
    if (entry.role !== "user" && entry.role !== "assistant") continue;
    const text = contentText(entry.content);
    if (text.length > 0) entries.push({ role: entry.role, text });
  }
  return { conversationId: history.conversation_id, entries };
}
