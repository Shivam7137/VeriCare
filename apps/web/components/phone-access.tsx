"use client";
import { useEffect, useState } from "react";
import { date } from "../lib/ui";
export type AccessCode = { code: string; expiresAt: string };
export type PhoneConfiguration = {
  mode: "simulated" | "twilio";
  liveReady: boolean;
  phoneNumber?: string | null;
  allNumbersAllowed?: boolean;
};
export default function PhoneAccess({
  config,
  code,
  busy,
  staff = false,
  taskId,
  generate,
}: {
  config: PhoneConfiguration | null;
  code: AccessCode | null;
  busy: boolean;
  staff?: boolean;
  taskId?: string;
  generate: () => void;
}) {
  const [now, setNow] = useState(0);
  const [copyStatus, setCopyStatus] = useState("");
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setCopyStatus("");
  }, [code?.code]);
  const expired = !!code && now >= Date.parse(code.expiresAt);
  return (
    <div className="phone-access">
      <div className="phone-line">
        <div>
          <p className="eyebrow">{staff ? "Staff phone access" : "Your phone access"}</p>
          <h3>
            {config ? (
              config.phoneNumber && config.liveReady ? (
                <a href={`tel:${config.phoneNumber}`}>{config.phoneNumber}</a>
              ) : (
                "Real phone line unavailable"
              )
            ) : (
              "Checking the phone line…"
            )}
          </h3>
        </div>
        <span className="status">
          {config ? (config.liveReady ? "Real phone line" : "Simulation available") : "Loading"}
        </span>
      </div>
      <p>
        Call and tell Alex what you need. Get a code here if the assistant asks to access
        appointments or staff actions. After the assistant reads an action aloud, press{" "}
        <strong>1 to approve</strong> or <strong>2 to cancel</strong>.
      </p>
      <p className="hint">
        You can also ask Alex to text you a portal link or your authorized appointment details.
        Texts go to the number you are calling from after your approval.
      </p>
      <button className="secondary" disabled={busy || !config} onClick={generate}>
        {busy ? "Please wait…" : code ? "Generate a new access code" : "Get phone access code"}
      </button>
      {code && (
        <div className={`access-code ${expired ? "code-expired" : ""}`}>
          <span>{expired ? "Code expired" : "One-time access code"}</span>
          <strong aria-label={`Access code ${code.code.split("").join(" ")}`}>{code.code}</strong>
          <div>
            <button
              className="quiet"
              disabled={expired}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(code.code);
                  setCopyStatus("Code copied.");
                } catch {
                  setCopyStatus("Copy unavailable. Select and copy the code above.");
                }
              }}
            >
              Copy code
            </button>
            <span role="status">{copyStatus}</span>
          </div>
          <small>
            {expired
              ? "Generate a fresh code to continue."
              : `Expires ${date(code.expiresAt)}. Single use; keep it private.`}
          </small>
        </div>
      )}
      <p className="hint">
        {staff
          ? "Your staff code opens care-team assistance. Choose the patient during the call; this code is not tied to a patient request."
          : taskId
            ? "This code is limited to the selected appointment request."
            : "This code lets the assistant help prepare a new request."}
      </p>
    </div>
  );
}
