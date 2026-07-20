import type { Ticket } from "../store.ts";

export interface BoucleEvents {
  "ticket.created": { ticket: Ticket };
  "ticket.updated": { ticket: Ticket; changed: string[] };
  "ticket.transitioned": { ticket: Ticket; from: string; to: string };
  "capture.created": { text: string; kind: string; project: string | null; ticketId: string | null };
  "loop.run.finished": { loopId: string; loopName: string; ok: boolean; costUsd: number | null; output: string };
  "settings.changed": { keys: string[] };
  "server.started": { port: number };
}

type EventName = keyof BoucleEvents;
type EventHandler<K extends EventName> = (event: BoucleEvents[K]) => void | Promise<void>;

const handlers = new Map<EventName, Set<EventHandler<any>>>();

function reportHandlerError(event: EventName, handler: EventHandler<any>, error: unknown): void {
  const owner = handler.name || "unknown";
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ext:${owner}] handler for ${event} failed: ${message}`);
}

export function emit<K extends EventName>(event: K, payload: BoucleEvents[K]): void {
  for (const handler of handlers.get(event) ?? []) {
    void Promise.resolve()
      .then(() => handler(payload))
      .catch((error: unknown) => reportHandlerError(event, handler, error));
  }
}

export function on<K extends EventName>(event: K, handler: EventHandler<K>): void {
  let eventHandlers = handlers.get(event);
  if (!eventHandlers) {
    eventHandlers = new Set();
    handlers.set(event, eventHandlers);
  }
  eventHandlers.add(handler);
}
