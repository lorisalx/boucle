import {
  CalendarIcon,
  LayoutGridIcon,
  ListIcon,
  PlusIcon,
  RepeatIcon,
  SettingsIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { api } from "./api.ts";
import { openCapture } from "./Capture.tsx";
import { navigate, useHashRoute } from "./hooks.ts";
import { ThemeToggle, cx } from "./ui.tsx";

const BUDGET_CAP_USD = 30;

const NAV = [
  { hash: "#/", label: "Queue", icon: ListIcon },
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
function BudgetMeter() {
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
  return (
    <div className="rounded-lg border border-border bg-surface px-2.5 py-2" title={warning ?? undefined}>
      <div className="mb-1.5 flex items-baseline justify-between text-[11px]">
        <span className="text-muted">Mistral budget</span>
        <span className="font-mono font-medium tabular-nums text-fg">
          ${spend.toFixed(2)} / ${BUDGET_CAP_USD}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-border">
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.min(100, (spend / BUDGET_CAP_USD) * 100)}%`,
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

/**
 * The Vibe-style app frame: paper main pane, sidebar one shade deeper with the
 * brand, nav, budget meter, and the Brumeline persona.
 */
export function Shell({ children }: { children: ReactNode }) {
  const hash = useHashRoute();

  return (
    <div className="flex h-full">
      <aside className="hidden w-[218px] shrink-0 flex-col gap-1 border-r border-border bg-side p-3 md:flex">
        <button onClick={() => navigate("#/")} className="mb-2 flex items-center gap-2.5 px-1.5 py-1 text-left">
          <img src="/brand/Mistral-Icon-Gradient-RGB.svg" alt="" className="size-7 shrink-0" />
          <span className="leading-tight">
            <span className="block text-[15px] font-bold tracking-tight text-fg">Boucle</span>
          </span>
        </button>

        <button
          onClick={() => openCapture()}
          className="mb-2 flex items-center gap-2 rounded-full bg-btn px-3 py-1.5 text-[13px] font-semibold text-btn-fg transition-colors hover:bg-btn-hover"
        >
          <PlusIcon className="size-4" /> Capture
          <kbd className="ml-auto font-mono text-[10px] font-normal opacity-70">⌘K</kbd>
        </button>

        <nav className="flex flex-col gap-0.5">
          <NavLinks hash={hash} />
        </nav>

        <div className="mt-auto flex flex-col gap-2">
          <BudgetMeter />
          <div className="flex items-center gap-2 px-1.5 py-1">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-[10px] font-bold text-fg">
              NB
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-xs font-semibold text-fg">Nora Bellier</span>
              <span className="block truncate text-[10px] text-dim">Brumeline · chief of staff</span>
            </span>
            <ThemeToggle />
          </div>
        </div>
      </aside>

      {/* Mobile: slim top bar with icon nav. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1 border-b border-border bg-side px-3 py-2 md:hidden">
          <img src="/brand/Mistral-Icon-Gradient-RGB.svg" alt="" className="mr-1 size-6" />
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
