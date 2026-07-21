import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadExtensions, viewExtensionSettings } from "./extensions/loader.ts";
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
  const loaded = await loadExtensions({ store: newStore(base), dirs: [base] });
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

test("kv writes are namespaced under ext.<name>.kv.", async () => {
  const base = tmpBase();
  const name = uniqueName("kv");
  writeExt(base, name, `  setup(ctx) { ctx.kv.set("token", "abc"); },`);
  const store = newStore(base);
  await loadExtensions({ store, dirs: [base] });
  assert.equal(store.getMeta(`ext.${name}.kv.token`), "abc");
  assert.equal(store.getMeta("token"), null, "not written to the bare key");
});

test("declared settings resolve meta over env over unset", async () => {
  const base = tmpBase();
  const name = uniqueName("cfg");
  const envVar = `BOUCLE_TEST_${toolPrefix(name).toUpperCase()}`;
  writeExt(base, name, `  settings: [{ key: "topic", label: "Topic", env: ${JSON.stringify(envVar)} }],\n  setup() {},`);
  const store = newStore(base);
  const loaded = await loadExtensions({ store, dirs: [base] });
  const ext = loaded.find((e) => e.name === name);
  assert.ok(ext);

  assert.equal(viewExtensionSettings(store, ext)[0]?.source, "unset");

  process.env[envVar] = "from-env";
  let view = viewExtensionSettings(store, ext)[0];
  assert.equal(view?.value, "from-env");
  assert.equal(view?.source, "env");

  store.setMeta(`ext.${name}.topic`, "from-meta");
  view = viewExtensionSettings(store, ext)[0];
  assert.equal(view?.value, "from-meta");
  assert.equal(view?.source, "meta");

  delete process.env[envVar];
});
