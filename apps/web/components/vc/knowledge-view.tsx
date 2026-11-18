"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  clock,
  journey,
  type ArticleInput,
  type Knowledge,
  type KnowledgeArticle,
  type KnowledgeGap,
  type KnowledgeTry,
} from "../../lib/journey";
import { Icon } from "../journey-icons";
import { useDesk } from "./desk-context";
import { ViewHead } from "./shell";

type Shelf = "published" | "draft" | "retired";
type Draft = ArticleInput & { from?: string };

const shelfNames: Record<Shelf, string> = {
  published: "Published",
  draft: "Drafts",
  retired: "Retired",
};
const reasons: Record<string, string> = {
  link_not_allowed: "Links can't go in an answer: a text with a link invites copycat scams.",
  invalid_title: "The title needs 3 to 80 characters.",
  invalid_body: "The answer needs 20 to 600 characters.",
  invalid_input: "Check the title (3 to 80 characters) and answer (20 to 600).",
  gap_not_found: "Someone already answered or dismissed this question.",
};

export default function KnowledgeView() {
  const { ready } = useDesk();
  const [data, setData] = useState<Knowledge | null>(null);
  const [failed, setFailed] = useState(false);
  const [shelf, setShelf] = useState<Shelf>("published");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await journey.knowledge());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [ready, load]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
      return true;
    } catch (caught) {
      // The shared client names the backend's error code in its message.
      const message = caught instanceof Error ? caught.message : "";
      const code = Object.keys(reasons).find((key) => message.includes(key));
      setError(code ? reasons[code]! : message || "That didn't save. Try again in a moment.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const answerGap = (gap: KnowledgeGap) => {
    const existing = gap.draftId
      ? data?.articles.find((article) => article.id === gap.draftId)
      : undefined;
    setError(null);
    setDraft(
      existing
        ? {
            id: existing.id,
            title: existing.title,
            body: existing.body,
            gapId: gap.id,
            publish: true,
          }
        : { title: gap.topic, body: "", gapId: gap.id, publish: true, from: gap.topic },
    );
  };
  const edit = (article: KnowledgeArticle) => {
    setError(null);
    setDraft({ id: article.id, title: article.title, body: article.body, publish: true });
  };

  const save = async (publish: boolean) => {
    if (!draft) return;
    const { from: _from, ...input } = draft;
    const ok = await act(() => journey.saveArticle({ ...input, publish }));
    if (ok) {
      setDraft(null);
      setShelf(publish ? "published" : "draft");
    }
  };

  const shown = data?.articles.filter((article) => article.state === shelf) ?? [];
  const count = (state: Shelf) => data?.articles.filter((a) => a.state === state).length ?? 0;

  return (
    <>
      <ViewHead
        eyebrow="Oversight"
        title="Knowledge base"
        lede="These are the only answers the agent can send. When it meets a practical question the library can't answer, the question lands here. Write the answer once and publish it, and the next person who asks gets it."
        actions={
          <button
            className="vc-btn"
            data-size="sm"
            onClick={() => {
              setError(null);
              setDraft({ title: "", body: "", publish: true });
            }}
          >
            <Icon name="plus" size={18} />
            New answer
          </button>
        }
      />

      <section className="vca-stats" aria-label="Knowledge base at a glance">
        <div className="vca-stat">
          <span>Published answers</span>
          <strong>{data?.stats.published ?? "–"}</strong>
          <small>{data ? `${data.stats.drafts} in drafts` : ""}</small>
        </div>
        <div className="vca-stat" data-tone={data?.stats.openGaps ? "warn" : undefined}>
          <span>Unanswered questions</span>
          <strong>{data?.stats.openGaps ?? "–"}</strong>
          <small>
            {data
              ? `Asked ${data.stats.askedOpen} time${data.stats.askedOpen === 1 ? "" : "s"}`
              : ""}
          </small>
        </div>
        <div className="vca-stat">
          <span>Replies from the library</span>
          <strong>{data?.stats.kbReplies ?? "–"}</strong>
          <small>{data ? `${data.stats.answeredGaps} gaps closed by staff` : ""}</small>
        </div>
        <div className="vca-stat">
          <span>Search</span>
          <strong>{data ? (data.retrieval === "hybrid" ? "Hybrid" : "Keyword") : "–"}</strong>
          <small>
            {data?.retrieval === "hybrid"
              ? "Keywords fused with stored embeddings"
              : "Keyword ranking (BM25)"}
          </small>
        </div>
      </section>

      {failed && !data && (
        <p className="vca-quiet" role="alert">
          The knowledge base isn&rsquo;t reachable right now.
        </p>
      )}

      <div className="vca-split">
        <div className="vca-stack">
          <section className="vca-panel" aria-labelledby="gaps-title">
            <div className="vca-panel-head">
              <h2 id="gaps-title">Questions the agent couldn&rsquo;t answer</h2>
            </div>
            <p className="vca-hint">
              The agent reports a question here only when it is practical, not clinical, and no
              published answer fits. Similar questions are grouped. Numbers and links are removed
              before anyone sees them.
            </p>
            {!data && <div className="vc-skeleton" aria-label="Loading questions" />}
            {data && data.gaps.length === 0 && (
              <p className="vca-quiet">Nothing waiting. Every practical question had an answer.</p>
            )}
            <ul className="vck-gaps">
              {data?.gaps.map((gap) => (
                <li key={gap.id}>
                  <div className="vck-gap-head">
                    <strong>{gap.topic}</strong>
                    <span className="vc-chip" data-tone={gap.asked > 1 ? "warn" : undefined}>
                      Asked {gap.asked}×
                    </span>
                  </div>
                  <ul className="vck-examples">
                    {gap.examples.map((example) => (
                      <li key={example}>
                        <q>{example}</q>
                      </li>
                    ))}
                  </ul>
                  <p className="vck-meta">
                    First asked {clock(gap.firstAskedAt)}, last {clock(gap.lastAskedAt)}
                    {gap.draftId ? " · a draft answer is waiting" : ""}
                  </p>
                  {gap.suggestion && (
                    <p className="vck-suggest">
                      <Icon name="spark" size={16} />
                      <span>
                        &ldquo;{gap.suggestion.title}&rdquo; may already cover this. If so, add the
                        missing detail to it.
                      </span>
                    </p>
                  )}
                  <div className="vck-actions">
                    <button
                      className="vc-btn"
                      data-size="sm"
                      disabled={busy}
                      onClick={() => answerGap(gap)}
                    >
                      {gap.draftId ? "Finish answer" : "Write answer"}
                    </button>
                    {gap.suggestion && (
                      <button
                        className="vc-btn"
                        data-kind="quiet"
                        data-size="sm"
                        disabled={busy}
                        onClick={() => {
                          const article = data.articles.find((a) => a.id === gap.suggestion!.id);
                          if (article)
                            setDraft({
                              id: article.id,
                              title: article.title,
                              body: article.body,
                              gapId: gap.id,
                              publish: true,
                            });
                        }}
                      >
                        Improve &ldquo;{gap.suggestion.title}&rdquo;
                      </button>
                    )}
                    <button
                      className="vc-btn"
                      data-kind="quiet"
                      data-size="sm"
                      disabled={busy}
                      onClick={() => void act(() => journey.dismissGap(gap.id))}
                    >
                      Not for the library
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="vca-panel" aria-labelledby="articles-title">
            <div className="vca-panel-head">
              <h2 id="articles-title">Answers</h2>
              <div className="vca-seg" role="group" aria-label="Show">
                {(Object.keys(shelfNames) as Shelf[]).map((name) => (
                  <button key={name} aria-pressed={shelf === name} onClick={() => setShelf(name)}>
                    {shelfNames[name]}
                    <em>{count(name)}</em>
                  </button>
                ))}
              </div>
            </div>
            {data && shown.length === 0 && (
              <p className="vca-quiet">
                {shelf === "draft"
                  ? "No drafts. A draft is saved but never sent."
                  : shelf === "retired"
                    ? "Nothing retired."
                    : "No published answers yet."}
              </p>
            )}
            <ul className="vck-articles">
              {shown.map((article) => (
                <li key={article.id}>
                  <div className="vck-gap-head">
                    <strong>{article.title}</strong>
                    <span className="vck-tags">
                      <code>{article.id}</code>
                      <span className="vc-chip">
                        {article.source === "starter" ? "Starter" : "Staff"} · v{article.version}
                      </span>
                      {data?.retrieval === "hybrid" && (
                        <span className="vc-chip" data-tone={article.embedded ? "good" : undefined}>
                          {article.embedded ? "Embedded" : "Embedding soon"}
                        </span>
                      )}
                    </span>
                  </div>
                  <p>{article.body}</p>
                  <div className="vck-actions">
                    <button
                      className="vc-btn"
                      data-kind="quiet"
                      data-size="sm"
                      disabled={busy}
                      onClick={() => edit(article)}
                    >
                      {article.state === "published" ? "Edit" : "Edit and publish"}
                    </button>
                    {article.state !== "retired" && (
                      <button
                        className="vc-btn"
                        data-kind="danger-quiet"
                        data-size="sm"
                        disabled={busy}
                        onClick={() => void act(() => journey.retireArticle(article.id))}
                      >
                        Retire
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="vca-stack">
          {draft && (
            <Editor
              draft={draft}
              busy={busy}
              error={error}
              onChange={setDraft}
              onSave={save}
              onCancel={() => {
                setDraft(null);
                setError(null);
              }}
            />
          )}
          {!draft && error && (
            <p className="vc-error" role="alert">
              {error}
            </p>
          )}
          <TryQuestion />
        </div>
      </div>
    </>
  );
}

function Editor({
  draft,
  busy,
  error,
  onChange,
  onSave,
  onCancel,
}: {
  draft: Draft;
  busy: boolean;
  error: string | null;
  onChange: (draft: Draft) => void;
  onSave: (publish: boolean) => void;
  onCancel: () => void;
}) {
  return (
    <section className="vca-panel vck-editor" aria-labelledby="editor-title">
      <h2 id="editor-title">{draft.id ? "Edit answer" : "New answer"}</h2>
      {draft.from && (
        <p className="vca-hint">
          Written for: <q>{draft.from}</q>. Publishing closes that question.
        </p>
      )}
      <label className="vc-field">
        Title
        <input
          type="text"
          value={draft.title}
          maxLength={80}
          onChange={(event) => onChange({ ...draft, title: event.target.value })}
        />
        <small>What the question is about, e.g. &ldquo;Pharmacy at night&rdquo;.</small>
      </label>
      <label className="vc-field">
        Answer
        <textarea
          value={draft.body}
          rows={6}
          maxLength={600}
          onChange={(event) => onChange({ ...draft, body: event.target.value })}
        />
        <small>
          Sent word for word to patients and families. Plain facts about the building and services
          only, no medical advice, no links. {draft.body.trim().length}/600
        </small>
      </label>
      {error && (
        <p className="vc-error" role="alert">
          {error}
        </p>
      )}
      <div className="vck-actions">
        <button className="vc-btn" disabled={busy} onClick={() => onSave(true)}>
          <Icon name="check" size={18} />
          Publish
        </button>
        <button className="vc-btn" data-kind="quiet" disabled={busy} onClick={() => onSave(false)}>
          Save as draft
        </button>
        <button className="vc-btn" data-kind="quiet" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

function TryQuestion() {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<KnowledgeTry | null>(null);
  const [asked, setAsked] = useState("");
  const [failed, setFailed] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (text.length < 2) return;
    try {
      setResult(await journey.tryQuestion(text));
      setAsked(text);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };

  return (
    <section className="vca-panel" aria-labelledby="try-title">
      <h2 id="try-title">Try a question</h2>
      <p className="vca-hint">
        See which answers the agent would be given to choose from. Nothing is sent to anyone.
      </p>
      <form className="vc-ask vck-try" onSubmit={submit}>
        <input
          type="text"
          value={question}
          maxLength={500}
          placeholder="Where can I charge my phone?"
          aria-label="Question to try"
          onChange={(event) => setQuestion(event.target.value)}
        />
        <button className="vc-btn" data-size="sm" type="submit">
          Search
        </button>
      </form>
      {failed && <p className="vc-error">The search didn&rsquo;t run. Try again.</p>}
      {result && (
        <div className="vck-result" aria-live="polite">
          {result.floor ? (
            <p className="vck-floor">
              <Icon name="alert" size={18} />
              <span>
                <q>{asked}</q> goes straight to a nurse as{" "}
                {result.floor === "recheck" ? "a priority recheck" : "a leaving alert"}. The safety
                rules catch it before the agent or the library sees it.
              </span>
            </p>
          ) : result.matches.length === 0 ? (
            <p className="vca-quiet">
              No answer matches. The agent would raise this for staff and report it as an unanswered
              question.
            </p>
          ) : (
            <ol className="vck-matches">
              {result.matches.map((match) => (
                <li key={match.id}>
                  <div className="vck-gap-head">
                    <strong>{match.title}</strong>
                    <code>
                      {match.via === "hybrid" ? "words + meaning" : "words"} · {match.score}
                    </code>
                  </div>
                  <p>{match.body}</p>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
