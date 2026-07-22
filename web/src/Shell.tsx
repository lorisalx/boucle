import {
  ActivityIcon,
  BellIcon,
  BoxIcon,
  BrainIcon,
  CalendarIcon,
  LayoutGridIcon,
  ListIcon,
  MessageSquareTextIcon,
  type LucideIcon,
  NetworkIcon,
  PlugIcon,
  PlusIcon,
  PuzzleIcon,
  RepeatIcon,
  SettingsIcon,
  WebhookIcon,
  ZapIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { openCapture } from "./Capture.tsx";
import { navigate, useExtensions, useHashRoute, useIdentity } from "./hooks.ts";
import type { Extension } from "./api.ts";
import { Mark, ThemeToggle, cx } from "./ui.tsx";

interface NavItem {
  hash: string;
  label: string;
  icon: LucideIcon;
}

const CORE_NAV: NavItem[] = [
  { hash: "#/", label: "Queue", icon: ListIcon },
  { hash: "#/brain", label: "Brain", icon: BrainIcon },
  { hash: "#/graph", label: "Graph", icon: NetworkIcon },
  { hash: "#/projects", label: "Projects", icon: LayoutGridIcon },
  { hash: "#/meetings", label: "Meetings", icon: CalendarIcon },
  { hash: "#/loops", label: "Loops", icon: RepeatIcon },
  { hash: "#/sessions", label: "Sessions", icon: MessageSquareTextIcon },
];

const SETTINGS_NAV: NavItem = { hash: "#/settings", label: "Settings", icon: SettingsIcon };

// A small, curated icon subset extensions can name; anything else falls back to Puzzle.
const EXT_ICONS: Record<string, LucideIcon> = {
  puzzle: PuzzleIcon,
  bell: BellIcon,
  box: BoxIcon,
  plug: PlugIcon,
  webhook: WebhookIcon,
  zap: ZapIcon,
  activity: ActivityIcon,
};

function extIcon(name?: string): LucideIcon {
  return (name && EXT_ICONS[name]) || PuzzleIcon;
}

/** Active extensions that registered a page become nav items, slotted before Settings. */
function extensionNav(extensions: Extension[]): NavItem[] {
  return extensions
    .filter((ext) => ext.status === "active" && ext.pages.length > 0)
    .map((ext) => ({ hash: `#/ext/${ext.name}`, label: ext.pages[0]!.label, icon: extIcon(ext.pages[0]!.icon) }));
}

function activeHash(hash: string, items: NavItem[]): string {
  if (window.location.pathname.startsWith("/chats/")) return "";
  for (const item of items) {
    if (item.hash !== "#/" && hash.startsWith(item.hash)) return item.hash;
  }
  // Ticket and loop-detail drill-ins highlight their list view.
  if (hash.startsWith("#/loops")) return "#/loops";
  return "#/";
}


function NavLinks({ hash, items, compact }: { hash: string; items: NavItem[]; compact?: boolean }) {
  const active = activeHash(hash, items);
  return (
    <>
      {items.map(({ hash: h, label, icon: Icon }) => (
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
 * brand, nav, and the owner identity block.
 */
export function Shell({ children }: { children: ReactNode }) {
  const hash = useHashRoute();
  const identity = useIdentity();
  const extensions = useExtensions();
  const navItems: NavItem[] = [...CORE_NAV, ...extensionNav(extensions), SETTINGS_NAV];

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
          <NavLinks hash={hash} items={navItems} />
        </nav>

        <div className="mt-auto flex flex-col gap-2">
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
          <NavLinks hash={hash} items={navItems} compact />
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
