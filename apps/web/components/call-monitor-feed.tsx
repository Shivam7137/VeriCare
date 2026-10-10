import type { VoiceMonitorEntry } from "@prc/contracts";

export function monitorTime(value: string) {
  return new Intl.DateTimeFormat("en-CA", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "America/Halifax",
  }).format(new Date(value));
}

export function MonitorEntry({ entry }: { entry: VoiceMonitorEntry }) {
  const transcript = entry.kind === "transcript";
  const state =
    entry.status === "complete"
      ? "Complete"
      : entry.status === "streaming"
        ? "Transcribing…"
        : entry.status === "running"
          ? "Running…"
          : entry.status.charAt(0).toUpperCase() + entry.status.slice(1);
  return (
    <li className={`monitor-entry monitor-${entry.kind} monitor-${entry.speaker ?? "system"}`}>
      <span className="monitor-entry-mark" aria-hidden="true">
        {transcript ? (entry.speaker === "caller" ? "C" : "AI") : entry.kind === "tool" ? "↳" : "·"}
      </span>
      <div className="monitor-entry-content">
        <div className="monitor-entry-heading">
          <strong>{entry.label}</strong>
          <span className={`monitor-entry-status monitor-status-${entry.status}`}>{state}</span>
          <time dateTime={entry.at}>{monitorTime(entry.at)}</time>
          {entry.elapsedMs !== undefined && (
            <span className="monitor-duration">
              {entry.elapsedMs < 1000
                ? `${Math.round(entry.elapsedMs)} ms`
                : `${(entry.elapsedMs / 1000).toFixed(2)} s`}
            </span>
          )}
        </div>
        {transcript && (
          <p className="monitor-transcript-text">
            {entry.text ||
              (entry.status === "failed"
                ? "No transcript available for this turn."
                : entry.status === "incomplete"
                  ? "The stream closed before this turn was transcribed."
                  : "Listening for speech…")}
          </p>
        )}
        {transcript && entry.status === "interrupted" && (
          <p className="hint">
            Interrupted · generated words may not all have been heard by the caller.
          </p>
        )}
        {transcript && entry.status === "failed" && (
          <p className="phone-error">
            Transcription failed. The assistant may still have received the audio.
          </p>
        )}
        {entry.details && (
          <details className="monitor-payload">
            <summary>
              {entry.kind === "tool"
                ? "Tool inputs & result"
                : transcript
                  ? "Turn details"
                  : "Event details"}
            </summary>
            {entry.kind === "tool" ? (
              <>
                <h4>Inputs</h4>
                <pre>{JSON.stringify(entry.details.arguments ?? {}, null, 2)}</pre>
                <h4>Result</h4>
                <pre>
                  {entry.details.result === undefined
                    ? "No result captured yet."
                    : JSON.stringify(entry.details.result, null, 2)}
                </pre>
              </>
            ) : (
              <pre>{JSON.stringify(entry.details, null, 2)}</pre>
            )}
          </details>
        )}
      </div>
    </li>
  );
}
