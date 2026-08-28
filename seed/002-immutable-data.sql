-- Deterministic seed data. Every value is a pure function of a generate_series
-- index: no now(), no random(), no sequence dependence. Re-seeding a fresh
-- database always produces byte-identical rows, which is what lets the oracle
-- hold exact expected results.

INSERT INTO genres (value, description) VALUES
  ('fiction',    'Invented narrative'),
  ('nonfiction', 'Factual writing'),
  ('poetry',     'Verse'),
  ('technical',  'Technical and reference'),
  ('history',    'Historical writing');

-- 50 authors.
INSERT INTO authors (id, name, country, born_year)
SELECT
  i,
  'Author ' || lpad(i::text, 3, '0'),
  (ARRAY['UK', 'US', 'FR', 'JP', 'BR'])[1 + (i % 5)],
  1900 + (i % 80)
FROM generate_series(1, 50) AS i;

-- 500 books.
--   in_print is false when i % 4 = 0, so exactly 125 are out of print and 375
--   are in print. The anonymous role is filtered to in_print = true, so that
--   375 is a load-bearing constant in the RBAC probes.
INSERT INTO books (id, author_id, title, genre, published_year, price, in_print, tags)
SELECT
  i,
  1 + (i % 50),
  'Book ' || lpad(i::text, 4, '0'),
  (ARRAY['fiction', 'nonfiction', 'poetry', 'technical', 'history'])[1 + (i % 5)],
  1950 + (i % 70),
  ((5 + (i % 40))::numeric + 0.99),
  (i % 4) <> 0,
  jsonb_build_object(
    'topics',   to_jsonb(ARRAY['t' || (i % 7), 't' || (i % 11)]),
    'featured', (i % 10) = 0,
    'weight',   i % 100
  )
FROM generate_series(1, 500) AS i;

-- 2000 reviews across 20 reviewers.
--   reviewer_id = 1 + (i % 20), so each reviewer owns exactly 100 reviews.
--   The `user` role is row-filtered to its own reviewer_id, so that 100 is
--   likewise load-bearing.
INSERT INTO reviews (id, book_id, reviewer_id, rating, body)
SELECT
  i,
  1 + (i % 500),
  1 + (i % 20),
  1 + (i % 5),
  'Review body ' || lpad(i::text, 5, '0')
FROM generate_series(1, 2000) AS i;

-- Mutable partition starts from a known baseline.
INSERT INTO counters (name, value) VALUES ('probe_counter', 0);
