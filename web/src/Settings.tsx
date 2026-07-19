import { useEffect, useState } from "react";

import { api } from "./api.ts";
import { useIdentity } from "./hooks.ts";
import { Button, Status } from "./ui.tsx";

export function Settings() {
  const identity = useIdentity();
  const [mcp, setMcp] = useState<{ url: string; token: string; configToml: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.mcpInfo().then(setMcp).catch(() => {});
  }, []);

  const copyMcp = () => {
    if (!mcp) return;
    navigator.clipboard.writeText(mcp.configToml).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="mb-6 text-[22px] font-bold tracking-tight text-fg">Settings</h1>

      <div className="flex flex-col gap-6">
        <div className="rounded-lg border border-border bg-surface px-4 py-3">
          <h2 className="text-sm font-medium capitalize text-fg">{identity.providerName || "Provider"}</h2>
          <p className="mt-1 text-xs text-muted">
            Spawned chats use the configured provider. {identity.appName} never exposes or stores its API key.
          </p>
          <div className="mt-3">
            <Status tone={identity.providerConfigured ? "success" : "neutral"}>
              API key {identity.providerConfigured ? "present" : "not configured"}
            </Status>
          </div>
        </div>

        <div className="border-t border-border pt-6">
          <h2 className="mb-1 text-sm font-medium text-fg">MCP tools for Vibe</h2>
          <p className="mb-3 text-xs text-muted">
            Boucle serves its ticket tools over MCP. Loop runs get this wired automatically; to point your
            own Vibe session at Boucle, add this to its{" "}
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
