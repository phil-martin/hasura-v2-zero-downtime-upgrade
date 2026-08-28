-- Schema for the harness, partitioned strictly by mutability.
--
-- IMMUTABLE PARTITION: seeded once, never written by any probe. Read probes
-- against these tables have exact expected results checked by deep equality.
--
-- MUTABLE PARTITION: only ever touched by mutation probes, and never the
-- subject of an exact-match expectation.
--
-- The split exists so read correctness never depends on concurrent write state.
-- That is the flakiness class most likely to make the whole harness untrustworthy.

-- =========================================================================
-- Immutable partition
-- =========================================================================

-- Enum table. Hasura requires a text primary key and at most one further
-- column, which becomes the enum value's description.
CREATE TABLE genres (
  value       text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE authors (
  id        int  PRIMARY KEY,
  name      text NOT NULL,
  country   text NOT NULL,
  born_year int  NOT NULL
);

CREATE TABLE books (
  id             int     PRIMARY KEY,
  author_id      int     NOT NULL REFERENCES authors (id),
  title          text    NOT NULL,
  genre          text    NOT NULL REFERENCES genres (value),
  published_year int     NOT NULL,
  price          numeric(10, 2) NOT NULL,
  in_print       boolean NOT NULL,
  tags           jsonb   NOT NULL
);

CREATE INDEX books_author_id_idx ON books (author_id);
CREATE INDEX books_genre_idx     ON books (genre);

CREATE TABLE reviews (
  id          int  PRIMARY KEY,
  book_id     int  NOT NULL REFERENCES books (id),
  reviewer_id int  NOT NULL,
  rating      int  NOT NULL,
  body        text NOT NULL
);

CREATE INDEX reviews_book_id_idx     ON reviews (book_id);
CREATE INDEX reviews_reviewer_id_idx ON reviews (reviewer_id);

-- =========================================================================
-- Mutable partition
-- =========================================================================

CREATE TABLE orders (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  probe_key  text NOT NULL UNIQUE,
  qty        int  NOT NULL,
  status     text NOT NULL DEFAULT 'new',
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE counters (
  name  text   PRIMARY KEY,
  value bigint NOT NULL DEFAULT 0
);

-- Source for streaming-subscription gap detection. A writer advances `seq`
-- monotonically at a fixed cadence, writing DIRECTLY to Postgres rather than
-- through Hasura. That matters: if the writer went through GraphQL, an outage
-- would stop rows being produced and the subscription would have nothing to
-- miss. Writing direct means rows keep appearing throughout an outage and the
-- subscription must back-fill every one of them to pass.
CREATE TABLE seq_stream (
  id         bigserial PRIMARY KEY,
  seq        bigint NOT NULL,
  written_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX seq_stream_seq_idx ON seq_stream (seq);

CREATE TABLE events_source (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  probe_key  text NOT NULL UNIQUE,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
