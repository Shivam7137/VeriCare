"use client";

import { useId, useState, type FormEvent } from "react";
import { date, inputDate, windowInput, type Slot } from "../lib/ui";

export default function RequestForm({
  slots,
  busy,
  create,
  close,
}: {
  slots: Slot[];
  busy: boolean;
  create: (input: unknown) => Promise<void>;
  close: () => void;
}) {
  const headingId = useId();
  const [slotId, setSlotId] = useState("");
  const [start, setStart] = useState(() => inputDate());
  const [end, setEnd] = useState(() => inputDate(Date.now() + 3_600_000));
  const available = slots.filter((slot) => slot.available);
  const slot = available.find((item) => item.id === slotId);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!slot) return;
    const form = new FormData(event.currentTarget);
    await create({
      patientId: "synthetic-patient-001",
      appointmentId: "synthetic-appointment-001",
      availability: { startsAt: slot.startsAt, endsAt: slot.endsAt, timeZone: "UTC" },
      callbackWindow: windowInput(start, end),
      summary: form.get("summary"),
    });
  }
  return (
    <section className="panel" aria-labelledby={headingId}>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">A NEW REQUEST</p>
          <h2 id={headingId}>Find a better time</h2>
        </div>
        <button className="quiet" onClick={close} disabled={busy}>
          Cancel
        </button>
      </div>
      <p className="muted">
        Choose a preferred appointment and agree when we can contact you. All times on this demo are
        in UTC.
      </p>
      <form onSubmit={submit}>
        <fieldset disabled={busy}>
          <label>
            Preferred appointment
            <select
              aria-label="Preferred appointment"
              required
              value={slotId}
              onChange={(event) => setSlotId(event.target.value)}
            >
              <option value="">Choose an appointment</option>
              {slotId && !slot && (
                <option value={slotId}>Selected time is unavailable — choose again</option>
              )}
              {!available.length && <option value="">No available appointments</option>}
              {available.map((item) => (
                <option key={item.id} value={item.id}>
                  {date(item.startsAt)} – {date(item.endsAt).split(", ").at(-1)}
                </option>
              ))}
            </select>
          </label>
          <div className="field-pair">
            <label>
              Callback starts (UTC)
              <input
                aria-label="Callback starts (UTC)"
                type="datetime-local"
                required
                value={start}
                onChange={(event) => setStart(event.target.value)}
              />
            </label>
            <label>
              Callback ends (UTC)
              <input
                aria-label="Callback ends (UTC)"
                type="datetime-local"
                required
                min={start}
                value={end}
                onChange={(event) => setEnd(event.target.value)}
              />
            </label>
          </div>
          <p className="hint">
            The callback must finish before your preferred appointment. Leave the window open now to
            try the full demo.
          </p>
          <label>
            Request note
            <textarea
              aria-label="Request note"
              name="summary"
              required
              maxLength={500}
              rows={3}
              defaultValue="Please move my appointment to the selected time."
            />
          </label>
          <button className="primary" disabled={!slot}>
            {busy ? "Saving…" : "Create request"}
          </button>
        </fieldset>
      </form>
    </section>
  );
}
