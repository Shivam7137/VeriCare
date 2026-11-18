-- The Visit Agent's knowledge base, kept per department so staff can write and approve
-- answers, and the practical questions the agent could not answer (knowledge gaps).
-- Every fact and question here is fictional.

-- An answer the agent may send word for word. Only published articles reach anyone.
CREATE TABLE ed_kb_articles (
  department_id text NOT NULL,
  id text NOT NULL CHECK (id ~ '^[a-z0-9_]{2,48}$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 80),
  body text NOT NULL CHECK (char_length(body) BETWEEN 20 AND 600),
  state text NOT NULL CHECK (state IN ('draft', 'published', 'retired')),
  version integer NOT NULL DEFAULT 1,
  source text NOT NULL CHECK (source IN ('starter', 'staff')),
  -- The gap this article was written to answer, if any.
  gap_id text,
  -- Stored embedding of "title. body", the model that made it, and a hash of the text it
  -- was made from. A changed article is embedded again before it is ranked semantically.
  embedding real[],
  embedding_model text,
  embedded_hash text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL,
  published_by text,
  published_at timestamptz,
  PRIMARY KEY (department_id, id)
);

-- A department gets the curated starter articles once. Retiring one never brings it back.
CREATE TABLE ed_kb_seeded (
  department_id text PRIMARY KEY,
  seeded_at timestamptz NOT NULL
);

-- A practical question the agent judged the library should answer and could not. Similar
-- questions are folded into one gap, so staff see "asked 4 times", not four rows.
CREATE TABLE ed_kb_gaps (
  id text PRIMARY KEY,
  seq bigserial NOT NULL,
  department_id text NOT NULL,
  -- A short generic topic written by the agent, checked by code.
  topic text NOT NULL CHECK (char_length(topic) BETWEEN 3 AND 120),
  -- Up to five of the questions as people asked them, with numbers, links and addresses removed.
  examples jsonb NOT NULL DEFAULT '[]',
  asked integer NOT NULL DEFAULT 1 CHECK (asked > 0),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'answered', 'dismissed', 'merged')),
  article_id text,
  -- A gap folded into an older one after their embeddings showed the same question.
  merged_into text REFERENCES ed_kb_gaps(id),
  embedding real[],
  embedding_model text,
  first_asked_at timestamptz NOT NULL,
  last_asked_at timestamptz NOT NULL,
  closed_by text,
  closed_at timestamptz
);
CREATE INDEX ed_kb_gaps_open ON ed_kb_gaps (department_id, last_asked_at DESC)
  WHERE state = 'open';
