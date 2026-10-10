"use client";
import { useEffect, useState } from "react";
import type { CareTeamDirectoryResult, VoiceTransfer } from "@prc/contracts";
import { api, date } from "../lib/ui";
import PhoneAccess, { type AccessCode, type PhoneConfiguration } from "./phone-access";
import TransferHistory from "./transfer-history";

type Pending = { id: string; description: string; expiresAt: string };
type SimulatedCall = { id: string; mode: string; status: string; pendingAction: Pending | null };
export default function TransferSimulator({
  directory,
  config,
}: {
  directory: CareTeamDirectoryResult;
  config: PhoneConfiguration | null;
}) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const [code, setCode] = useState<AccessCode | null>(null);
  const [call, setCall] = useState<SimulatedCall | null>(null);
  const [transfer, setTransfer] = useState<VoiceTransfer | null>(null);
  const [patientId, setPatientId] = useState("");
  const [memberId, setMemberId] = useState("");
  const [resolution, setResolution] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const request = <T,>(path: string, body?: unknown) =>
    api<T>(`/api/backend/voice/${path}`, body, undefined, "professional");
  const member = directory.members.find((item) => item.id === memberId);
  const pending = call?.mode === "simulated" ? call.pendingAction : null;
  const active = call?.mode === "simulated" && call.status === "in_progress";
  const canStart = !call || ["completed", "failed", "cancelled", "handoff"].includes(call.status);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (cause) {
      setError((cause as Error).message);
      // Recover the saved server state after stale/expired action errors.
      if (call)
        try {
          const [detail, history] = await Promise.all([
            request<SimulatedCall>(`calls/${call.id}`),
            request<VoiceTransfer[]>(`calls/${call.id}/transfers`),
          ]);
          setCall(detail);
          setTransfer(history.at(-1) ?? null);
        } catch {
          /* Keep last known state visible; the error remains actionable. */
        }
    } finally {
      setBusy(false);
    }
  }
  async function resolveDoctor() {
    await action(async () => {
      const result = await request<CareTeamDirectoryResult>(
        `directory?patientId=${encodeURIComponent(patientId)}&doctor=true`,
      );
      if (result.selection === "resolved" && result.members.length === 1) {
        setMemberId(result.members[0]!.id);
        setResolution(`Assigned doctor: ${result.members[0]!.name}.`);
      } else {
        setMemberId("");
        setResolution(
          result.selection === "ambiguous"
            ? "More than one doctor is assigned. Choose the intended doctor below."
            : "No assigned doctor was found. Choose a teammate explicitly.",
        );
      }
    });
  }
  return (
    <section className="panel transfer-simulator" id="phone" aria-labelledby="transfer-heading">
      <PhoneAccess
        config={config}
        code={code}
        busy={busy}
        staff
        generate={() => action(async () => setCode(await request<AccessCode>("access-codes", {})))}
      />
      <div className="simulator-heading">
        <span className="status">Simulation only</span>
        <h2 id="transfer-heading">Try a care-team transfer</h2>
        <p>
          This separate call demonstrates forwarding. No destination is dialled, even when the real
          phone line is enabled.
        </p>
      </div>
      {error && (
        <p className="phone-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <ol className="transfer-steps">
        <li className={!call ? "current" : "done"}>1. Start call</li>
        <li className={active && !pending ? "current" : ""}>2. Choose destination</li>
        <li className={pending ? "current" : ""}>3. Review & approve</li>
        <li className={transfer?.status === "dialing" ? "current" : ""}>4. Simulate result</li>
      </ol>
      {canStart && (
        <div className="simulation-start">
          <p>Use a fresh staff access code above to open a simulated call.</p>
          <button
            className="secondary"
            disabled={busy || !code || Date.parse(code.expiresAt) <= now}
            onClick={() =>
              action(async () => {
                const saved = await request<SimulatedCall>("simulate", { code: code!.code });
                if (saved.mode !== "simulated")
                  throw new Error("The simulated call could not start. No transfer was requested.");
                setCall(saved);
                setTransfer(null);
                setCode(null);
                setNotice("Simulated staff call started. No phone was dialled.");
              })
            }
          >
            Start simulated call
          </button>
        </div>
      )}
      {call && <p className="hint">Simulated call · {call.status.replaceAll("_", " ")}</p>}
      <fieldset disabled={busy || !active || !!pending} className="transfer-destination">
        <label>
          Patient context (optional)
          <select
            value={patientId}
            onChange={(event) => {
              setPatientId(event.target.value);
              setMemberId("");
              setResolution("");
            }}
          >
            <option value="">General care-team call</option>
            {directory.patients.map((patient) => (
              <option value={patient.id} key={patient.id}>
                {patient.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="secondary"
          disabled={!patientId || busy || !active || !!pending}
          onClick={resolveDoctor}
        >
          Find patient’s doctor
        </button>
        {resolution && (
          <p className="hint" role="status">
            {resolution}
          </p>
        )}
        <label>
          Transfer destination
          <select
            value={memberId}
            onChange={(event) => {
              setMemberId(event.target.value);
              setResolution("");
            }}
          >
            <option value="">Choose a teammate</option>
            {directory.members.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name} · {item.role}
              </option>
            ))}
          </select>
        </label>
        {member && (
          <p className="hint">
            {member.departmentName} ·{" "}
            {member.configured
              ? `Live destination configured (${member.maskedNumber})`
              : "No live number configured. Simulation is still available."}
          </p>
        )}
        <button
          className="primary"
          type="button"
          disabled={!member || busy || !active || !!pending}
          onClick={() =>
            action(async () => {
              const prepared = await request<{ pendingAction: Pending; transfer: VoiceTransfer }>(
                `calls/${call!.id}/transfers`,
                { memberId, ...(patientId ? { patientId } : {}) },
              );
              setTransfer(prepared.transfer);
              setCall({ ...call!, pendingAction: prepared.pendingAction });
            })
          }
        >
          Prepare simulated transfer
        </button>
      </fieldset>
      {pending && (
        <div className="pending-voice-action">
          <p className="eyebrow">Review this exact simulated transfer</p>
          <p>{pending.description}</p>
          <p className="hint">
            Expires {date(pending.expiresAt)}. This approval applies only to the destination above.{" "}
            {Date.parse(pending.expiresAt) <= now &&
              "This action expired. Cancel it, then prepare a fresh transfer."}
          </p>
          <div className="phone-buttons">
            <button
              className="primary"
              disabled={busy || Date.parse(pending.expiresAt) <= now}
              onClick={() =>
                action(async () => {
                  const result = await request<{ transfer: VoiceTransfer }>(
                    `calls/${call!.id}/confirm`,
                    { actionId: pending.id },
                  );
                  setTransfer(result.transfer);
                  setCall(await request<SimulatedCall>(`calls/${call!.id}`));
                  setNotice(
                    "Simulated transfer dispatched. Choose a simulated result below; connection is not yet confirmed.",
                  );
                })
              }
            >
              Approve simulated transfer
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                action(async () => {
                  await request(`calls/${call!.id}/cancel`, {});
                  setCall({ ...call!, pendingAction: null });
                  setTransfer(transfer ? { ...transfer, status: "cancelled" } : null);
                  setNotice("Simulated transfer cancelled. No phone was dialled.");
                })
              }
            >
              Cancel transfer
            </button>
          </div>
        </div>
      )}
      {transfer?.status === "dialing" && (
        <div className="simulated-result">
          <h3>Choose the simulated call result</h3>
          <p>This selection demonstrates an outcome; it is not evidence of a real connection.</p>
          <div className="phone-buttons">
            {(["connected", "no-answer", "busy", "failed"] as const).map((status) => (
              <button
                key={status}
                className="secondary"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    const result = await request<VoiceTransfer>(
                      `transfers/${transfer.id}/simulate-result`,
                      { status },
                    );
                    setTransfer(result);
                    setCall(await request<SimulatedCall>(`calls/${call!.id}`));
                    setNotice(
                      `Simulated result saved: ${status.replaceAll("-", " ")}. Appointment status is unchanged.`,
                    );
                  })
                }
              >
                Simulate {status.replaceAll("-", " ")}
              </button>
            ))}
          </div>
        </div>
      )}
      {active && (
        <button
          className="quiet"
          disabled={busy}
          onClick={() =>
            action(async () => {
              await request(`calls/${call!.id}/end`, {});
              setCall(await request<SimulatedCall>(`calls/${call!.id}`));
              setNotice("Simulated call ended.");
            })
          }
        >
          End simulated call
        </button>
      )}
      {call && (
        <TransferHistory key={`${call.id}:${transfer?.status ?? "none"}`} callId={call.id} />
      )}
    </section>
  );
}
