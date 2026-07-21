// Mutable name registries for provider/runner selectors.
//
// A deliberate leaf module (imports nothing) so that settings.ts and store.ts can
// validate a selector against the *live* set of names without importing the runner
// or provider registries — which would form a cycle, since those import settings.ts.
// runner.ts / providers register their names here as they register the real thing.

const runnerNames = new Set<string>(["vibe", "codex", "claude"]);
const providerNames = new Set<string>(["mistral", "openai"]);

export function registerRunnerName(name: string): void {
  runnerNames.add(name);
}

export function knownRunnerNames(): string[] {
  return [...runnerNames];
}

export function isKnownRunnerName(name: string): boolean {
  return runnerNames.has(name);
}

export function registerProviderName(name: string): void {
  providerNames.add(name);
}

export function knownProviderNames(): string[] {
  return [...providerNames];
}

export function isKnownProviderName(name: string): boolean {
  return providerNames.has(name);
}
