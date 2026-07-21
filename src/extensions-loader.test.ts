import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Hono } from "hono";

import { emit } from "./extensions/events.ts";
import { loadExtensions, viewExtensionSettings } from "./extensions/loader.ts";
import { isKnownProviderName, isKnownRunnerName } from "./selectors.ts";
import { BoucleStore } from "./store.ts";
import { listTools } from "./tools/registry.ts";

let counter = 0;
function uniqueName(prefix: string): string {
  return `${prefix}-${counter++}`;
}

function tmpBase(): string {
  return mkdtempSync(join(tmpdir(), "boucle-ext-"));
}

function newStore(base: string): BoucleStore {
  return new BoucleStore(join(base, "boucle.db"));
}

/** An external-style extension: a plain default-exported object (no definePlugin import). */
function writeExt(base: string, name: string, body: string): void {
  mkdirSync(join(base, name), { recursive: true });
  writeFileSync(join(base, name, "index.ts"), `export default {\n  name: ${JSON.stringify(name)},\n${body}\n};\n`);
}

function writePage(base: string, name: string): void {
  mkdirSync(join(base, name, "web"), { recursive: true });
  writeFileSync(join(base, name, "web", "index.html"), "<!doctype html><title>test</title>");
}

function toolPrefix(name: string): string {
  return name.replace(/-/g, "_");
}

test("loads a good extension and registers a prefixed read-only tool", async () => {
  const base = tmpBase();
  const name = uniqueName("good");
  writeExt(
    base,
    name,
    `  version: "1.2.3",
  description: "a good one",
  setup(ctx) {
    ctx.registerPage({ label: "Hi", icon: "puzzle" });
    ctx.registerRoute("get", "/ping", (c) => c.json({ ok: true }));
    ctx.registerTool({ name: "ping", title: "Ping", description: "pong", schema: {}, readOnly: true, handler: () => ({ pong: true }) });
  },`,
  );
  writePage(base, name);
  const app = new Hono();
  const loaded = await loadExtensions({ store: newStore(base), dirs: [base], app });
  const ext = loaded.find((e) => e.name === name);
  assert.ok(ext);
  assert.equal(ext.status, "active");
  assert.equal(ext.version, "1.2.3");
  assert.equal(ext.routeCount, 1);
  assert.deepEqual(ext.pages, [{ label: "Hi", icon: "puzzle" }]);
  assert.deepEqual(ext.toolNames, [`${toolPrefix(name)}_ping`]);

  const tool = listTools().find((t) => t.name === `${toolPrefix(name)}_ping`);
  assert.ok(tool, "the prefixed tool is in the shared registry");
  assert.equal(tool.readOnly, true);
  assert.deepEqual(await tool.handler({ store: newStore(base) }, {}), { pong: true });
  assert.deepEqual(await (await app.request(`/api/ext/${name}/ping`)).json(), { ok: true });
});

test("isolates a broken extension; siblings still load", async () => {
  const base = tmpBase();
  const good = uniqueName("ok");
  const bad = uniqueName("boom");
  writeExt(base, good, `  setup() {},`);
  writeExt(base, bad, `  setup() { throw new Error("kaboom"); },`);
  const loaded = await loadExtensions({ store: newStore(base), dirs: [base] });
  assert.equal(loaded.find((e) => e.name === good)?.status, "active");
  const badExt = loaded.find((e) => e.name === bad);
  assert.equal(badExt?.status, "error");
  assert.match(badExt?.error ?? "", /kaboom/);
});

test("a setup failure leaves no tools, handlers, runners, or providers registered", async () => {
  const base = tmpBase();
  const name = uniqueName("atomic");
  const runner = uniqueName("runner");
  const provider = uniqueName("provider");
  const eventFlag = `__boucle_${toolPrefix(name)}`;
  writeExt(
    base,
    name,
    `  setup(ctx) {
    ctx.registerTool({ name: "staged", title: "Staged", description: "test", schema: {}, readOnly: true, handler: () => ({}) });
    ctx.on("settings.changed", () => { globalThis[${JSON.stringify(eventFlag)}] = true; });
    ctx.registerRunner({ name: ${JSON.stringify(runner)}, exec: async () => ({}), readTranscript: async () => null });
    ctx.registerProvider(${JSON.stringify(provider)}, () => ({}));
    throw new Error("setup failed");
  },`,
  );

  const loaded = await loadExtensions({ store: newStore(base), dirs: [base] });
  assert.equal(loaded[0]?.status, "error");
  assert.equal(listTools().some((tool) => tool.name === `${toolPrefix(name)}_staged`), false);
  assert.equal(isKnownRunnerName(runner), false);
  assert.equal(isKnownProviderName(provider), false);

  emit("settings.changed", { keys: [] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((globalThis as Record<string, unknown>)[eventFlag], undefined);
});

test("a registration conflict rolls back earlier registrations", async () => {
  const base = tmpBase();
  const name = uniqueName("conflict");
  writeExt(
    base,
    name,
    `  setup(ctx) {
    ctx.registerTool({ name: "staged", title: "Staged", description: "test", schema: {}, readOnly: true, handler: () => ({}) });
    ctx.registerRunner({ name: "vibe", exec: async () => ({}), readTranscript: async () => null });
  },`,
  );

  const loaded = await loadExtensions({ store: newStore(base), dirs: [base] });
  assert.equal(loaded[0]?.status, "error");
  assert.match(loaded[0]?.error ?? "", /runner already registered/);
  assert.equal(listTools().some((tool) => tool.name === `${toolPrefix(name)}_staged`), false);
});

test("respects the disabled flag and skips setup", async () => {
  const base = tmpBase();
  const name = uniqueName("off");
  writeExt(
    base,
    name,
    `  setup(ctx) { ctx.registerTool({ name: "nope", title: "n", description: "n", schema: {}, readOnly: true, handler: () => ({}) }); },`,
  );
  const store = newStore(base);
  store.setMeta(`ext.${name}.enabled`, "0");
  const loaded = await loadExtensions({ store, dirs: [base] });
  assert.equal(loaded.find((e) => e.name === name)?.status, "disabled");
  assert.equal(listTools().find((t) => t.name === `${toolPrefix(name)}_nope`), undefined, "setup never ran");
});

test("a duplicate extension name across dirs is skipped with an error", async () => {
  const a = tmpBase();
  const b = tmpBase();
  const name = uniqueName("dup");
  writeExt(a, name, `  version: "1.0.0",\n  setup() {},`);
  writeExt(b, name, `  version: "2.0.0",\n  setup() {},`);
  const loaded = await loadExtensions({ store: newStore(a), dirs: [a, b] });
  const dups = loaded.filter((e) => e.name === name);
  assert.equal(dups.length, 2);
  assert.equal(dups[0]?.status, "active");
  assert.equal(dups[0]?.version, "1.0.0");
  assert.equal(dups[1]?.status, "error");
  assert.match(dups[1]?.error ?? "", /duplicate/);
});

test("the manifest name must match its directory namespace", async () => {
  const base = tmpBase();
  const directoryName = uniqueName("directory");
  const manifestName = uniqueName("manifest");
  mkdirSync(join(base, directoryName), { recursive: true });
  writeFileSync(
    join(base, directoryName, "index.ts"),
    `export default { name: ${JSON.stringify(manifestName)}, setup() {} };\n`,
  );

  const loaded = await loadExtensions({ store: newStore(base), dirs: [base] });
  assert.equal(loaded[0]?.status, "error");
  assert.match(loaded[0]?.error ?? "", /does not match directory name/);
});

test("setting keys cannot alias the enabled flag or KV namespace", async () => {
  const base = tmpBase();
  const enabled = uniqueName("reserved-enabled");
  const kv = uniqueName("reserved-kv");
  writeExt(base, enabled, `  settings: [{ key: "enabled" }],\n  setup() {},`);
  writeExt(base, kv, `  settings: [{ key: "kv.token" }],\n  setup() {},`);

  const loaded = await loadExtensions({ store: newStore(base), dirs: [base] });
  assert.equal(loaded.find((ext) => ext.name === enabled)?.status, "error");
  assert.equal(loaded.find((ext) => ext.name === kv)?.status, "error");
});

test("kv writes are namespaced under ext.<name>.kv.", async () => {
  const base = tmpBase();
  const name = uniqueName("kv");
  writeExt(base, name, `  setup(ctx) { ctx.kv.set("token", "abc"); },`);
  const store = newStore(base);
  await loadExtensions({ store, dirs: [base] });
  assert.equal(store.getMeta(`ext.${name}.kv.token`), "abc");
  assert.equal(store.getMeta("token"), null, "not written to the bare key");
});

test("declared settings report their source without exposing environment values", async () => {
  const base = tmpBase();
  const name = uniqueName("cfg");
  const envVar = `BOUCLE_TEST_${toolPrefix(name).toUpperCase()}`;
  writeExt(
    base,
    name,
    `  settings: [{ key: "topic", label: "Topic", env: ${JSON.stringify(envVar)} }],
  setup(ctx) {
    ctx.registerTool({ name: "setting", title: "Setting", description: "test", schema: {}, readOnly: true, handler: () => ctx.settings.get("topic") });
  },`,
  );
  const store = newStore(base);
  const loaded = await loadExtensions({ store, dirs: [base] });
  const ext = loaded.find((e) => e.name === name);
  assert.ok(ext);

  assert.equal(viewExtensionSettings(store, ext)[0]?.source, "unset");

  process.env[envVar] = "from-env";
  let view = viewExtensionSettings(store, ext)[0];
  assert.equal(view?.value, "");
  assert.equal(view?.source, "env");
  const tool = listTools().find((candidate) => candidate.name === `${toolPrefix(name)}_setting`);
  assert.ok(tool);
  assert.equal(await tool.handler({ store }, {}), "from-env");

  store.setMeta(`ext.${name}.topic`, "from-meta");
  view = viewExtensionSettings(store, ext)[0];
  assert.equal(view?.value, "from-meta");
  assert.equal(view?.source, "meta");

  delete process.env[envVar];
});
