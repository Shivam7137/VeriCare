import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { BackendError, type Database } from "../domain.js";
import { audit, journeyTransaction } from "../journey/records.js";
import { kbArticles, type KbArticle } from "./kb.js";
import {
  buildIndex,
  cosine,
  createRetriever,
  embeddingText,
  rankArticles,
  tokens,
  type Embedder,
  type Index,
  type Retriever,
} from "./retrieval.js";

// The semantic engine behind the Visit Agent. Each department keeps its own library of
// answers in Postgres, with stored embeddings. When the agent meets a practical question the
// library cannot answer, it reports a knowledge gap; similar gaps fold together, staff write
// and publish the answer, and the next person who asks gets it. Staff approve every word
// that can be sent: the agent only ever picks a published article.

const GAP_EXAMPLES = 5;
/** Share of topic words two gaps must have in common to be the same question. */
const GAP_WORDS_MATCH = 0.5;
/** Embedding similarity above which two open gaps are the same question. */
const GAP_VECTORS_MATCH = 0.86;

export type ArticleState = "draft" | "published" | "retired";

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);
export const articleHash = (article: KbArticle) => sha(embeddingText(article));

const jaccard = (a: readonly string[], b: readonly string[]) => {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
};

/** A question as staff may read it: numbers, links and addresses removed, one line. */
export function redactQuestion(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/https?:\/\/\S+|www\.\S+/gi, "[link]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{2,}\d/g, "[number]")
    .slice(0, 200);
}

/** A gap topic written by the model: short, generic, nothing that looks like contact details. */
export function cleanTopic(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/\s+/g, " ")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .trim();
  if (text.length < 3 || text.length > 120) return null;
  if (/https?:|www\.|\d{4,}|@\w+\.\w/i.test(text)) return null;
  return text;
}

/** Article text staff may publish: plain sentences, no links (a text with a link invites spoofing). */
export function checkArticle(input: { title: string; body: string }) {
  const title = input.title.replace(/\s+/g, " ").trim();
  const body = input.body.replace(/[ \t]+/g, " ").trim();
  if (title.length < 3 || title.length > 80) throw new BackendError("invalid_title", 400);
  if (body.length < 20 || body.length > 600) throw new BackendError("invalid_body", 400);
  if (/https?:|www\./i.test(`${title} ${body}`)) throw new BackendError("link_not_allowed", 400);
  return { title, body };
}

/** Gives a department the curated starter articles, once. Returns true when it did. */
export async function ensureStarterArticles(db: Database, departmentId: string, now: Date) {
  const fresh = await db.query(
    `INSERT INTO ed_kb_seeded (department_id, seeded_at) VALUES ($1,$2)
     ON CONFLICT DO NOTHING RETURNING department_id`,
    [departmentId, now],
  );
  if (fresh.rowCount === 0) return false;
  for (const article of kbArticles)
    await db.query(
      `INSERT INTO ed_kb_articles (department_id, id, title, body, state, source, created_by,
         created_at, updated_by, updated_at, published_by, published_at)
       VALUES ($1,$2,$3,$4,'published','starter','system',$5,'system',$5,'system',$5)
       ON CONFLICT DO NOTHING`,
      [departmentId, article.id, article.title, article.body, now],
    );
  return true;
}

export async function seeded(pool: Pool, departmentId: string, now: Date) {
  const found = await pool.query("SELECT 1 FROM ed_kb_seeded WHERE department_id = $1", [
    departmentId,
  ]);
  if (found.rowCount === 0)
    await journeyTransaction(pool, (db) => ensureStarterArticles(db, departmentId, now));
}

/** A published article of this department, or null. The only articles the agent can send. */
export async function publishedArticle(
  db: Database,
  departmentId: string,
  id: string,
  now: Date,
): Promise<KbArticle | null> {
  await ensureStarterArticles(db, departmentId, now);
  const row = await db.query<KbArticle>(
    `SELECT id, title, body FROM ed_kb_articles
     WHERE department_id = $1 AND id = $2 AND state = 'published'`,
    [departmentId, id],
  );
  return row.rows[0] ?? null;
}

export type StoredRow = KbArticle & {
  embedding: number[] | null;
  embeddingModel: string | null;
  embeddedHash: string | null;
};

const usableVector = (row: StoredRow, model: string | undefined) =>
  row.embedding && row.embeddingModel === (model ?? null) && row.embeddedHash === articleHash(row)
    ? row.embedding
    : null;

async function storeArticleVector(
  db: Database,
  departmentId: string,
  article: KbArticle,
  vector: number[],
  model: string | undefined,
) {
  // Only if the text is still the text that was embedded.
  await db.query(
    `UPDATE ed_kb_articles SET embedding = $5, embedding_model = $6, embedded_hash = $7
     WHERE department_id = $1 AND id = $2 AND title = $3 AND body = $4`,
    [
      departmentId,
      article.id,
      article.title,
      article.body,
      vector,
      model ?? null,
      articleHash(article),
    ],
  );
}

/**
 * The Visit Agent's retriever over each department's published library. Lexical ranking
 * always runs. With an embedder, article vectors are stored in Postgres (made once per
 * version of the text) and only the question is embedded per search.
 */
export function createKnowledgeRetriever(
  pool: Pool,
  options: { embed?: Embedder | null; top?: number; now?: () => Date } = {},
): Retriever {
  const embed = options.embed ?? null;
  const top = options.top ?? 3;
  const now = options.now ?? (() => new Date());
  const starters = createRetriever({ top });
  const cache = new Map<
    string,
    { stamp: string; index: Index; rows: StoredRow[]; vectors: (number[] | null)[] }
  >();

  async function library(departmentId: string) {
    await seeded(pool, departmentId, now());
    const stamp = await pool.query<{ stamp: string }>(
      `SELECT count(*) || ':' || coalesce(max(updated_at)::text, '') AS stamp
       FROM ed_kb_articles WHERE department_id = $1 AND state = 'published'`,
      [departmentId],
    );
    const key = stamp.rows[0]?.stamp ?? "";
    const cached = cache.get(departmentId);
    if (cached && cached.stamp === key) return cached;
    const rows = await pool.query<StoredRow>(
      `SELECT id, title, body, embedding, embedding_model AS "embeddingModel",
         embedded_hash AS "embeddedHash"
       FROM ed_kb_articles WHERE department_id = $1 AND state = 'published' ORDER BY id`,
      [departmentId],
    );
    const fresh = {
      stamp: key,
      rows: rows.rows,
      index: buildIndex(rows.rows),
      vectors: rows.rows.map((row) => usableVector(row, embed?.model)),
    };
    cache.set(departmentId, fresh);
    return fresh;
  }

  return {
    hybrid: Boolean(embed),
    async search(query, departmentId) {
      if (!departmentId) return starters.search(query);
      let shelf: Awaited<ReturnType<typeof library>>;
      try {
        shelf = await library(departmentId);
      } catch {
        // Without the library the agent has nothing to choose from and raises a staff task.
        return [];
      }
      if (!embed) return rankArticles(shelf.index, query, null, top);
      try {
        const missing = shelf.vectors.flatMap((vector, i) => (vector ? [] : [i]));
        if (missing.length > 0) {
          const made = await embed(missing.map((i) => embeddingText(shelf.rows[i]!)));
          if (made.length !== missing.length) throw new Error("embedding_shape");
          for (const [n, i] of missing.entries()) {
            shelf.vectors[i] = made[n]!;
            await storeArticleVector(pool, departmentId, shelf.rows[i]!, made[n]!, embed.model);
          }
        }
        const [question] = await embed([query]);
        if (!question) throw new Error("embedding_shape");
        return rankArticles(shelf.index, query, { question, vectors: shelf.vectors }, top);
      } catch {
        return rankArticles(shelf.index, query, null, top);
      }
    },
  };
}

/**
 * Records a practical question the library could not answer. A question that shares most
 * of its topic words with an open gap is folded into it. Runs inside the wake's transaction.
 */
export async function recordGap(
  db: Database,
  input: { departmentId: string; encounterId: string; topic: string; question: string; now: Date },
): Promise<{ gapId: string; merged: boolean }> {
  const example = redactQuestion(input.question);
  const words = tokens(input.topic);
  const open = await db.query<{ id: string; topic: string; examples: string[] }>(
    `SELECT id, topic, examples FROM ed_kb_gaps WHERE department_id = $1 AND state = 'open'
     ORDER BY last_asked_at DESC LIMIT 200`,
    [input.departmentId],
  );
  const same = open.rows
    .map((gap) => ({ gap, score: jaccard(words, tokens(gap.topic)) }))
    .filter((item) => item.score >= GAP_WORDS_MATCH)
    .sort((a, b) => b.score - a.score)[0]?.gap;
  let gapId: string;
  if (same) {
    gapId = same.id;
    const examples =
      same.examples.length < GAP_EXAMPLES && !same.examples.includes(example)
        ? [...same.examples, example]
        : same.examples;
    await db.query(
      `UPDATE ed_kb_gaps SET asked = asked + 1, last_asked_at = $2, examples = $3 WHERE id = $1`,
      [gapId, input.now, JSON.stringify(examples)],
    );
  } else {
    gapId = randomUUID();
    await db.query(
      `INSERT INTO ed_kb_gaps (id, department_id, topic, examples, first_asked_at, last_asked_at)
       VALUES ($1,$2,$3,$4,$5,$5)`,
      [gapId, input.departmentId, input.topic, JSON.stringify([example]), input.now],
    );
  }
  await audit(db, {
    at: input.now,
    actor: "visit-agent",
    action: "kb_gap",
    encounterId: input.encounterId,
    detail: { gapId, merged: Boolean(same) },
  });
  return { gapId, merged: Boolean(same) };
}

/**
 * Background upkeep when an embedder is configured: embeds changed articles and new gaps,
 * then folds open gaps whose embeddings say they are the same question. Safe to call often.
 */
export async function refreshKnowledge(pool: Pool, embed: Embedder, now = new Date()) {
  const articles = await pool.query<StoredRow & { departmentId: string }>(
    `SELECT department_id AS "departmentId", id, title, body, embedding,
       embedding_model AS "embeddingModel", embedded_hash AS "embeddedHash"
     FROM ed_kb_articles WHERE state = 'published'`,
  );
  const stale = articles.rows.filter((row) => !usableVector(row, embed.model)).slice(0, 50);
  if (stale.length > 0) {
    const made = await embed(stale.map(embeddingText));
    for (const [i, row] of stale.entries())
      await storeArticleVector(pool, row.departmentId, row, made[i]!, embed.model);
  }

  const bare = await pool.query<{ id: string; topic: string }>(
    `SELECT id, topic FROM ed_kb_gaps WHERE state = 'open'
       AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $1) ORDER BY seq LIMIT 50`,
    [embed.model ?? null],
  );
  if (bare.rows.length > 0) {
    const made = await embed(bare.rows.map((gap) => gap.topic));
    for (const [i, gap] of bare.rows.entries())
      await pool.query(
        "UPDATE ed_kb_gaps SET embedding = $2, embedding_model = $3 WHERE id = $1 AND topic = $4",
        [gap.id, made[i]!, embed.model ?? null, gap.topic],
      );
  }

  // Fold duplicates: the newer gap goes into the older one, keeping its count and examples.
  return journeyTransaction(pool, async (db) => {
    const open = await db.query<{
      id: string;
      departmentId: string;
      examples: string[];
      asked: number;
      embedding: number[];
      firstAskedAt: Date;
      lastAskedAt: Date;
    }>(
      `SELECT id, department_id AS "departmentId", examples, asked, embedding,
         first_asked_at AS "firstAskedAt", last_asked_at AS "lastAskedAt"
       FROM ed_kb_gaps WHERE state = 'open' AND embedding IS NOT NULL AND embedding_model = $1
       ORDER BY seq FOR UPDATE`,
      [embed.model ?? null],
    );
    let merged = 0;
    const gone = new Set<string>();
    for (const [i, older] of open.rows.entries()) {
      if (gone.has(older.id)) continue;
      for (const newer of open.rows.slice(i + 1)) {
        if (gone.has(newer.id) || newer.departmentId !== older.departmentId) continue;
        if (cosine(older.embedding, newer.embedding) < GAP_VECTORS_MATCH) continue;
        older.asked += newer.asked;
        older.examples = [...new Set([...older.examples, ...newer.examples])].slice(
          0,
          GAP_EXAMPLES,
        );
        if (newer.lastAskedAt > older.lastAskedAt) older.lastAskedAt = newer.lastAskedAt;
        await db.query(
          "UPDATE ed_kb_gaps SET state = 'merged', merged_into = $2, closed_at = $3 WHERE id = $1",
          [newer.id, older.id, now],
        );
        await db.query(
          "UPDATE ed_kb_gaps SET asked = $2, examples = $3, last_asked_at = $4 WHERE id = $1",
          [older.id, older.asked, JSON.stringify(older.examples), older.lastAskedAt],
        );
        await audit(db, {
          at: now,
          actor: "knowledge-base",
          action: "kb_gaps_merged",
          detail: { into: older.id, from: newer.id },
        });
        gone.add(newer.id);
        merged += 1;
      }
    }
    return { embeddedArticles: stale.length, embeddedGaps: bare.rows.length, merged };
  });
}
