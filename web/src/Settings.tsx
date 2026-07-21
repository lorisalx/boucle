import { useEffect, useState, type ReactNode } from "react";

import {
  api,
  type Extension,
  type ExtensionSettingView,
  type SettingSource,
  type Settings,
  type SettingsField,
  type SettingsUpdate,
} from "./api.ts";
import { refreshIdentity, useExtensions, useIdentity } from "./hooks.ts";
import { Button, Status, Tag, type Tone } from "./ui.tsx";

const INPUT =
  "rounded-md border border-border bg-transparent px-3 py-2 text-sm text-fg outline-none " +
  "placeholder:text-dim focus:border-border-hover";

function SourceHint({ source }: { source: SettingSource }) {
  const text = source === "meta" ? "Overridden here" : source === "env" ? "Set in .env; saving overrides it" : "Using default";
  return <span className="text-[11px] text-dim">{text}</span>;
}

function Field({ label, source, children }: { label: string; source: SettingSource; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-baseline justify-between gap-3 text-xs font-medium text-muted">
        {label}
        <SourceHint source={source} />
      </span>
      {children}
    </label>
  );
}

function Card({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface px-4 py-4">
      <h2 className="text-sm font-medium text-fg">{title}</h2>
      <p className="mt-1 text-xs text-muted">{description}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function statusTone(status: Extension["status"]): Tone {
  return status === "active" ? "success" : status === "error" ? "danger" : "neutral";
}

/** One extension: status pill, enable/disable, and its declared settings (saved per card). */
function ExtensionRow({ ext, values }: { ext: Extension; values: ExtensionSettingView[] }) {
  const [form, setForm] = useState<Record<string, string>>(() => Object.fromEntries(values.map((v) => [v.key, v.value])));
  const [busy, setBusy] = useState<"toggle" | "save" | null>(null);
  const [saved, setSaved] = useState(false);
  const [restart, setRestart] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(ext.status !== "disabled");

  const toggle = async () => {
    setBusy("toggle");
    setError(null);
    try {
      const result = await api.toggleExtension(ext.name);
      setEnabled(result.enabled);
      setRestart(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    setSaved(false);
    try {
      const update: Record<string, string | null> = {};
      for (const v of values) if ((form[v.key] ?? "") !== v.value) update[v.key] = form[v.key] ?? "";
      await api.updateSettings({ extensions: { [ext.name]: update } });
      await refreshIdentity();
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-md border border-border px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-fg">{ext.name}</span>
            <span className="text-[11px] text-dim">v{ext.version}</span>
            <Tag tone={statusTone(ext.status)}>{ext.status}</Tag>
          </div>
          {ext.description ? <p className="mt-0.5 text-xs text-muted">{ext.description}</p> : null}
          {ext.status === "error" && ext.error ? <p className="mt-1 text-[11px] text-danger">{ext.error}</p> : null}
        </div>
        <Button variant="outline" disabled={busy !== null} onClick={toggle}>
          {enabled ? "Disable" : "Enable"}
        </Button>
      </div>
      {values.length > 0 ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {values.map((field) => (
            <label key={field.key} className="flex flex-col gap-1.5">
              <span className="flex items-baseline justify-between gap-3 text-xs font-medium text-muted">
                {field.label ?? field.key}
                <span className="text-[11px] text-dim">
                  {field.source === "meta" ? "Set here" : field.source === "env" ? "From .env" : "Unset"}
                </span>
              </span>
              <input
                className={INPUT}
                value={form[field.key] ?? ""}
                placeholder={field.placeholder}
                onChange={(e) => setForm((v) => ({ ...v, [field.key]: e.target.value }))}
              />
            </label>
          ))}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {values.length > 0 ? (
          <Button disabled={busy !== null} onClick={save}>
            {busy === "save" ? "Saving…" : "Save settings"}
          </Button>
        ) : null}
        {saved ? <span className="text-xs text-success">Saved.</span> : null}
        {restart ? <span className="text-xs text-warn">Toggled — restart Boucle to apply.</span> : null}
        {error ? <span role="alert" className="text-xs text-danger">{error}</span> : null}
      </div>
    </div>
  );
}

function ExtensionsCard({ settings }: { settings: Settings }) {
  const extensions = useExtensions();
  const valuesFor = (name: string) => settings.extensions.find((e) => e.name === name)?.fields ?? [];
  return (
    <Card
      title="Extensions"
      description="Local plugins that add tools, routes, pages, runners, or providers. Enabling/disabling takes effect on restart."
    >
      {extensions.length === 0 ? (
        <p className="text-xs text-dim">No extensions installed. Drop one in your extensions directory and restart.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {extensions.map((ext) => (
            <ExtensionRow key={ext.name} ext={ext} values={valuesFor(ext.name)} />
          ))}
        </div>
      )}
    </Card>
  );
}

function identityValues(settings: Settings) {
  return { ownerName: settings.ownerName, orgName: settings.orgName };
}

function providerValues(settings: Settings) {
  return {
    provider: settings.provider,
    chatModel: settings.chatModel,
    embedModel: settings.embedModel,
    transcribeModel: settings.transcribeModel,
    openaiBaseUrl: settings.openaiBaseUrl,
  };
}

function runnerValues(settings: Settings) {
  return {
    runner: settings.runner,
    t3codeUrl: settings.t3codeUrl,
    t3codeToken: settings.t3codeToken,
    t3codeProject: settings.t3codeProject,
  };
}

function selectorOptions(available: string[], selected: string): string[] {
  return available.includes(selected) ? available : [...available, selected];
}

function dirtyUpdate<T extends object>(current: T, initial: T): SettingsUpdate {
  const update: SettingsUpdate = {};
  for (const [key, value] of Object.entries(current) as Array<[SettingsField, string]>) {
    if (value !== (initial as Record<SettingsField, string>)[key]) update[key] = value;
  }
  return update;
}

export function Settings() {
  const settings = useIdentity();
  const [identityForm, setIdentityForm] = useState(() => identityValues(settings));
  const [identityInitial, setIdentityInitial] = useState(() => identityValues(settings));
  const [providerForm, setProviderForm] = useState(() => providerValues(settings));
  const [providerInitial, setProviderInitial] = useState(() => providerValues(settings));
  const [runnerForm, setRunnerForm] = useState(() => runnerValues(settings));
  const [runnerInitial, setRunnerInitial] = useState(() => runnerValues(settings));
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [runnerError, setRunnerError] = useState<string | null>(null);
  const [saving, setSaving] = useState<"identity" | "provider" | "runner" | null>(null);
  const [saved, setSaved] = useState<"identity" | "provider" | "runner" | null>(null);
  const [mcp, setMcp] = useState<{ url: string; token: string; configToml: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const identity = identityValues(settings);
    const provider = providerValues(settings);
    const runner = runnerValues(settings);
    setIdentityForm(identity);
    setIdentityInitial(identity);
    setProviderForm(provider);
    setProviderInitial(provider);
    setRunnerForm(runner);
    setRunnerInitial(runner);
  }, [settings]);

  useEffect(() => {
    api.mcpInfo().then(setMcp).catch(() => {});
  }, []);

  const save = async (card: "identity" | "provider" | "runner", update: SettingsUpdate) => {
    const setError = card === "identity" ? setIdentityError : card === "provider" ? setProviderError : setRunnerError;
    setError(null);
    setSaving(card);
    setSaved(null);
    try {
      await api.updateSettings(update);
      await refreshIdentity();
      setSaved(card);
      setTimeout(() => setSaved((value) => value === card ? null : value), 1500);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(null);
    }
  };

  const copyMcp = () => {
    if (!mcp) return;
    navigator.clipboard.writeText(mcp.configToml).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const source = (field: SettingsField) => settings.sources[field];
  const saveRunner = () => {
    void save("runner", dirtyUpdate(runnerForm, runnerInitial));
  };

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="mb-6 text-[22px] font-bold tracking-tight text-fg">Settings</h1>

      <div className="flex flex-col gap-6">
        <Card title="Identity" description="Names shown in the interface and used to give agent prompts context.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Owner name" source={source("ownerName")}>
              <input
                className={INPUT}
                value={identityForm.ownerName}
                onChange={(event) => setIdentityForm((value) => ({ ...value, ownerName: event.target.value }))}
              />
            </Field>
            <Field label="Organization name" source={source("orgName")}>
              <input
                className={INPUT}
                value={identityForm.orgName}
                onChange={(event) => setIdentityForm((value) => ({ ...value, orgName: event.target.value }))}
              />
            </Field>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Button disabled={saving !== null} onClick={() => void save("identity", dirtyUpdate(identityForm, identityInitial))}>
              {saving === "identity" ? "Saving…" : "Save identity"}
            </Button>
            {saved === "identity" ? <span className="text-xs text-success">Saved.</span> : null}
          </div>
          {identityError ? <p role="alert" className="mt-3 text-xs text-danger">{identityError}</p> : null}
        </Card>

        <Card title="Provider" description="Choose the API used for new chats, embeddings, and voice transcription.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Provider" source={source("provider")}>
              <select
                className={INPUT}
                value={providerForm.provider}
                onChange={(event) => setProviderForm((value) => ({ ...value, provider: event.target.value }))}
              >
                {selectorOptions(settings.availableProviders, providerForm.provider).map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </Field>
            <Field label="Chat model" source={source("chatModel")}>
              <input
                className={INPUT}
                value={providerForm.chatModel}
                onChange={(event) => setProviderForm((value) => ({ ...value, chatModel: event.target.value }))}
              />
            </Field>
            <Field label="Embedding model" source={source("embedModel")}>
              <input
                className={INPUT}
                value={providerForm.embedModel}
                onChange={(event) => setProviderForm((value) => ({ ...value, embedModel: event.target.value }))}
              />
            </Field>
            <Field label="Transcription model" source={source("transcribeModel")}>
              <input
                className={INPUT}
                value={providerForm.transcribeModel}
                onChange={(event) =>
                  setProviderForm((value) => ({ ...value, transcribeModel: event.target.value }))
                }
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label="OpenAI-compatible base URL" source={source("openaiBaseUrl")}>
                <input
                  className={INPUT}
                  value={providerForm.openaiBaseUrl}
                  onChange={(event) =>
                    setProviderForm((value) => ({ ...value, openaiBaseUrl: event.target.value }))
                  }
                />
              </Field>
            </div>
          </div>
          <div className="mt-4 flex flex-col gap-2 rounded-md border border-border bg-side/40 px-3 py-2">
            <Status tone={settings.mistralApiKeyPresent ? "success" : "neutral"}>
              MISTRAL_API_KEY {settings.mistralApiKeyPresent ? "detected in environment" : "not detected"}
            </Status>
            <Status tone={settings.openaiApiKeyPresent ? "success" : "neutral"}>
              OPENAI_API_KEY {settings.openaiApiKeyPresent ? "detected in environment" : "not detected"}
            </Status>
          </div>
          <p className="mt-2 text-[11px] text-dim">API keys remain environment-only and are never stored in Boucle.</p>
          <div className="mt-4 flex items-center gap-3">
            <Button disabled={saving !== null} onClick={() => void save("provider", dirtyUpdate(providerForm, providerInitial))}>
              {saving === "provider" ? "Saving…" : "Save provider"}
            </Button>
            {saved === "provider" ? <span className="text-xs text-success">Saved.</span> : null}
          </div>
          {providerError ? <p role="alert" className="mt-3 text-xs text-danger">{providerError}</p> : null}
        </Card>

        <Card title="Loops runner" description="Choose the CLI used by default and optionally connect ticket chats to t3code.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Default runner" source={source("runner")}>
              <select
                className={INPUT}
                value={runnerForm.runner}
                onChange={(event) => setRunnerForm((value) => ({ ...value, runner: event.target.value }))}
              >
                {selectorOptions(settings.availableRunners, runnerForm.runner).map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </Field>
            <Field label="t3code project" source={source("t3codeProject")}>
              <input
                className={INPUT}
                value={runnerForm.t3codeProject}
                placeholder="Folder name or slug"
                onChange={(event) => setRunnerForm((value) => ({ ...value, t3codeProject: event.target.value }))}
              />
            </Field>
            <Field label="t3code URL" source={source("t3codeUrl")}>
              <input
                className={INPUT}
                value={runnerForm.t3codeUrl}
                placeholder="https://t3code.example"
                onChange={(event) => setRunnerForm((value) => ({ ...value, t3codeUrl: event.target.value }))}
              />
            </Field>
            <Field label="t3code token" source={source("t3codeToken")}>
              <input
                className={INPUT}
                type="password"
                value={runnerForm.t3codeToken}
                placeholder={settings.t3codeTokenPresent ? "Configured; leave blank to keep" : "Bearer token"}
                autoComplete="off"
                onChange={(event) => setRunnerForm((value) => ({ ...value, t3codeToken: event.target.value }))}
              />
            </Field>
          </div>
          <p className="mt-2 text-[11px] text-dim">
            t3code requires URL, token, and project. The token is write-only after saving.
          </p>
          <div className="mt-4 flex items-center gap-3">
            <Button disabled={saving !== null} onClick={saveRunner}>
              {saving === "runner" ? "Saving…" : "Save runner"}
            </Button>
            {settings.t3codeTokenPresent ? (
              <Button disabled={saving !== null} variant="outline" onClick={() => void save("runner", { t3codeToken: null })}>
                Clear t3code token
              </Button>
            ) : null}
            {saved === "runner" ? <span className="text-xs text-success">Saved.</span> : null}
          </div>
          {runnerError ? <p role="alert" className="mt-3 text-xs text-danger">{runnerError}</p> : null}
        </Card>

        <ExtensionsCard settings={settings} />

        <div className="border-t border-border pt-6">
          <h2 className="mb-1 text-sm font-medium text-fg">MCP tools for agent CLIs</h2>
          <p className="mb-3 text-xs text-muted">
            Boucle serves its ticket tools over MCP. Loop runs get this wired automatically; to point your own
            agent session at Boucle, use this endpoint in the CLI&apos;s MCP configuration
            (HTTP needs the server running; stdio works headless).
          </p>
          {mcp ? (
            <>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface px-3 py-2 font-mono text-[11px] leading-relaxed text-muted">
                {mcp.configToml}
              </pre>
              <div className="mt-2 flex items-center gap-3">
                <Button variant="outline" onClick={copyMcp}>Copy config</Button>
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
