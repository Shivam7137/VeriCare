"use client";
import { useState, type FormEvent } from "react";
import { journey, type LiveVisit } from "../lib/journey";
import { Icon } from "./journey-icons";

/** Who else gets updates. The patient chooses each person and what they hear. */
export default function VisitFamily({
  visit,
  refresh,
}: {
  visit: LiveVisit;
  refresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [relationship, setRelationship] = useState("");
  const [phone, setPhone] = useState("");
  const [estimates, setEstimates] = useState(true);
  const [error, setError] = useState("");
  /** Which field the error is about, so it shows next to that field. */
  const [errorAt, setErrorAt] = useState<"phone" | "form">("form");
  const [saving, setSaving] = useState(false);
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const digits = phone.replace(/[^\d+]/g, "");
    const number = digits.startsWith("+") ? digits : `+1${digits}`;
    setErrorAt("form");
    if (name.trim().length < 2 || relationship.trim().length < 2)
      return setError("Enter their name and how they know you.");
    if (!/^\+[1-9]\d{9,14}$/.test(number)) {
      setErrorAt("phone");
      return setError("Enter a phone number with area code, like 902 555 0123.");
    }
    setSaving(true);
    setError("");
    try {
      const added = await journey.addContact({
        name: name.trim(),
        relationship: relationship.trim(),
        phone: number,
        scopes: estimates ? ["status", "alerts", "estimates"] : ["status", "alerts"],
      });
      setName("");
      setRelationship("");
      setPhone("");
      setOpen(false);
      setLink(`${window.location.origin}${added.link}`);
      setCopied(false);
      await refresh();
    } catch (failure) {
      // The server says why (visit ended, already added, ...); show that, never a bare "try again".
      const reason = failure instanceof Error ? failure.message : "";
      setErrorAt(/number|already/i.test(reason) ? "phone" : "form");
      setError(reason || "We couldn't save that. Please try again.");
      await refresh().catch(() => undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="vc-card vc-section">
      <div className="vc-section-head">
        <Icon name="people" />
        <h2>Who gets updates</h2>
      </div>
      <p className="vc-muted">
        Only people you add here are told anything. They hear your step, never medical details.
      </p>
      {visit.contacts.map((contact) => (
        <div className="vc-contact" key={contact.id}>
          <div>
            <strong>{contact.name}</strong>
            <span className="vc-muted">
              {contact.relationship} · phone ending {contact.phoneEnding} ·{" "}
              {contact.scopes.includes("estimates") ? "steps and wait estimates" : "steps only"}
            </span>
          </div>
          <button
            className="vc-btn"
            data-kind="quiet"
            data-size="sm"
            onClick={async () => {
              await journey.withdrawContact(contact.id);
              await refresh();
            }}
          >
            Stop
          </button>
        </div>
      ))}
      {link && (
        <div className="vc-link" role="status">
          <span>
            We&apos;ve texted them a private link to follow your visit. You can also share it
            yourself:
          </span>
          <code>{link}</code>
          <div>
            <button
              type="button"
              className="vc-btn"
              data-kind="quiet"
              data-size="sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(link);
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
            <a
              className="vc-btn"
              data-kind="quiet"
              data-size="sm"
              href={link}
              target="_blank"
              rel="noreferrer"
            >
              Open their page
            </a>
          </div>
        </div>
      )}
      {visit.ended ? (
        <p className="vc-muted" role="status">
          This visit has ended, so contacts can no longer be added.
        </p>
      ) : open ? (
        <form className="vc-form" onSubmit={add} noValidate>
          <label className="vc-field">
            Their name
            <input
              type="text"
              value={name}
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="vc-field">
            How they know you
            <input
              type="text"
              value={relationship}
              placeholder="Daughter, partner, friend"
              onChange={(event) => setRelationship(event.target.value)}
            />
          </label>
          <label className="vc-field">
            Their mobile number
            <input
              type="tel"
              inputMode="tel"
              value={phone}
              autoComplete="off"
              onChange={(event) => setPhone(event.target.value)}
            />
            <small>We text a code to this number before sharing anything by phone.</small>
            {error && errorAt === "phone" && (
              <span className="vc-error" role="alert">
                {error}
              </span>
            )}
          </label>
          <label className="vc-check">
            <input
              type="checkbox"
              checked={estimates}
              onChange={(event) => setEstimates(event.target.checked)}
            />
            Also share my wait estimates
          </label>
          {error && errorAt === "form" && (
            <p className="vc-error" role="alert">
              {error}
            </p>
          )}
          <button className="vc-btn" disabled={saving}>
            {saving ? "Saving…" : "Share my updates"}
          </button>
          <button type="button" className="vc-btn" data-kind="quiet" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button className="vc-btn" data-kind="quiet" onClick={() => setOpen(true)}>
          <Icon name="plus" size={20} />
          Add a family member or friend
        </button>
      )}
    </section>
  );
}
