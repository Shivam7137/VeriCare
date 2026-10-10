"use client";
import { useEffect, useState } from "react";
import type { VoiceTransfer } from "@prc/contracts";
import { api, date } from "../lib/ui";
import type { Portal } from "../lib/portal";
export default function TransferHistory({
  callId,
  portal = "professional",
}: {
  callId: string;
  portal?: Portal;
}) {
  const [transfers, setTransfers] = useState<VoiceTransfer[] | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    setTransfers(null);
    setError("");
    async function load() {
      try {
        const data = await api<VoiceTransfer[]>(
          `/api/backend/voice/calls/${callId}/transfers`,
          undefined,
          undefined,
          portal,
        );
        if (active) {
          setTransfers(data);
          setError("");
        }
      } catch (cause) {
        if (active) setError((cause as Error).message);
      }
      if (active) timer = setTimeout(load, 5000);
    }
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [callId, portal, retry]);
  if (error)
    return (
      <p className="phone-error" role="alert">
        Transfer history unavailable.{" "}
        <button className="quiet" onClick={() => setRetry((value) => value + 1)}>
          Retry
        </button>
      </p>
    );
  if (!transfers) return <p className="hint">Loading transfer history…</p>;
  if (!transfers.length) return null;
  return (
    <section className="transfer-history" aria-label="Transfer history">
      <h3>Forwarding history</h3>
      {transfers.map((transfer) => (
        <div key={transfer.id}>
          <strong>{transfer.destinationName}</strong>
          <span>
            {transfer.mode === "simulated" ? "Simulated" : "Real phone"} ·{" "}
            {transfer.status.replaceAll("_", " ")}
          </span>
          <time dateTime={transfer.updatedAt}>{date(transfer.updatedAt)}</time>
          {["dialing", "dispatching", "reconciling"].includes(transfer.status) && (
            <p>Connection outcome is not yet confirmed.</p>
          )}
        </div>
      ))}
    </section>
  );
}
