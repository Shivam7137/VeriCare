import type { Pool } from "pg";
import { BackendError } from "../domain.js";
import { audit, journeyTransaction } from "../journey/records.js";
import { leavingWords, worseWords } from "../journey/tasks.js";
import type { KbArticle } from "./kb.js";
import {
  articleHash,
  checkArticle,
  ensureStarterArticles,
  seeded,
  type ArticleState,
  type StoredRow,
} from "./knowledge.js";
import { buildIndex, cosine, lexicalRank, type Retriever } from "./retrieval.js";

// The staff side of the knowledge base: the Knowledge page's view, writing and publishing
// answers, retiring them, dismissing gaps, and trying a question against the library.

/** A staff-facing hint that an existing article may already answer a gap. */
const SUGGEST_LEXICAL = 1.2;
const SUGGEST_SEMANTIC = 0.6;

export type KnowledgeArticle = KbArticle & {
  state: ArticleState;
  version: number;
  source: "starter" | "staff";
  gapId: string | null;
  updatedAt: string;
  publishedAt: string | null;
  embedded: boolean;
};
export type KnowledgeGap = {
  id: string;
  topic: string;
  examples: string[];
  asked: number;
  firstAskedAt: string;
  lastAskedAt: string;
  draftId: string | null;
  suggestion: { id: string; title: string } | null;
};

export async function knowledgeView(
  pool: Pool,
  departmentId: string,
  now: Date,
  retrieval: "hybrid" | "lexical",
) {
  await seeded(pool, departmentId, now);
  const articles = await pool.query<
    StoredRow & {
      state: ArticleState;
      version: number;
      source: "starter" | "staff";
      gapId: string | null;
      updatedAt: Date;
      publishedAt: Date | null;
    }
  >(
    `SELECT id, title, body, state, version, source, gap_id AS "gapId", updated_at AS "updatedAt",
       published_at AS "publishedAt", embedding, embedding_model AS "embeddingModel",
       embedded_hash AS "embeddedHash"
     FROM ed_kb_articles WHERE department_id = $1
     ORDER BY (state = 'published') DESC, (state = 'draft') DESC, updated_at DESC`,
    [departmentId],
  );
  const gaps = await pool.query<{
    id: string;
    topic: string;
    examples: string[];
    asked: number;
    firstAskedAt: Date;
    lastAskedAt: Date;
    embedding: number[] | null;
    embeddingModel: string | null;
  }>(
    `SELECT id, topic, examples, asked, first_asked_at AS "firstAskedAt",
       last_asked_at AS "lastAskedAt", embedding, embedding_model AS "embeddingModel"
     FROM ed_kb_gaps WHERE department_id = $1 AND state = 'open'
     ORDER BY asked DESC, last_asked_at DESC LIMIT 100`,
    [departmentId],
  );
  const counts = await pool.query<{ answered: number; kbReplies: number }>(
    `SELECT
       (SELECT count(*)::int FROM ed_kb_gaps WHERE department_id = $1 AND state = 'answered') AS answered,
       (SELECT count(*)::int FROM ed_messages m JOIN ed_encounters c ON c.id = m.encounter_id
         WHERE c.department_id = $1 AND m.kind = 'reply_kb') AS "kbReplies"`,
    [departmentId],
  );

  const published = articles.rows.filter((row) => row.state === "published");
  const index = buildIndex(published);
  const suggest = (gap: (typeof gaps.rows)[number]) => {
    if (gap.embedding) {
      const best = published
        .filter((row) => row.embedding && row.embeddingModel === gap.embeddingModel)
        .map((row) => ({ row, score: cosine(gap.embedding!, row.embedding!) }))
        .sort((a, b) => b.score - a.score)[0];
      if (best && best.score >= SUGGEST_SEMANTIC) return { id: best.row.id, title: best.row.title };
    }
    const best = lexicalRank(index, `${gap.topic} ${gap.examples.join(" ")}`)[0];
    return best && best.score >= SUGGEST_LEXICAL
      ? { id: best.article.id, title: best.article.title }
      : null;
  };
  const drafts = new Map(
    articles.rows
      .filter((row) => row.state === "draft" && row.gapId)
      .map((row) => [row.gapId!, row.id]),
  );

  return {
    retrieval,
    articles: articles.rows.map((row): KnowledgeArticle => ({
      id: row.id,
      title: row.title,
      body: row.body,
      state: row.state,
      version: row.version,
      source: row.source,
      gapId: row.gapId,
      updatedAt: row.updatedAt.toISOString(),
      publishedAt: row.publishedAt?.toISOString() ?? null,
      embedded: Boolean(row.embedding && row.embeddedHash === articleHash(row)),
    })),
    gaps: gaps.rows.map((gap): KnowledgeGap => ({
      id: gap.id,
      topic: gap.topic,
      examples: gap.examples,
      asked: gap.asked,
      firstAskedAt: gap.firstAskedAt.toISOString(),
      lastAskedAt: gap.lastAskedAt.toISOString(),
      draftId: drafts.get(gap.id) ?? null,
      suggestion: suggest(gap),
    })),
    stats: {
      published: published.length,
      drafts: articles.rows.filter((row) => row.state === "draft").length,
      openGaps: gaps.rows.length,
      askedOpen: gaps.rows.reduce((sum, gap) => sum + gap.asked, 0),
      answeredGaps: counts.rows[0]?.answered ?? 0,
      kbReplies: counts.rows[0]?.kbReplies ?? 0,
    },
  };
}

const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "article";

type Staff = { id: string; departmentId: string };

/**
 * Creates or edits an article. `publish` is the staff approval: without it the article is
 * a draft no one can receive. Publishing an article written for a gap closes that gap.
 */
export async function saveArticle(
  pool: Pool,
  staff: Staff,
  input: { id?: string; title: string; body: string; gapId?: string; publish: boolean },
  now: Date,
) {
  const text = checkArticle(input);
  const state: ArticleState = input.publish ? "published" : "draft";
  return journeyTransaction(pool, async (db) => {
    await ensureStarterArticles(db, staff.departmentId, now);
    let id: string;
    let version = 1;
    let gapId = input.gapId ?? null;
    if (gapId) {
      const gap = await db.query(
        "SELECT 1 FROM ed_kb_gaps WHERE id = $1 AND department_id = $2 AND state = 'open' FOR UPDATE",
        [gapId, staff.departmentId],
      );
      if (gap.rowCount === 0) throw new BackendError("gap_not_found", 404);
    }
    if (input.id) {
      const found = await db.query<KbArticle & { version: number; gapId: string | null }>(
        `SELECT id, title, body, version, gap_id AS "gapId" FROM ed_kb_articles
         WHERE department_id = $1 AND id = $2 FOR UPDATE`,
        [staff.departmentId, input.id],
      );
      const current = found.rows[0];
      if (!current) throw new BackendError("not_found", 404);
      id = current.id;
      gapId ??= current.gapId;
      const changed = current.title !== text.title || current.body !== text.body;
      version = current.version + (changed ? 1 : 0);
      await db.query(
        `UPDATE ed_kb_articles SET title = $3, body = $4, state = $5, version = $6, gap_id = $7,
           updated_by = $8, updated_at = $9,
           published_by = CASE WHEN $5 = 'published' THEN $8 ELSE published_by END,
           published_at = CASE WHEN $5 = 'published' THEN $9 ELSE published_at END,
           embedding = CASE WHEN $10 THEN NULL ELSE embedding END
         WHERE department_id = $1 AND id = $2`,
        [
          staff.departmentId,
          id,
          text.title,
          text.body,
          state,
          version,
          gapId,
          staff.id,
          now,
          changed,
        ],
      );
    } else {
      const base = slug(text.title);
      const taken = await db.query<{ id: string }>(
        "SELECT id FROM ed_kb_articles WHERE department_id = $1 AND (id = $2 OR id LIKE $2 || '\\_%')",
        [staff.departmentId, base],
      );
      const used = new Set(taken.rows.map((row) => row.id));
      id = base;
      for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
      await db.query(
        `INSERT INTO ed_kb_articles (department_id, id, title, body, state, source, gap_id,
           created_by, created_at, updated_by, updated_at, published_by, published_at)
         VALUES ($1,$2,$3,$4,$5,'staff',$6,$7,$8,$7,$8,
           CASE WHEN $5 = 'published' THEN $7 END, CASE WHEN $5 = 'published' THEN $8::timestamptz END)`,
        [staff.departmentId, id, text.title, text.body, state, gapId, staff.id, now],
      );
    }
    if (gapId && state === "published")
      await db.query(
        `UPDATE ed_kb_gaps SET state = 'answered', article_id = $2, closed_by = $3, closed_at = $4
         WHERE id = $1 AND state = 'open'`,
        [gapId, id, staff.id, now],
      );
    await audit(db, {
      at: now,
      actor: staff.id,
      action: state === "published" ? "kb_article_published" : "kb_article_saved",
      detail: { articleId: id, version, hash: articleHash({ id, ...text }), gapId },
    });
    return { id, state, version };
  });
}

export async function retireArticle(pool: Pool, staff: Staff, id: string, now: Date) {
  return journeyTransaction(pool, async (db) => {
    const done = await db.query(
      `UPDATE ed_kb_articles SET state = 'retired', updated_by = $3, updated_at = $4
       WHERE department_id = $1 AND id = $2 AND state <> 'retired' RETURNING version`,
      [staff.departmentId, id, staff.id, now],
    );
    if (done.rowCount === 0) throw new BackendError("not_found", 404);
    await audit(db, {
      at: now,
      actor: staff.id,
      action: "kb_article_retired",
      detail: { articleId: id },
    });
    return { id, state: "retired" as const };
  });
}

export async function dismissGap(pool: Pool, staff: Staff, id: string, now: Date) {
  return journeyTransaction(pool, async (db) => {
    const done = await db.query(
      `UPDATE ed_kb_gaps SET state = 'dismissed', closed_by = $3, closed_at = $4
       WHERE id = $1 AND department_id = $2 AND state = 'open'`,
      [id, staff.departmentId, staff.id, now],
    );
    if (done.rowCount === 0) throw new BackendError("not_found", 404);
    await audit(db, {
      at: now,
      actor: staff.id,
      action: "kb_gap_dismissed",
      detail: { gapId: id },
    });
    return { id, state: "dismissed" as const };
  });
}

/**
 * What the agent would be given for a question, for staff to try the library. A question
 * the safety floors catch never reaches the library, and the answer says so.
 */
export async function tryQuestion(retriever: Retriever, departmentId: string, question: string) {
  const floor = worseWords.test(question)
    ? ("recheck" as const)
    : leavingWords.test(question)
      ? ("leaving" as const)
      : null;
  const found = floor ? [] : await retriever.search(question, departmentId);
  return {
    floor,
    retrieval: retriever.hybrid ? ("hybrid" as const) : ("lexical" as const),
    matches: found.map((item) => ({
      id: item.article.id,
      title: item.article.title,
      body: item.article.body,
      score: Math.round(item.score * 1000) / 1000,
      via: item.via,
    })),
  };
}
