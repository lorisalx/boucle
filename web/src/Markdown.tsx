/**
 * BrainMarkdown — a small renderer for gbrain pages (no markdown dep).
 *
 * Covers the house style: ##/### sections, bullets (nested), blockquote summary,
 * code fences/spans, tables, hr, bold, [label](url) links — and, the point of
 * rolling our own: `[[wikilinks]]` resolve instead of being stripped.
 * `[[projects/x]]` navigates to that project in the app; other targets render as
 * inert-but-visible brain references.
 */
import type { ReactNode } from "react";
import { Fragment } from "react";

export interface WikiLinkProps {
  knownProjects: ReadonlySet<string>;
  onOpenProject: (slug: string) => void;
}

const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+?\*\*)|(\[\[[^\]]+\]\])|(\[[^\]]+\]\((?:https?:)?[^)]+\))|(https?:\/\/[^\s<>)]+)/g;

function WikiLink({ target, label, wiki }: { target: string; label: string; wiki: WikiLinkProps }) {
  const project = /^projects\/(.+)$/.exec(target)?.[1] ?? null;
  if (project && wiki.knownProjects.has(project)) {
    return (
      <button
        onClick={() => wiki.onOpenProject(project)}
        title={`Open project: ${target}`}
        className="inline text-accent hover:underline"
      >
        {label}
      </button>
    );
  }
  return (
    <span title={target} className="rounded-sm bg-fg/[0.06] px-1 text-muted">
      {label}
    </span>
  );
}

export function renderInline(text: string, wiki: WikiLinkProps): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  // Fresh regex per call — renderInline recurses (bold contents), and a shared
  // global regex's lastIndex would be clobbered by the inner call, looping forever.
  const re = new RegExp(INLINE_RE.source, "g");
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    if (m[1]) {
      out.push(
        <code key={key++} className="rounded-sm bg-fg/[0.07] px-1 py-px font-mono text-[0.85em]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (m[2]) {
      out.push(<strong key={key++} className="font-semibold text-fg">{renderInline(token.slice(2, -2), wiki)}</strong>);
    } else if (m[3]) {
      const inner = token.slice(2, -2);
      const pipe = inner.indexOf("|");
      const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
      const label = (pipe === -1 ? inner : inner.slice(pipe + 1)).trim();
      out.push(<WikiLink key={key++} target={target} label={label || target} wiki={wiki} />);
    } else if (m[4]) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      out.push(
        <a key={key++} href={link?.[2]} target="_blank" rel="noreferrer" className="text-link hover:underline">
          {link?.[1] ?? token}
        </a>,
      );
    } else {
      out.push(
        <a key={key++} href={token} target="_blank" rel="noreferrer" className="break-all text-link hover:underline">
          {token}
        </a>,
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <Fragment>{out}</Fragment>;
}

type Block =
  | { kind: "heading"; depth: number; text: string }
  | { kind: "para"; text: string }
  | { kind: "quote"; lines: string[] }
  | { kind: "list"; items: Array<{ depth: number; text: string }> }
  | { kind: "code"; lines: string[] }
  | { kind: "table"; rows: string[][] }
  | { kind: "hr" };

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      i++;
      continue;
    }
    if (trimmed.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) code.push(lines[i]!), i++;
      i++;
      blocks.push({ kind: "code", lines: code });
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      blocks.push({ kind: "heading", depth: heading[1]!.length, text: heading[2]! });
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }
    if (trimmed.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith(">")) quote.push(lines[i]!.trim().replace(/^>\s?/, "")), i++;
      blocks.push({ kind: "quote", lines: quote });
      continue;
    }
    if (trimmed.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        const cells = lines[i]!.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      blocks.push({ kind: "table", rows });
      continue;
    }
    if (/^\s*-\s+/.test(line)) {
      const items: Array<{ depth: number; text: string }> = [];
      while (i < lines.length) {
        const b = /^(\s*)-\s+(.+)$/.exec(lines[i]!);
        if (b) {
          items.push({ depth: Math.min(3, Math.floor(b[1]!.length / 2)), text: b[2]! });
          i++;
        } else if (lines[i]!.trim().length > 0 && /^\s{2,}/.test(lines[i]!) && items.length > 0) {
          // Continuation line under the previous bullet.
          items[items.length - 1]!.text += ` ${lines[i]!.trim()}`;
          i++;
        } else {
          break;
        }
      }
      if (items.length > 0) {
        blocks.push({ kind: "list", items });
        continue;
      }
    }
    // Paragraph — greedy until a blank line or another block start.
    const para: string[] = [trimmed];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim().length > 0 &&
      !/^(#{1,6}\s|>|```|\||-\s|\s*-\s)/.test(lines[i]!.trim()) &&
      !/^(-{3,})$/.test(lines[i]!.trim())
    ) {
      para.push(lines[i]!.trim());
      i++;
    }
    blocks.push({ kind: "para", text: para.join(" ") });
  }
  return blocks;
}

const HEADING_STYLE: Record<number, string> = {
  1: "mt-6 text-base font-semibold tracking-tight text-fg",
  2: "mt-6 border-b border-border pb-1.5 text-[13px] font-semibold text-fg",
  3: "mt-4 text-[13px] font-semibold text-fg",
};

export function BrainMarkdown({
  text,
  wiki,
  skipTitle = true,
  skipSections = [],
}: {
  text: string;
  wiki: WikiLinkProps;
  /** Drop the leading `# Title` (the page header already shows it). */
  skipTitle?: boolean;
  /** `## Section` names rendered elsewhere (e.g. Timeline gets its own tab). */
  skipSections?: string[];
}) {
  let blocks = parseBlocks(text);
  if (skipTitle) {
    const idx = blocks.findIndex((b) => b.kind === "heading" && b.depth === 1);
    if (idx !== -1) blocks = [...blocks.slice(0, idx), ...blocks.slice(idx + 1)];
  }
  if (skipSections.length > 0) {
    const out: Block[] = [];
    let skipping = false;
    for (const b of blocks) {
      if (b.kind === "heading" && b.depth <= 2) skipping = b.depth === 2 && skipSections.includes(b.text.trim());
      if (!skipping) out.push(b);
    }
    blocks = out;
  }

  return (
    <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-muted">
      {blocks.map((block, i) => {
        switch (block.kind) {
          case "heading":
            return (
              <div key={i} className={HEADING_STYLE[Math.min(block.depth, 3)]}>
                {renderInline(block.text, wiki)}
              </div>
            );
          case "quote":
            return (
              <blockquote key={i} className="border-l-2 border-accent/50 pl-3 italic text-fg">
                {block.lines.map((l, j) => (
                  <p key={j}>{renderInline(l, wiki)}</p>
                ))}
              </blockquote>
            );
          case "list":
            return (
              <ul key={i} className="flex flex-col gap-1">
                {block.items.map((item, j) => (
                  <li key={j} className="flex gap-2" style={{ paddingLeft: item.depth * 16 }}>
                    <span className="select-none text-dim">•</span>
                    <span className="min-w-0">{renderInline(item.text, wiki)}</span>
                  </li>
                ))}
              </ul>
            );
          case "code":
            return (
              <pre key={i} className="overflow-x-auto rounded-md border border-border bg-fg/[0.04] px-3 py-2 font-mono text-xs text-fg">
                {block.lines.join("\n")}
              </pre>
            );
          case "table":
            return (
              <div key={i} className="overflow-x-auto">
                <table className="w-full border-collapse text-left">
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r} className="border-b border-border last:border-0">
                        {row.map((cell, c) =>
                          r === 0 ? (
                            <th key={c} className="py-1.5 pr-4 text-xs font-semibold text-fg">
                              {renderInline(cell, wiki)}
                            </th>
                          ) : (
                            <td key={c} className="py-1.5 pr-4 align-top text-[13px]">
                              {renderInline(cell, wiki)}
                            </td>
                          ),
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "hr":
            return <hr key={i} className="border-border" />;
          default:
            return <p key={i}>{renderInline(block.text, wiki)}</p>;
        }
      })}
    </div>
  );
}
