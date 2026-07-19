export type TicketStatus =
  | "inbox"
  | "triaged"
  | "next"
  | "snoozed"
  | "blocked"
  | "in_progress"
  | "done"
  | "dropped";
export type TicketPriority = "urgent" | "high" | "normal" | "low";
export type TicketBucket = "urgent" | "to_do_next" | "cool_to_do" | "maybe_one_day";
export type TicketKind = "task" | "idea" | "conv" | "scope";
export type TicketNeeds = "claude" | "codex" | "human" | "none";
export type TicketSource = "slack" | "gmail" | "gcal" | "manual";
export type TicketEventKind =
  | "created"
  | "status"
  | "priority"
  | "project"
  | "needs"
  | "chat"
  | "note"
  | "field";

export interface Ticket {
  ticketId: string;
  title: string;
  body: string;
  status: TicketStatus;
  priority: TicketPriority;
  kind: TicketKind;
  bucket: TicketBucket | null;
  score: number;
  project: string | null;
  source: TicketSource;
  sourceRef: string | null;
  permalink: string | null;
  requester: string | null;
  needs: TicketNeeds;
  effort: string | null;
  dueAt: string | null;
  snoozedUntil: string | null;
  nextAction: string | null;
  threadId: string | null;
  workRef: string | null;
  dedupeKey: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface TicketEvent {
  eventId: string;
  ticketId: string;
  kind: TicketEventKind;
  summary: string;
  at: string;
}

export interface Settings {
  appName: string;
  ownerName: string;
  orgName: string;
  demoMode: boolean;
  providerName: string;
  providerConfigured: boolean;
}

export interface ChatEntry {
  role: "user" | "assistant" | "tool";
  text: string;
  toolName?: string;
}

export interface ChatTranscript {
  conversationId: string;
  entries: ChatEntry[];
  ticket?: Ticket | null;
}

export type SearchSource = "ticket" | "event" | "meeting" | "brain";

export interface SearchResult {
  source: SearchSource;
  id: string;
  title: string;
  snippet: string;
  projectId?: string;
  url: string;
  score: number;
}

export interface SearchResponse {
  query: string;
  counts: Record<SearchSource, number>;
  results: SearchResult[];
}

export interface VibeEntry {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
}

export interface VibeTranscript {
  meta: {
    sessionId: string;
    title: string | null;
    startTime: string | null;
    endTime: string | null;
    costUsd: number | null;
  };
  entries: VibeEntry[];
  running: boolean;
}

export type ProjectStatus = "scoping" | "in_progress" | "backlog" | "on_hold" | "done" | "archived";

export interface ProjectSummary {
  projectId: string;
  title: string;
  status: ProjectStatus;
  rawStatus: string;
  sortOrder: number | null;
  summary: string | null;
  currentState: string | null;
  nextMilestone: string | null;
  blockedBy: string | null;
  owners: string[];
  links: Array<{ label: string; value: string }>;
  brainPath: string;
  lastTimelineAt: string | null;
  fileUpdatedAt: string | null;
  lastActivityAt: string | null;
  timelineCount: number;
  openTickets: Ticket[];
  openTicketCount: number;
}

export interface TimelineEntry {
  date: string | null;
  dateLabel: string | null;
  text: string;
}

export interface Backlink {
  fromSlug: string;
  linkType: string;
  context: string;
}

/** A meeting note without its (heavy) markdown body. */
export type MeetingLite = Omit<Meeting, "body">;

export interface ProjectDetail {
  page: { projectId: string; body: string; timeline: TimelineEntry[] } | null;
  backlinks: Backlink[];
  meetings: MeetingLite[];
  resolvedTickets: Ticket[];
}

export type LoopRunStatus = "running" | "ok" | "error" | "timeout";

export interface Loop {
  loopId: string;
  name: string;
  description: string;
  prompt: string;
  enabled: boolean;
  intervalMinutes: number;
  activeDays: string;
  activeStartHour: number;
  activeEndHour: number;
  timezone: string;
  codexHome: string | null;
  profile: string | null;
  model: string | null;
  threadId: string | null;
  threadProject: string | null;
  threadOpenUrl: string | null;
  lastRunAt: string | null;
  lastStatus: LoopRunStatus | null;
  createdAt: string;
  updatedAt: string;
  isRunning?: boolean;
  cumulativeCostUsd?: number;
  budgetWarning?: string | null;
  budgetBlocked?: boolean;
}

export interface LoopRun {
  runId: string;
  loopId: string;
  startedAt: string;
  finishedAt: string | null;
  status: LoopRunStatus;
  exitCode: number | null;
  summary: string;
  trigger: "schedule" | "manual" | "smart_capture" | "enrich" | "vibe_thread";
  costUsd: number | null;
  sessionId: string | null;
}

export type LoopInput = Partial<Omit<Loop, "loopId" | "lastRunAt" | "lastStatus" | "createdAt" | "updatedAt" | "isRunning">> & {
  name: string;
  prompt: string;
};

export interface Meeting {
  file: string;
  date: string | null;
  title: string;
  processed: boolean;
  source: string | null;
  attendees: string[];
  tags: string[];
  relatedProjects: string[];
  callLink: string | null;
  summary: string | null;
  actionItems: string[];
  body: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const post = (path: string, body: unknown) =>
  fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export const api = {
  meta: () => fetch("/api/meta").then((r) => json<{ workdir: string }>(r)),
  search: (query: string) =>
    fetch(`/api/search?q=${encodeURIComponent(query)}`).then((r) => json<SearchResponse>(r)),
  open: () => fetch("/api/tickets/open").then((r) => json<Ticket[]>(r)),
  projects: () => fetch("/api/projects").then((r) => json<ProjectSummary[]>(r)),
  meetings: () => fetch("/api/meetings").then((r) => json<Meeting[]>(r)),
  list: (status: TicketStatus) =>
    fetch(`/api/tickets?status=${status}`).then((r) => json<Ticket[]>(r)),
  get: (id: string) =>
    fetch(`/api/tickets/${id}`).then((r) =>
      json<{ ticket: Ticket | null; events: TicketEvent[]; enriching: boolean }>(r),
    ),
  enrich: (id: string, note: string) =>
    post(`/api/tickets/${id}/enrich`, { note }).then((r) => json<{ ok: boolean }>(r)),
  transition: (id: string, toStatus: TicketStatus, snoozedUntil?: string) =>
    post(`/api/tickets/${id}/transition`, { toStatus, snoozedUntil }).then((r) => json<Ticket>(r)),
  setFields: (id: string, fields: Record<string, unknown>) =>
    post(`/api/tickets/${id}/set`, fields).then((r) => json<Ticket>(r)),
  spawnChat: (id: string) =>
    post(`/api/tickets/${id}/spawn-chat`, {}).then((r) =>
      json<{ threadId: string; project: string; openUrl: string }>(r),
    ),
  createEpic: (input: {
    title: string;
    project?: string | null;
    bucket?: TicketBucket | null;
    kind?: TicketKind;
    chat?: boolean;
    autoRoute?: boolean;
  }) =>
    post("/api/epics", input).then((r) =>
      json<{ ticket: Ticket; openUrl: string | null; chat: boolean; error?: string }>(r),
    ),
  activity: (days = 26) =>
    fetch(`/api/activity?days=${days}`).then((r) =>
      json<Array<{ day: string; project: string | null; count: number }>>(r),
    ),
  smartCapture: (text: string, project?: string | null) =>
    post("/api/capture/smart", { text, project }).then((r) => json<{ ok: boolean; batchId: string }>(r)),
  voiceCapture: (audio: Blob, filename: string, project?: string | null) => {
    const body = new FormData();
    body.append("file", audio, filename);
    if (project) body.append("project", project);
    return fetch("/api/capture/voice", { method: "POST", body }).then((r) =>
      json<{ ok: boolean; batchId: string; transcript: string }>(r),
    );
  },
  smartCaptureRuns: () =>
    fetch("/api/capture/smart").then((r) =>
      json<Array<{ batchId: string; status: string; startedAt: string; finishedAt: string | null }>>(r),
    ),
  setProjectStatus: (id: string, status: ProjectStatus | null) =>
    post(`/api/projects/${encodeURIComponent(id)}/status`, { status }).then((r) => json<{ ok: boolean }>(r)),
  projectDetail: (id: string) =>
    fetch(`/api/projects/${encodeURIComponent(id)}/detail`).then((r) => json<ProjectDetail>(r)),
  addTimelineEntry: (id: string, text: string, date?: string) =>
    post(`/api/projects/${encodeURIComponent(id)}/timeline`, { text, date }).then((r) =>
      json<{ timeline: TimelineEntry[] }>(r),
    ),
  briefProject: (id: string) =>
    post(`/api/projects/${encodeURIComponent(id)}/brief`, {}).then((r) =>
      json<{ threadId: string; project: string; openUrl: string }>(r),
    ),
  reorderProjects: (order: string[]) =>
    post("/api/projects/reorder", { order }).then((r) => json<{ ok: boolean }>(r)),
  loopState: () => fetch("/api/loop-state").then((r) => json<{ enabled: boolean }>(r)),
  setLoopState: (enabled: boolean) =>
    post("/api/loop-state", { enabled }).then((r) => json<{ enabled: boolean }>(r)),
  settings: () => fetch("/api/settings").then((r) => json<Settings>(r)),
  chat: {
    get: (conversationId: string) =>
      fetch(`/api/chats/${encodeURIComponent(conversationId)}`).then((r) => json<ChatTranscript>(r)),
    send: (conversationId: string, text: string) =>
      post(`/api/chats/${encodeURIComponent(conversationId)}/messages`, { text }).then((r) =>
        json<ChatTranscript>(r),
      ),
  },
  brainChat: {
    get: (conversationId: string) =>
      fetch(`/api/brain-chat/${encodeURIComponent(conversationId)}`).then((r) => json<ChatTranscript>(r)),
    send: (text: string, conversationId?: string) =>
      post("/api/brain-chat", { text, conversationId }).then((r) => json<ChatTranscript>(r)),
  },
  vibe: {
    get: (scope: string, sessionId: string) =>
      fetch(`/api/vibe/${encodeURIComponent(scope)}/${encodeURIComponent(sessionId)}`).then((r) =>
        json<VibeTranscript>(r),
      ),
    send: (scope: string, sessionId: string, message: string) =>
      post(`/api/vibe/${encodeURIComponent(scope)}/${encodeURIComponent(sessionId)}/send`, { message }).then((r) =>
        json<{ ok: boolean; running: boolean }>(r),
      ),
  },
  mcpInfo: () =>
    fetch("/api/mcp-info").then((r) => json<{ url: string; token: string; configToml: string }>(r)),
  loops: {
    list: () => fetch("/api/loops").then((r) => json<Loop[]>(r)),
    get: (id: string) => fetch(`/api/loops/${id}`).then((r) => json<{ loop: Loop; runs: LoopRun[] }>(r)),
    create: (input: LoopInput) => post("/api/loops", input).then((r) => json<Loop>(r)),
    update: (id: string, patch: Partial<LoopInput>) => post(`/api/loops/${id}`, patch).then((r) => json<Loop>(r)),
    remove: (id: string) => fetch(`/api/loops/${id}`, { method: "DELETE" }).then((r) => json<{ ok: boolean }>(r)),
    setEnabled: (id: string, enabled: boolean) =>
      post(`/api/loops/${id}/enabled`, { enabled }).then((r) => json<Loop>(r)),
    run: (id: string) => post(`/api/loops/${id}/run`, {}).then((r) => json<LoopRun>(r)),
    runs: (id: string) => fetch(`/api/loops/${id}/runs`).then((r) => json<LoopRun[]>(r)),
  },
};

export const OPEN_STATUSES: ReadonlySet<TicketStatus> = new Set([
  "inbox",
  "triaged",
  "next",
  "snoozed",
  "blocked",
  "in_progress",
]);
