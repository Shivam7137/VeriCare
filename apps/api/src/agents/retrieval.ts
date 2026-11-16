import { kbArticles, type KbArticle } from "./kb.js";

// Retrieval for the Visit Agent: find the few knowledge-base articles that best match what
// someone asked, so the model chooses among relevant answers instead of the whole library.
// Lexical ranking (BM25) always runs and needs nothing outside this process. When an
// embedder is configured, a semantic ranking is fused with it. Retrieval only narrows the
// choice: the answer a person reads is still an article's text, word for word.

export type Retrieved = { article: KbArticle; score: number; via: "lexical" | "hybrid" };
export type Embedder = (texts: readonly string[]) => Promise<number[][]>;

const stop = new Set(
  "a an and are as at be but by can do for from has have how i if in is it me my of on or our so that the their them there they this to was we what when where which who why will with you your".split(
    " ",
  ),
);
// Everyday words mapped to the words the articles use.
const synonyms: Record<string, string> = {
  charger: "charging",
  charge: "charging",
  battery: "charging",
  plug: "outlets",
  car: "parking",
  park: "parking",
  parked: "parking",
  eat: "eating",
  food: "eating",
  hungry: "eating",
  snack: "eating",
  drink: "drinking",
  water: "drinking",
  thirsty: "drinking",
  coffee: "cafe",
  bathroom: "washrooms",
  toilet: "washrooms",
  washroom: "washrooms",
  restroom: "washrooms",
  internet: "wifi",
  "wi-fi": "wifi",
  husband: "support",
  wife: "support",
  mom: "support",
  mother: "support",
  visitor: "support",
  visitors: "support",
  smoke: "outside",
  cigarette: "outside",
  air: "outside",
  skipped: "first",
  ahead: "first",
  unfair: "first",
};

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/wi-fi/g, "wifi")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !stop.has(word))
    .map((word) => synonyms[word] ?? word);
}

type Index = {
  docs: { article: KbArticle; counts: Map<string, number>; length: number }[];
  idf: Map<string, number>;
  averageLength: number;
};

export function buildIndex(articles: readonly KbArticle[] = kbArticles): Index {
  const docs = articles.map((article) => {
    // The title is counted twice: it says what the article is about.
    const words = tokens(`${article.title} ${article.title} ${article.body}`);
    const counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    return { article, counts, length: words.length };
  });
  const idf = new Map<string, number>();
  for (const doc of docs)
    for (const word of doc.counts.keys()) idf.set(word, (idf.get(word) ?? 0) + 1);
  for (const [word, n] of idf) idf.set(word, Math.log(1 + (docs.length - n + 0.5) / (n + 0.5)));
  return {
    docs,
    idf,
    averageLength: docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length),
  };
}

const K1 = 1.4;
const B = 0.75;

/** BM25 scores for every article that shares at least one word with the query. */
export function lexicalRank(index: Index, query: string): Retrieved[] {
  const words = [...new Set(tokens(query))];
  return index.docs
    .map((doc) => {
      let score = 0;
      for (const word of words) {
        const count = doc.counts.get(word);
        if (!count) continue;
        score +=
          ((index.idf.get(word) ?? 0) * count * (K1 + 1)) /
          (count + K1 * (1 - B + (B * doc.length) / index.averageLength));
      }
      return { article: doc.article, score, via: "lexical" as const };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
}

const cosine = (a: readonly number[], b: readonly number[]) => {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    left += a[i]! * a[i]!;
    right += b[i]! * b[i]!;
  }
  return left && right ? dot / Math.sqrt(left * right) : 0;
};

export function createRetriever(
  options: { articles?: readonly KbArticle[]; embed?: Embedder | null; top?: number } = {},
) {
  const articles = options.articles ?? kbArticles;
  const index = buildIndex(articles);
  const top = options.top ?? 3;
  let vectors: Promise<number[][]> | null = null;
  return {
    hybrid: Boolean(options.embed),
    /** The best matches for a question. Never throws: a failed embedder leaves the lexical ranking. */
    async search(query: string): Promise<Retrieved[]> {
      const lexical = lexicalRank(index, query);
      if (!options.embed) return lexical.slice(0, top);
      try {
        vectors ??= options.embed(articles.map((item) => `${item.title}. ${item.body}`));
        const [docs, [question]] = await Promise.all([vectors, options.embed([query])]);
        if (!question || docs.length !== articles.length) throw new Error("embedding_shape");
        const semantic = articles
          .map((article, i) => ({ article, score: cosine(question, docs[i]!) }))
          .sort((a, b) => b.score - a.score);
        // Reciprocal rank fusion: an article ranked well by either method rises.
        const fused = new Map<string, number>();
        const add = (list: { article: KbArticle }[]) =>
          list.forEach((item, rank) =>
            fused.set(item.article.id, (fused.get(item.article.id) ?? 0) + 1 / (60 + rank)),
          );
        add(lexical);
        // A weak semantic match is noise, so only the closest few vote.
        add(semantic.filter((item) => item.score >= 0.25).slice(0, 5));
        return [...fused]
          .sort((a, b) => b[1] - a[1])
          .slice(0, top)
          .map(([id, score]) => ({
            article: articles.find((item) => item.id === id)!,
            score,
            via: "hybrid" as const,
          }));
      } catch {
        vectors = null;
        return lexical.slice(0, top);
      }
    },
  };
}
export type Retriever = ReturnType<typeof createRetriever>;

/** Embeddings through the same provider as the planner. Off unless KB_EMBEDDINGS is "true". */
export function readEmbedder(env: NodeJS.ProcessEnv = process.env): Embedder | null {
  const apiKey = env.VISIT_AGENT_OPENAI_API_KEY?.trim() || env.OPENAI_API_KEY?.trim();
  if (env.KB_EMBEDDINGS !== "true" || !apiKey) return null;
  const model = env.KB_EMBEDDING_MODEL?.trim() || "text-embedding-3-small";
  return async (texts) => {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`embeddings_http_${response.status}`);
    const reply = (await response.json()) as { data?: { index: number; embedding: number[] }[] };
    if (!Array.isArray(reply.data) || reply.data.length !== texts.length)
      throw new Error("embeddings_malformed");
    return [...reply.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
  };
}
