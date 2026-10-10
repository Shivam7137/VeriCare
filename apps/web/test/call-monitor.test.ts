import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MonitorEntry } from "../components/call-monitor-feed";
Object.assign(globalThis, { React });

test("monitor renders escaped transcript text and labels interrupted generated speech", () => {
  const html = renderToStaticMarkup(
    createElement(MonitorEntry, {
      entry: {
        id: "turn-1",
        kind: "transcript",
        speaker: "assistant",
        label: "Assistant",
        status: "interrupted",
        at: "2026-10-10T12:00:00Z",
        text: "<script>alert(1)</script>",
      },
    }),
  );
  assert.match(html, /generated words may not all have been heard/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});
test("tool inspector exposes inputs, result, timing, and failed status", () => {
  const html = renderToStaticMarkup(
    createElement(MonitorEntry, {
      entry: {
        id: "tool-1",
        kind: "tool",
        label: "prepare_transfer",
        status: "failed",
        at: "2026-10-10T12:00:00Z",
        elapsedMs: 85,
        details: {
          arguments: { memberId: "doctor-1" },
          result: { error: "destination_not_configured" },
        },
      },
    }),
  );
  for (const text of [
    "Tool inputs &amp; result",
    "doctor-1",
    "destination_not_configured",
    "85 ms",
    "Failed",
  ])
    assert.ok(html.includes(text));
});
