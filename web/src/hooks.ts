import { useCallback, useEffect, useState } from "react";

import { api, type Loop, type Meeting, type ProjectSummary, type Settings, type Ticket } from "./api.ts";

const IDENTITY_FALLBACK: Settings = {
  appName: "Boucle",
  ownerName: "",
  orgName: "",
  demoMode: false,
  providerName: "mistral",
  providerConfigured: false,
};

let identityCache: Settings | null = null;
let identityPromise: Promise<Settings> | null = null;

/** Boucle's identity (appName/ownerName/orgName/…), fetched once and cached for the app's lifetime. */
export function useIdentity(): Settings {
  const [identity, setIdentity] = useState<Settings>(identityCache ?? IDENTITY_FALLBACK);
  useEffect(() => {
    if (identityCache) return;
    identityPromise ??= api.settings();
    identityPromise.then((s) => {
      identityCache = s;
      setIdentity(s);
    }).catch(() => undefined);
  }, []);
  return identity;
}

/** Poll the open-ticket snapshot (live-ish) + expose a manual refresh. */
export function useOpenTickets(): {
  tickets: Ticket[];
  status: "loading" | "ready" | "error";
  refresh: () => void;
} {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const refresh = useCallback(() => {
    api
      .open()
      .then((t) => {
        setTickets(t);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 6000);
    return () => clearInterval(id);
  }, [refresh]);

  return { tickets, status, refresh };
}

/** Poll the loop list (live-ish) + expose a manual refresh. */
export function useLoops(): {
  loops: Loop[];
  status: "loading" | "ready" | "error";
  refresh: () => void;
} {
  const [loops, setLoops] = useState<Loop[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const refresh = useCallback(() => {
    api
      .loops.list()
      .then((l) => {
        setLoops(l);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 6000);
    return () => clearInterval(id);
  }, [refresh]);

  return { loops, status, refresh };
}

/** Poll the recorded-meetings list (they change rarely — slow poll). */
export function useMeetings(): {
  meetings: Meeting[];
  status: "loading" | "ready" | "error";
  refresh: () => void;
} {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const refresh = useCallback(() => {
    api
      .meetings()
      .then((m) => {
        setMeetings(m);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15000);
    return () => clearInterval(id);
  }, [refresh]);

  return { meetings, status, refresh };
}

/** Poll project summaries from gbrain + the open-ticket queue. */
export function useProjects(): {
  projects: ProjectSummary[];
  status: "loading" | "ready" | "error";
  refresh: () => void;
} {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const refresh = useCallback(() => {
    api
      .projects()
      .then((p) => {
        setProjects(p);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10000);
    return () => clearInterval(id);
  }, [refresh]);

  return { projects, status, refresh };
}

export type Theme = "light" | "dark";

/** Read/toggle the Geist theme; persisted in localStorage key `theme`. */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(
    () => (document.documentElement.dataset.theme as Theme) || "dark",
  );
  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem("theme", next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  return { theme, toggle };
}

export function navigate(to: string): void {
  window.location.hash = to;
}

export function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash || "#/");
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}
