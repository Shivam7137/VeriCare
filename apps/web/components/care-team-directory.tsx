"use client";
import { useCallback, useEffect, useState } from "react";
import type { CareTeamDirectoryResult, CareTeamMember } from "@prc/contracts";
import { api } from "../lib/ui";
import { enterWorkspace } from "../lib/workspace";
import PortalHeader from "./portal-header";
import TransferSimulator from "./transfer-simulator";
import type { PhoneConfiguration } from "./phone-access";
import "../app/phone.css";
import "../app/team.css";

function MemberDestination({
  member,
  refresh,
}: {
  member: CareTeamMember;
  refresh: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  return (
    <article className="team-member">
      <div className="team-member-heading">
        <span className="member-initials" aria-hidden="true">
          {member.name
            .replace(/^Dr. /, "")
            .split(" ")
            .map((part) => part[0])
            .join("")}
        </span>
        <div>
          <h3>{member.name}</h3>
          <p>
            {member.role} · {member.departmentName}
          </p>
        </div>
      </div>
      <div className="member-destination">
        <span className={`status ${member.configured ? "success" : ""}`}>
          {member.configured ? "Live destination configured" : "Live number needed"}
        </span>
        <p>{member.phoneNumber ?? "No phone destination saved"}</p>
      </div>
      {saved && (
        <p className="hint" role="status">
          Destination saved. No call was placed.
        </p>
      )}
      {error && (
        <p className="phone-error" role="alert">
          {error}
        </p>
      )}
      {editing ? (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            try {
              await api(
                `/api/backend/voice/directory/${encodeURIComponent(member.id)}`,
                { phoneNumber: number.trim() || null, expectedRevision: member.revision },
                "PATCH",
                "professional",
              );
              setEditing(false);
              setSaved(true);
              await refresh();
            } catch (cause) {
              setError((cause as Error).message);
              await refresh().catch(() => {});
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Phone destination
            <input
              type="tel"
              value={number}
              onChange={(event) => setNumber(event.target.value)}
              pattern="\+[1-9][0-9]{7,14}"
              placeholder="+ followed by country code and number"
              disabled={busy}
            />
          </label>
          <p className="hint">
            Use international format. Leave blank to remove the destination. Saving does not place a
            call.
          </p>
          <div className="phone-buttons">
            <button className="primary" disabled={busy}>
              {busy ? "Saving…" : "Save destination"}
            </button>
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          className="quiet"
          onClick={() => {
            setNumber(member.phoneNumber ?? "");
            setEditing(true);
            setSaved(false);
            setError("");
          }}
        >
          {member.configured ? "Edit phone destination" : "Add phone destination"}
        </button>
      )}
    </article>
  );
}
export default function CareTeamDirectory() {
  const [directory, setDirectory] = useState<CareTeamDirectoryResult | null>(null);
  const [config, setConfig] = useState<PhoneConfiguration | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const refresh = useCallback(async () => {
    const data = await api<CareTeamDirectoryResult>(
      "/api/backend/voice/directory",
      undefined,
      undefined,
      "professional",
    );
    setDirectory(data);
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    async function load() {
      try {
        await enterWorkspace("professional", true);
        const [data, settings] = await Promise.all([
          api<CareTeamDirectoryResult>(
            "/api/backend/voice/directory",
            undefined,
            undefined,
            "professional",
          ),
          api<PhoneConfiguration>(
            "/api/backend/voice/config",
            undefined,
            undefined,
            "professional",
          ),
        ]);
        if (active) {
          setDirectory(data);
          setConfig(settings);
        }
      } catch (cause) {
        if (active) setError((cause as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [retry]);
  const members =
    directory?.members.filter((member) =>
      `${member.name} ${member.role}`.toLowerCase().includes(query.toLowerCase().trim()),
    ) ?? [];
  return (
    <main className="portal-workspace team-workspace">
      <PortalHeader portal="professional" team />
      <section className="workspace-heading" id="workspace-main">
        <div>
          <p className="eyebrow">Fictional outpatient clinic</p>
          <h1>Care team & phone</h1>
          <p>Find a teammate, manage their phone destination, or demonstrate a transfer.</p>
        </div>
        <a className="button-link" href="#phone">
          Staff phone access ↓
        </a>
      </section>
      {error && (
        <div className="alert" role="alert">
          <span>{error}</span>
          <button className="quiet" onClick={() => setRetry((value) => value + 1)}>
            Retry connection
          </button>
        </div>
      )}
      {loading ? (
        <section className="panel workspace-loading" role="status">
          Loading care-team directory…
        </section>
      ) : (
        directory && (
          <div className="team-grid">
            <section className="panel directory-panel" aria-labelledby="directory-heading">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Department directory</p>
                  <h2 id="directory-heading">
                    Your care team <span className="count-label">{directory.members.length}</span>
                  </h2>
                </div>
              </div>
              <p className="muted">
                All names and patient associations are fictional. Phone destinations are configured
                separately; no number is called when you save it.
              </p>
              <label>
                <span className="visually-hidden">Search care team</span>
                <input
                  type="search"
                  placeholder="Search name or role"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <div className="team-members">
                {members.map((member) => (
                  <MemberDestination key={member.id} member={member} refresh={refresh} />
                ))}
                {!members.length && <p className="queue-empty">No teammates match your search.</p>}
              </div>
            </section>
            <TransferSimulator directory={directory} config={config} />
          </div>
        )
      )}
      <footer>
        <span>VeriCare</span>
        <span>Fictional demo · Forwarding does not change appointments</span>
      </footer>
    </main>
  );
}
