import { ArrowLeftIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { api } from "./api.ts";
import { navigate } from "./hooks.ts";
import { Button, Status, ThemeToggle } from "./ui.tsx";

const INPUT_CLASS =
  "w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm text-fg outline-none placeholder:text-dim focus:border-focus";

export function Settings() {
  const [clickupToken, setClickupToken] = useState("");
  const [mistralConfigured, setMistralConfigured] = useState(false);
  const [clickupConfigured, setClickupConfigured] = useState(false);
  const [saved, setSaved] = useState(false);
  const [mcp, setMcp] = useState<{ url: string; token: string; configToml: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.settings().then((s) => {
      setMistralConfigured(s.mistralConfigured);
      setClickupConfigured(s.clickupConfigured);
    });
    api.mcpInfo().then(setMcp).catch(() => {});
  }, []);

  const copyMcp = () => {
    if (!mcp) return;
    navigator.clipboard.writeText(mcp.configToml).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const save = () => {
    const patch: Record<string, string> = {};
    if (clickupToken.trim().length > 0) patch.clickupToken = clickupToken.trim();
    api.saveSettings(patch).then(() => {
      setSaved(true);
      setClickupToken("");
      api.settings().then((s) => {
        setMistralConfigured(s.mistralConfigured);
        setClickupConfigured(s.clickupConfigured);
      });
      setTimeout(() => setSaved(false), 1500);
    });
  };

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="mb-6 flex items-center">
        <button
          onClick={() => navigate("#/")}
          className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
        >
          <ArrowLeftIcon className="size-4" /> Back
        </button>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </div>
      <h1 className="mb-6 text-xl font-semibold tracking-tight text-fg">Settings</h1>

      <div className="flex flex-col gap-6">
        <div className="rounded-lg border border-border bg-surface px-4 py-3">
          <h2 className="text-sm font-medium text-fg">Mistral</h2>
          <p className="mt-1 text-xs text-muted">
            Spawned chats use the Conversations API. Set <code className="font-mono">MISTRAL_API_KEY</code> in
            the server environment; Boucle never exposes or stores the key.
          </p>
          <div className="mt-3">
            <Status tone={mistralConfigured ? "success" : "neutral"}>
              API key {mistralConfigured ? "present" : "not configured"}
            </Status>
          </div>
        </div>

        <Field
          label="ClickUp API key"
          hint={
            clickupConfigured
              ? "A key is saved. Leave blank to keep it, or paste a new one to replace. Create ClickUp task routes by project into the Projects - Loris lists."
              : "Personal token (pk_…) from ClickUp → Settings → Apps. Create ClickUp task creates the task directly, routed by project."
          }
        >
          <input
            type="password"
            value={clickupToken}
            onChange={(e) => setClickupToken(e.target.value)}
            placeholder={clickupConfigured ? "•••••••• (saved)" : "pk_…"}
            spellCheck={false}
            className={INPUT_CLASS}
          />
        </Field>

        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={save}>
            Save
          </Button>
          {saved ? <span className="text-xs text-success">Saved.</span> : null}
          <span className="ml-auto flex items-center gap-3 text-xs">
            <Status tone={mistralConfigured ? "success" : "neutral"}>
              Mistral {mistralConfigured ? "ready" : "not configured"}
            </Status>
            <Status tone={clickupConfigured ? "success" : "neutral"}>
              ClickUp {clickupConfigured ? "connected" : "not configured"}
            </Status>
          </span>
        </div>

        <div className="border-t border-border pt-6">
          <h2 className="mb-1 text-sm font-medium text-fg">MCP tools for Codex / Claude</h2>
          <p className="mb-3 text-xs text-muted">
            BOUCLE serves its ticket tools over MCP. Add this to your loop&apos;s codex{" "}
            <code className="font-mono text-muted">config.toml</code> (HTTP needs the server running; stdio
            works headless).
          </p>
          {mcp ? (
            <>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface px-3 py-2 font-mono text-[11px] leading-relaxed text-muted">
                {mcp.configToml}
              </pre>
              <div className="mt-2 flex items-center gap-3">
                <Button variant="outline" onClick={copyMcp}>
                  Copy config
                </Button>
                {copied ? <span className="text-xs text-success">Copied.</span> : null}
                <span className="font-mono text-xs text-dim">endpoint: {mcp.url}</span>
              </div>
            </>
          ) : (
            <p className="text-xs text-dim">Loading…</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-fg">{label}</span>
      <span className="text-xs text-muted">{hint}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
