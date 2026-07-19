// Provider-neutral OpenAI-compatible chat, tool, embedding, and transcription shapes.

export interface ToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export interface ChatContentPart {
  readonly type: string;
  readonly text?: string;
  readonly [key: string]: unknown;
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | readonly ChatContentPart[] | null;
  readonly name?: string;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly ToolCall[];
}

export interface ToolSpec {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface Provider {
  readonly name: string;
  readonly chatModel: string;
  isConfigured(): boolean;
  supportsEmbeddings(): boolean;
  supportsTranscription(): boolean;
  chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatMessage>;
  embed(texts: readonly string[]): Promise<number[][]>;
  transcribe(file: Blob, filename: string): Promise<string>;
}
