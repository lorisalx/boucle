import assert from "node:assert/strict";
import test from "node:test";

import { emit, on } from "./extensions/events.ts";

function handlersSettled(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("a throwing event handler does not affect sibling handlers or the emitter", async () => {
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  let handled = 0;
  try {
    on("server.started", function brokenHandler() {
      throw new Error("broken extension");
    });
    on("server.started", () => {
      handled += 1;
    });

    assert.doesNotThrow(() => emit("server.started", { port: 4519 }));
    assert.equal(handled, 0);
    await handlersSettled();

    assert.equal(handled, 1);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]?.[0]), /handler for server\.started failed: broken extension/);
  } finally {
    console.error = originalError;
  }
});

test("an async handler rejection is caught", async () => {
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  let handled = false;
  try {
    on("settings.changed", async function rejectingHandler() {
      await Promise.resolve();
      throw new Error("async rejection");
    });
    on("settings.changed", async () => {
      await Promise.resolve();
      handled = true;
    });

    assert.doesNotThrow(() => emit("settings.changed", { keys: ["provider"] }));
    await handlersSettled();

    assert.equal(handled, true);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]?.[0]), /handler for settings\.changed failed: async rejection/);
  } finally {
    console.error = originalError;
  }
});
