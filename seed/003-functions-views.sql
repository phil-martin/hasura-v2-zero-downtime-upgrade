-- A view, a custom function exposed as a query, and a computed-field function.
-- All three are separate parts of Hasura's schema surface and all three are
-- probed, because each is a distinct code path that a version upgrade could
-- change the behaviour of.

CREATE VIEW book_stats AS
SELECT
  b.genre                        AS genre,
  count(*)::int                  AS book_count,
  round(avg(b.price), 2)         AS avg_price,
  min(b.published_year)          AS earliest_year,
  max(b.published_year)          AS latest_year
FROM books b
GROUP BY b.genre;

-- Custom SQL function returning SETOF a tracked table. Hasura exposes this as a
-- root query field taking `args: { search: ... }`. Must be STABLE or IMMUTABLE
-- to be exposed as a query rather than a mutation.
CREATE FUNCTION search_books(search text)
RETURNS SETOF books
LANGUAGE sql
STABLE
AS $$
  SELECT * FROM books
  WHERE title ILIKE ('%' || search || '%')
  ORDER BY id
$$;

-- Computed field. The first argument is the table row; Hasura exposes the
-- remaining arguments as `args: { pct: ... }` on the field itself.
CREATE FUNCTION book_discounted_price(book_row books, pct numeric)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT round(book_row.price * (1 - pct / 100), 2)
$$;
