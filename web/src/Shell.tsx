import {
  BrainIcon,
  CalendarIcon,
  LayoutGridIcon,
  ListIcon,
  NetworkIcon,
  PlusIcon,
  RepeatIcon,
  SettingsIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { api } from "./api.ts";
import { openCapture } from "./Capture.tsx";
import { navigate, useHashRoute, useIdentity } from "./hooks.ts";
import { Mark, ThemeToggle, cx } from "./ui.tsx";

const NAV = [
  { hash: "#/", label: "Queue", icon: ListIcon },
  { hash: "#/brain", label: "Brain", icon: BrainIcon },
  { hash: "#/graph", label: "Graph", icon: NetworkIcon },
  { hash: "#/projects", label: "Projects", icon: LayoutGridIcon },
  { hash: "#/meetings", label: "Meetings", icon: CalendarIcon },
  { hash: "#/loops", label: "Loops", icon: RepeatIcon },
  { hash: "#/settings", label: "Settings", icon: SettingsIcon },
] as const;

function activeHash(hash: string): string {
  if (window.location.pathname.startsWith("/chats/")) return "";
  for (const item of NAV) {
    if (item.hash !== "#/" && hash.startsWith(item.hash)) return item.hash;
  }
  // Ticket and loop-detail drill-ins highlight their list view.
  if (hash.startsWith("#/loops")) return "#/loops";
  return "#/";
}

/** Cumulative vibe spend, refreshed once a minute. The ramp appears here and only here. */
function BudgetMeter({ warnUsd, stopUsd }: { warnUsd: number; stopUsd: number }) {
  const [spend, setSpend] = useState<number | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const pull = () =>
      api.loops
        .list()
        .then((loops) => {
          if (!alive) return;
          const cum = Math.max(0, ...loops.map((l) => l.cumulativeCostUsd ?? 0));
          setSpend(cum);
          setWarning(loops.find((l) => l.budgetWarning)?.budgetWarning ?? null);
        })
        .catch(() => undefined);
    pull();
    const t = setInterval(pull, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (spend === null) return null;
  const thresholdTitle = `Warning at $${warnUsd.toFixed(2)}; hard stop at $${stopUsd.toFixed(2)}.`;
  return (
    <div className="rounded-lg border border-border bg-surface px-2.5 py-2" title={warning ?? thresholdTitle}>
      <div className="mb-1.5 flex items-baseline justify-between text-[11px]">
        <span className="text-muted">Agent budget</span>
        <span className="font-mono font-medium tabular-nums text-fg">
          ${spend.toFixed(2)} / ${stopUsd.toFixed(2)}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-border">
        <div
          className="h-full rounded-full"
          style={{
            width: `${stopUsd === 0 ? 100 : Math.min(100, (spend / stopUsd) * 100)}%`,
            minWidth: spend > 0 ? "4px" : 0,
            background: "var(--ramp)",
          }}
        />
      </div>
      {warning ? <p className="mt-1.5 text-[10px] leading-tight text-danger">{warning}</p> : null}
    </div>
  );
}

function NavLinks({ hash, compact }: { hash: string; compact?: boolean }) {
  const active = activeHash(hash);
  return (
    <>
      {NAV.map(({ hash: h, label, icon: Icon }) => (
        <button
          key={h}
          onClick={() => {
            if (window.location.pathname !== "/") window.location.assign(`/${h}`);
            else navigate(h);
          }}
          title={label}
          className={cx(
            "flex items-center gap-2.5 rounded-md text-[13px] transition-colors",
            compact ? "p-2" : "px-2.5 py-1.5 text-left",
            h === active ? "bg-border font-semibold text-fg" : "text-muted hover:bg-border/60 hover:text-fg",
          )}
        >
          <Icon className={cx("size-4 shrink-0", h === active && "text-accent")} />
          {compact ? null : label}
        </button>
      ))}
    </>
  );
}

/** Initials for the identity badge, e.g. "Jane Doe" -> "JD"; falls back to "?" while unset. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
}

/**
 * The Vibe-style app frame: paper main pane, sidebar one shade deeper with the
 * brand, nav, budget meter, and the owner identity block.
 */
export function Shell({ children }: { children: ReactNode }) {
  const hash = useHashRoute();
  const identity = useIdentity();

  return (
    <div className="flex h-full">
      <aside className="hidden w-[218px] shrink-0 flex-col gap-1 border-r border-border bg-side p-3 md:flex">
        <button onClick={() => navigate("#/")} className="mb-2 flex items-center gap-2.5 px-1.5 py-1 text-left">
          <Mark className="size-7 shrink-0 text-fg" />
          <span className="leading-tight">
            <span className="block text-[15px] font-bold tracking-tight text-fg">{identity.appName}</span>
          </span>
        </button>

        <button
          onClick={() => openCapture()}
          className="mb-2 flex items-center gap-2 rounded-full bg-btn px-3 py-1.5 text-[13px] font-semibold text-btn-fg transition-colors hover:bg-btn-hover"
        >
          <PlusIcon className="size-4" /> Capture
        </button>

        <nav className="flex flex-col gap-0.5">
          <NavLinks hash={hash} />
        </nav>

        <div className="mt-auto flex flex-col gap-2">
          <BudgetMeter warnUsd={identity.budgetWarnUsd} stopUsd={identity.budgetStopUsd} />
          <div className="flex items-center gap-2 px-1.5 py-1">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-[10px] font-bold text-fg">
              {initials(identity.ownerName)}
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-xs font-semibold text-fg">{identity.ownerName || "Owner"}</span>
              <span className="block truncate text-[10px] text-dim">
                {identity.orgName ? `${identity.orgName} · chief of staff` : "chief of staff"}
              </span>
            </span>
            <ThemeToggle />
          </div>
        </div>
      </aside>

      {/* Mobile: slim top bar with icon nav. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1 border-b border-border bg-side px-3 py-2 md:hidden">
          <Mark className="mr-1 size-6 text-fg" />
          <NavLinks hash={hash} compact />
          <span className="ml-auto" />
          <button
            onClick={() => openCapture()}
            className="flex items-center gap-1.5 rounded-full bg-btn px-3 py-1.5 text-xs font-semibold text-btn-fg"
          >
            <PlusIcon className="size-3.5" /> Capture
          </button>
          <ThemeToggle />
        </div>
        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
