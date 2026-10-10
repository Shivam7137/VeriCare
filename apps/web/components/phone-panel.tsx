"use client";

import { useEffect, useState } from "react";
import type { CreateTaskInput, Task } from "@prc/contracts";
import {
  api,
  date,
  inputDate,
  labels,
  windowInput,
  type Actor,
  type Slot,
  type Booking,
} from "../lib/ui";
import RequestForm from "./request-form";
import "../app/phone.css";

type Pending = { id: string; kind: string; description: string; expiresAt: string };
type Call = {
  id: string;
  taskId: string | null;
  mode: string;
  direction: string;
  status: string;
  maskedNumber: string | null;
  dueAt: string | null;
  createdAt: string;
  lastError: string | null;
  pendingAction: Pending | null;
  events?: { id?: string; kind: string; createdAt: string }[];
};
type Configuration = {
  mode: "simulated" | "twilio";
  ready: boolean;
  liveReady: boolean;
  missing: string[];
  invalid: string[];
  agents: { id: string; name: string; description: string }[];
};
type Props = {
  actor: Actor;
  taskId?: string;
  portal: "patient" | "professional";
  bookings?: Booking[];
};

export default function PhonePanel({ actor, taskId, portal, bookings }: Props) {
  const [config, setConfig] = useState<Configuration | null>(null);
  const [calls, setCalls] = useState<Call[]>([]);
  const [selected, setSelected] = useState("");
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [number, setNumber] = useState("+15555550123");
  const [dueAt, setDueAt] = useState(() => inputDate(Date.now() + 120_000));
  const [start, setStart] = useState(() => inputDate());
  const [end, setEnd] = useState(() => inputDate(Date.now() + 3_600_000));
  const [intake, setIntake] = useState(false);
  const [slots, setSlots] = useState<Slot[]>([]);
  const professional = portal === "professional";
  const visibleCalls =
    professional || !taskId ? calls : calls.filter((call) => call.taskId === taskId);
  const call = visibleCalls.find((item) => item.id === selected) ?? visibleCalls[0];
  const active = call?.status === "in_progress";
  const request = <T,>(path: string, body?: unknown) =>
    api<T>(`/api/backend/voice/${path}`, body, undefined, portal);
  useEffect(() => {
    setCode(null);
    setMessage("");
    setIntake(false);
  }, [taskId, actor.id]);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const [settings, history] = await Promise.all([
          api<Configuration>("/api/backend/voice/config", undefined, undefined, portal),
          api<{ calls: Call[] }>("/api/backend/voice/calls", undefined, undefined, portal),
        ]);
        if (!disposed) {
          setConfig(settings);
          setCalls(history.calls);
        }
      } catch (cause) {
        if (!disposed) setError((cause as Error).message);
      }
      if (!disposed) timer = setTimeout(poll, 3000);
    }
    if (!busy) void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [actor.id, portal, busy]);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
      const history = await request<{ calls: Call[] }>("calls");
      setCalls(history.calls);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function runTool(name: string, args: Record<string, unknown> = {}) {
    if (!call) return;
    await action(async () => {
      const result = await request<{
        status?: string;
        message?: string;
        task?: Task;
        pendingAction?: Pending;
      }>(`calls/${call.id}/tool`, { toolCallId: crypto.randomUUID(), name, arguments: args });
      setMessage(
        result.pendingAction
          ? "Review the action below before approving it."
          : result.task
            ? `${labels[result.task.state]}: ${result.task.nextAction}`
            : (result.message ?? "The assistant checked the current request."),
      );
    });
  }
  return (
    <section className="panel phone-panel" aria-labelledby={`phone-${portal}`}>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{professional ? "VOICE OPERATIONS" : "PHONE ASSISTANT"}</p>
          <h2 id={`phone-${portal}`}>
            {professional ? "Calls & AI coordination" : "Talk through your next step"}
          </h2>
        </div>
        <span className="status">
          {config?.mode === "twilio" ? "Twilio mode" : "Simulation mode"}
        </span>
      </div>
      <p className="muted">
        {professional
          ? "Follow verified calls, callback requests and handovers to the care team."
          : "Get appointment help by phone. An access code connects the call to your portal identity; your number alone never grants access."}
      </p>
      {!config?.liveReady && (
        <div className="phone-note">
          {config?.mode === "twilio"
            ? "Live calls are unavailable until provider configuration is complete."
            : professional
              ? "Simulation is available now. Configure the phone and AI providers to enable real test calls."
              : "Try a simulated call now. Real phone calls have not been enabled yet."}
        </div>
      )}
      {error && (
        <p role="alert" className="phone-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {!professional && (
        <>
          <div className="phone-buttons">
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                action(async () => setCode(await request("access-codes", taskId ? { taskId } : {})))
              }
            >
              Get phone access code
            </button>
            {config?.mode === "simulated" && (
              <button
                className="primary"
                disabled={busy || !code || Date.parse(code.expiresAt) <= Date.now()}
                onClick={() =>
                  action(async () => {
                    const saved = await request<Call>("simulate", { code: code!.code });
                    setSelected(saved.id);
                    setCode(null);
                    setMessage("Simulated call connected. No phone number was dialled.");
                  })
                }
              >
                Start simulated call
              </button>
            )}
          </div>
          {code && (
            <div className="access-code" role="status">
              <span>One-time access code</span>
              <strong>{code.code}</strong>
              <small>
                Expires {date(code.expiresAt)}. Enter it when the phone assistant asks. Never share
                it with someone else.
              </small>
            </div>
          )}
          <p className="hint">
            {taskId
              ? "This code is limited to the selected appointment request."
              : "With no selected request, the assistant can help prepare a new request."}
          </p>
          {taskId && (
            <details className="phone-schedule">
              <summary>Schedule a callback</summary>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void action(async () => {
                    const saved = await request<Call>("callbacks", {
                      taskId,
                      to: number,
                      dueAt: new Date(dueAt + ":00Z").toISOString(),
                    });
                    setSelected(saved.id);
                    setMessage(
                      "Callback queued within the agreed window. Have a fresh access code ready when it rings.",
                    );
                  });
                }}
              >
                <div className="field-pair">
                  <label>
                    Callback number
                    <input
                      aria-label="Callback number"
                      type="tel"
                      required
                      value={number}
                      onChange={(event) => setNumber(event.target.value)}
                      pattern="\+[1-9][0-9]{7,14}"
                    />
                  </label>
                  <label>
                    Call at (UTC)
                    <input
                      aria-label="Call at (UTC)"
                      type="datetime-local"
                      required
                      value={dueAt}
                      onChange={(event) => setDueAt(event.target.value)}
                    />
                  </label>
                </div>
                <p className="hint">
                  Choose a time inside this request's agreed callback window. In simulation the
                  number is never dialled. Live tests require an allowlisted number.
                </p>
                <button className="secondary" disabled={busy}>
                  Queue callback
                </button>
              </form>
            </details>
          )}
        </>
      )}
      {!!visibleCalls.length && (
        <label className="call-selector">
          {professional ? "Call history" : "Your calls"}
          <select
            aria-label={professional ? "Call history" : "Your calls"}
            value={call?.id ?? ""}
            disabled={busy}
            onChange={(event) => {
              setSelected(event.target.value);
              setMessage("");
              setIntake(false);
            }}
          >
            {visibleCalls.map((item) => (
              <option key={item.id} value={item.id}>
                {item.direction} · {item.status.replaceAll("_", " ")} · {date(item.createdAt)}
              </option>
            ))}
          </select>
        </label>
      )}
      {call ? (
        <div className="call-card">
          <div className="call-facts">
            <span className="status">{call.status.replaceAll("_", " ")}</span>
            <span>
              {call.direction === "outbound" ? "Scheduled callback" : "Incoming call"}
              {call.maskedNumber ? ` · ${call.maskedNumber}` : ""}
            </span>
          </div>
          {call.dueAt && <p className="hint">Scheduled for {date(call.dueAt)}</p>}
          {call.lastError && <p className="phone-error">{call.lastError.replaceAll("_", " ")}</p>}
          {call.status === "handoff" && (
            <p className="phone-note">
              The caller requested a healthcare professional. Call automation is stopped. Review the
              request and use staff takeover if further booking actions need to stop.
            </p>
          )}
          {!professional &&
            call.mode === "simulated" &&
            ["ringing", "awaiting_verification"].includes(call.status) && (
              <button
                className="primary"
                disabled={busy || !code}
                onClick={() =>
                  action(async () => {
                    await request(`calls/${call.id}/verify`, { code: code!.code });
                    setCode(null);
                    setMessage("Callback identity verified.");
                  })
                }
              >
                Answer simulated callback with access code
              </button>
            )}
          {!professional && active && call.mode === "simulated" && (
            <>
              <p className="hint">
                These controls simulate the agent's tools. During a live call, the AI asks questions
                and reads each proposed action back to you.
              </p>
              <div className="phone-buttons">
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => runTool("get_request_status")}
                >
                  Ask for progress
                </button>
                {call.taskId ? (
                  <>
                    <button
                      className="secondary"
                      disabled={busy || !!call.pendingAction}
                      onClick={() => runTool("prepare_confirmation", { response: "approve" })}
                    >
                      Ask to confirm proposal
                    </button>
                    <button
                      className="quiet danger"
                      disabled={busy || !!call.pendingAction}
                      onClick={() => runTool("prepare_withdrawal")}
                    >
                      Ask to withdraw request
                    </button>
                  </>
                ) : (
                  <button
                    className="secondary"
                    disabled={busy || !!call.pendingAction}
                    onClick={() =>
                      action(async () => {
                        const data = await api<{ slots: Slot[] }>(
                          "/api/backend/slots?patientId=synthetic-patient-001",
                          undefined,
                          undefined,
                          portal,
                        );
                        setSlots(data.slots);
                        setIntake(true);
                      })
                    }
                  >
                    Prepare a new request
                  </button>
                )}
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => runTool("request_human")}
                >
                  Ask for a professional
                </button>
              </div>
              {call.taskId && (
                <details>
                  <summary>Ask to change the callback window</summary>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void runTool("prepare_callback", { callbackWindow: windowInput(start, end) });
                    }}
                  >
                    <div className="field-pair">
                      <label>
                        Assistant callback starts (UTC)
                        <input
                          aria-label="Assistant callback starts (UTC)"
                          type="datetime-local"
                          required
                          value={start}
                          onChange={(event) => setStart(event.target.value)}
                        />
                      </label>
                      <label>
                        Assistant callback ends (UTC)
                        <input
                          aria-label="Assistant callback ends (UTC)"
                          type="datetime-local"
                          required
                          value={end}
                          onChange={(event) => setEnd(event.target.value)}
                        />
                      </label>
                    </div>
                    <button className="secondary" disabled={busy || !!call.pendingAction}>
                      Prepare callback change
                    </button>
                  </form>
                </details>
              )}
              {intake && !call.taskId && (
                <RequestForm
                  slots={slots}
                  bookings={bookings}
                  busy={busy}
                  close={() => setIntake(false)}
                  create={async (raw) => {
                    const { patientId: _, ...input } = raw as CreateTaskInput;
                    await runTool("prepare_request", input);
                    setIntake(false);
                  }}
                />
              )}
            </>
          )}
          {call.pendingAction && (
            <div className="pending-voice-action">
              <p className="eyebrow">PATIENT CONFIRMATION REQUIRED</p>
              <p>{call.pendingAction.description}</p>
              <p className="hint">
                Expires {date(call.pendingAction.expiresAt)}. During a call press 1 to approve or 2
                to cancel.
              </p>
              {!professional && (
                <div className="phone-buttons">
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      action(async () => {
                        await request(`calls/${call.id}/confirm`, {
                          actionId: call.pendingAction!.id,
                        });
                        setMessage(
                          "Your action was submitted to the backend. Check the request for the confirmed outcome.",
                        );
                      })
                    }
                  >
                    Approve this action
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      action(async () => {
                        await request(`calls/${call.id}/cancel`, {});
                        setMessage("Pending action cancelled.");
                      })
                    }
                  >
                    Cancel this action
                  </button>
                </div>
              )}
            </div>
          )}
          {!professional &&
            !["completed", "cancelled", "failed", "handoff"].includes(call.status) && (
              <button
                className="quiet danger"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await request(`calls/${call.id}/end`, {});
                    setMessage("Call ended. The appointment request keeps its saved state.");
                  })
                }
              >
                End call
              </button>
            )}
          <p className="reference">
            Call {call.id}
            {call.taskId ? ` · Request ${call.taskId}` : " · New-request intake"}
          </p>
        </div>
      ) : (
        <p className="muted">
          {professional ? "No calls in this department yet." : "No calls for this request yet."}
        </p>
      )}
      {professional && config && (
        <details className="provider-setup">
          <summary>Provider setup & agent responsibilities</summary>
          <div className="agent-cards">
            {config.agents.map((agent) => (
              <div key={agent.id}>
                <h3>{agent.name}</h3>
                <p>{agent.description}</p>
              </div>
            ))}
          </div>
          <p>
            {config.liveReady
              ? "Provider configuration is present. Live test calls are explicitly enabled."
              : "Live configuration is incomplete or disabled."}
          </p>
          {!!config.missing.length && (
            <p className="hint">Required configuration: {config.missing.join(", ")}</p>
          )}
          {!!config.invalid.length && (
            <p className="phone-error">Check: {config.invalid.join(", ")}</p>
          )}
          <p className="hint">
            Add credentials privately to the server environment using docs/phone-setup.md. No keys
            belong in this page or chat. Audio and verbatim transcripts are not stored.
          </p>
        </details>
      )}
    </section>
  );
}
