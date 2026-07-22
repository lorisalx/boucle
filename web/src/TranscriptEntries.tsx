import { BotIcon, WrenchIcon } from "lucide-react";

import type { VibeEntry } from "./api.ts";
import { BrainMarkdown, type WikiLinkProps } from "./Markdown.tsx";
import { cx } from "./ui.tsx";

const EMPTY_WIKI: WikiLinkProps = {
  knownProjects: new Set<string>(),
  onOpenProject: () => {},
};

export function TranscriptEntries({ entries }: { entries: VibeEntry[] }) {
  return entries.map((entry, index) => {
    if (entry.role === "tool") {
      return (
        <details key={index} className="mx-auto max-w-full text-[11px] text-dim">
          <summary className="cursor-pointer list-none rounded-md border border-border px-2 py-1 hover:text-muted">
            <span className="inline-flex items-center gap-1.5">
              <WrenchIcon className="size-3" /> {entry.toolName ?? "Tool call"}
            </span>
          </summary>
          <pre className="mt-1 max-h-48 max-w-2xl overflow-auto whitespace-pre-wrap rounded bg-side p-2 font-mono text-[10px]">
            {entry.content}
          </pre>
        </details>
      );
    }
    const user = entry.role === "user";
    return (
      <div key={index} className={cx("flex", user ? "justify-end" : "justify-start")}>
        <div
          className={cx(
            "text-sm leading-relaxed text-fg",
            user ? "max-w-[85%] rounded-2xl bg-side px-3.5 py-2.5" : "max-w-[92%] py-1",
          )}
        >
          {!user ? <BotIcon className="mb-1.5 size-3.5 text-accent" /> : null}
          <BrainMarkdown text={entry.content} wiki={EMPTY_WIKI} skipTitle={false} />
        </div>
      </div>
    );
  });
}
