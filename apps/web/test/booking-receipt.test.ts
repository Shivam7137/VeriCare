import { seededTask } from "@prc/contracts";
import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
// The root tsx test runner uses the classic JSX transform for imported components.
Object.assign(globalThis, { React });
import { renderToStaticMarkup } from "react-dom/server";
import RequestDetail from "../components/request-detail";
import { RequestInspector } from "../components/desktop-panels";
import { date, type Booking, type Progress } from "../lib/ui";
import type { DesktopProgress } from "../lib/desktop";

const savedBooking: Booking = {
  id: "appointment-1",
  patientId: "patient-1",
  startsAt: "2026-10-15T14:30:00Z",
  endsAt: "2026-10-15T15:00:00Z",
};
const currentBooking: Booking = {
  ...savedBooking,
  startsAt: "2026-10-20T16:30:00Z",
  endsAt: "2026-10-20T17:00:00Z",
};
const completed: Progress = {
  task: {
    ...seededTask,
    id: "first-request",
    state: "completed",
    patientId: "patient-1",
    requesterId: "patient-actor",
    summary: "First reschedule",
  },
  booking: currentBooking,
  workflow: null,
  activeProposal: null,
  actions: [],
  events: [],
  jobs: [],
  operation: {
    status: "confirmed",
    result: { status: "confirmed", confirmationRef: "first-saved-receipt", booking: savedBooking },
    lastError: null,
  },
};
const views = {
  patient: (progress: Progress) =>
    createElement(RequestDetail, {
      progress,
      actor: { id: "patient-actor", role: "patient" },
      slots: [],
      busy: false,
      command: async () => {},
    }),
  overview: (progress: Progress) =>
    createElement(RequestInspector, { progress: progress as DesktopProgress }),
};
for (const [name, view] of Object.entries(views)) {
  test(`${name} binds a completed receipt to its saved booking after a later reschedule`, () => {
    const html = renderToStaticMarkup(view(completed));
    assert.ok(html.includes("first-saved-receipt"));
    assert.ok(
      html.includes(date(savedBooking.startsAt)),
      "The receipt must retain the appointment time saved by this operation",
    );
    assert.ok(
      !html.includes(date(currentBooking.startsAt)),
      "A later appointment change must not replace the original receipt time",
    );
  });
  test(`${name} never substitutes the current booking if a receipt has no booking snapshot`, () => {
    const withoutSnapshot = {
      ...completed,
      operation: { ...completed.operation!, result: { confirmationRef: "first-saved-receipt" } },
    };
    const html = renderToStaticMarkup(view(withoutSnapshot));
    assert.ok(html.includes("first-saved-receipt"));
    assert.ok(!html.includes(date(currentBooking.startsAt)));
  });
}
