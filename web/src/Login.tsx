import { useState, type FormEvent } from "react";

import { Mark } from "./ui.tsx";

interface LoginProps {
  /** Called with the typed token when the form is submitted. */
  onLogin: (token: string) => Promise<void>;
}

/**
 * Full-screen login gate that appears when `BOUCLE_AUTH_TOKEN` is set and the
 * browser has no valid session cookie. The operator pastes their token; the
 * server exchanges it for an httpOnly 30-day cookie and the app reloads.
 */
export function Login({ onLogin }: LoginProps) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    try {
      await onLogin(trimmed);
      // onLogin reloads the page; if it doesn't (e.g. auth disabled), clear the gate.
    } catch {
      setError("Incorrect token — check BOUCLE_AUTH_TOKEN and try again.");
      setLoading(false);
    }
  }

  return (
    <div className="flex h-full min-h-screen flex-col items-center justify-center bg-bg p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3">
          <Mark className="size-12 text-fg" />
          <div className="text-center">
            <h1 className="text-2xl font-bold tracking-tight text-fg">Boucle</h1>
            <p className="mt-1 text-sm text-muted">Enter the operator token to sign in</p>
          </div>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="token" className="block text-xs font-medium text-muted">
              Operator token
            </label>
            <input
              id="token"
              type="password"
              autoComplete="current-password"
              spellCheck={false}
              placeholder="Paste your token here"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={loading}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            />
          </div>

          {error && (
            <p className="rounded-md bg-pill-danger-bg px-3 py-2 text-xs text-pill-danger-fg">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading || !token.trim()}
            className="w-full rounded-full bg-btn px-4 py-2 text-sm font-semibold text-btn-fg transition-colors hover:bg-btn-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="text-center text-[11px] text-dim">
          The token is set via <code className="font-mono">BOUCLE_AUTH_TOKEN</code> in your{" "}
          <code className="font-mono">.env</code> file.
        </p>
      </div>
    </div>
  );
}
