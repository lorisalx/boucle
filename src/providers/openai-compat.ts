// Raw-fetch implementation of the OpenAI-compatible chat, embedding, and audio APIs.

import type { ChatMessage, Provider, ToolSpec } from "./types.ts";

interface ProviderDefaults {
  readonly chat: string;
  readonly embed?: string;
  readonly transcribe?: string;
}

export interface OpenAICompatibleOptions {
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly defaults: ProviderDefaults;
}

interface ChatResponse {
  readonly choices?: Array<{ readonly message?: ChatMessage }>;
}

interface EmbeddingsResponse {
  readonly data?: Array<{ readonly embedding?: number[]; readonly index?: number }>;
}

interface TranscriptionResponse {
  readonly text?: string;
}

class ProviderRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function endpointUnavailable(error: unknown): boolean {
  return error instanceof ProviderRequestError && (error.status === 404 || error.status === 405 || error.status === 501);
}

function override(name: string, fallback: string | undefined): string | null {
  const value = (process.env[name] ?? "").trim();
  return value || fallback || null;
}

export class OpenAICompatibleProvider implements Provider {
  readonly name: string;
  readonly chatModel: string;
  readonly embedModel: string | null;
  readonly transcribeModel: string | null;

  private readonly baseUrl: string;
  private readonly apiKeyEnv: string;
  private embeddingsAvailable: boolean;
  private transcriptionAvailable: boolean;

  constructor(options: OpenAICompatibleOptions) {
    this.name = options.name;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKeyEnv = options.apiKeyEnv;
    this.chatModel = override("BOUCLE_CHAT_MODEL", options.defaults.chat) ?? "";
    this.embedModel = override("BOUCLE_EMBED_MODEL", options.defaults.embed);
    this.transcribeModel = override("BOUCLE_TRANSCRIBE_MODEL", options.defaults.transcribe);
    this.embeddingsAvailable = this.embedModel !== null;
    this.transcriptionAvailable = this.transcribeModel !== null;
  }

  isConfigured(): boolean {
    return (process.env[this.apiKeyEnv] ?? "").trim().length > 0;
  }

  supportsEmbeddings(): boolean {
    return this.embeddingsAvailable;
  }

  supportsTranscription(): boolean {
    return this.transcriptionAvailable;
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatMessage> {
    const body: Record<string, unknown> = { model: this.chatModel, messages };
    if (tools.length > 0) body.tools = tools;
    const response = await this.request<ChatResponse>("/chat/completions", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const message = response.choices?.[0]?.message;
    if (!message || message.role !== "assistant") throw new Error(`${this.name} chat returned no assistant message.`);
    return message;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (!this.embedModel || !this.embeddingsAvailable) throw new Error(`${this.name} embeddings are not supported.`);
    try {
      const response = await this.request<EmbeddingsResponse>("/embeddings", {
        method: "POST",
        body: JSON.stringify({ model: this.embedModel, input: texts }),
      });
      const data = response.data;
      if (!data || data.length !== texts.length || data.some((item) =>
        typeof item.index !== "number" || !Array.isArray(item.embedding) || item.embedding.some((value) => !Number.isFinite(value)))) {
        throw new Error(`${this.name} embeddings returned malformed data.`);
      }
      const sorted = [...data].sort((a, b) => a.index! - b.index!);
      if (sorted.some((item, index) => item.index !== index)) {
        throw new Error(`${this.name} embeddings returned invalid indexes.`);
      }
      return sorted.map((item) => item.embedding!);
    } catch (error) {
      if (endpointUnavailable(error)) this.embeddingsAvailable = false;
      throw error;
    }
  }

  async transcribe(file: Blob, filename: string): Promise<string> {
    if (!this.transcribeModel || !this.transcriptionAvailable) {
      throw new Error(`${this.name} transcription is not supported.`);
    }
    const body = new FormData();
    body.append("file", file, filename);
    body.append("model", this.transcribeModel);
    try {
      const response = await this.request<TranscriptionResponse>("/audio/transcriptions", { method: "POST", body });
      const text = response.text?.trim();
      if (!text) throw new Error(`${this.name} transcription returned no text.`);
      return text;
    } catch (error) {
      if (endpointUnavailable(error)) this.transcriptionAvailable = false;
      throw error;
    }
  }

  private apiKey(): string {
    const key = (process.env[this.apiKeyEnv] ?? "").trim();
    if (!key) throw new Error(`${this.apiKeyEnv} is not configured.`);
    return key;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.apiKey()}`);
    if (!(init.body instanceof FormData)) headers.set("content-type", "application/json");
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ProviderRequestError(response.status, `${this.name} API failed (${response.status}): ${detail.slice(0, 300)}`);
    }
    return response.json() as Promise<T>;
  }
}
