import type { ProbeGroup } from '../probes/types.js'

export type ClientSpec = 'admin' | 'anon' | { role: string; userId?: number }

/**
 * A read whose result is fully determined by the seeded database, so it can be
 * compared against a captured expectation by deep equality.
 *
 * Every query specifies an explicit order_by and a bounded limit. Without that,
 * result ordering would be at the planner's discretion and a reordering between
 * Hasura versions would look like corruption.
 *
 * All of these touch ONLY the immutable partition. Nothing a mutation probe
 * writes can appear in any of these results.
 */
export type ReadSpec = {
  id: string
  group: ProbeGroup
  client: ClientSpec
  query?: string
  variables?: Record<string, unknown>
  restPath?: string
}

export const READ_SPECS: ReadSpec[] = [
  // --- core query surface -------------------------------------------------
  {
    id: 'q_simple_select',
    group: 'query',
    client: 'admin',
    query: `{ books(where: {id: {_lte: 5}}, order_by: {id: asc}) { id title genre published_year price in_print } }`,
  },
  {
    id: 'q_nested_object_rel',
    group: 'query',
    client: 'admin',
    query: `{ books(where: {id: {_in: [7, 42]}}, order_by: {id: asc}) { id title author { id name country born_year } } }`,
  },
  {
    id: 'q_nested_array_rel',
    group: 'query',
    client: 'admin',
    query: `{ authors(where: {id: {_eq: 3}}) { id name books(order_by: {id: asc}, limit: 3) { id title reviews(order_by: {id: asc}, limit: 2) { id rating } } } }`,
  },
  {
    id: 'q_where_and_or_not',
    group: 'query',
    client: 'admin',
    query: `{ books(where: {_and: [{published_year: {_gte: 2000}}, {_or: [{genre: {_eq: fiction}}, {genre: {_eq: history}}]}, {_not: {in_print: {_eq: false}}}]}, order_by: {id: asc}, limit: 10) { id title genre published_year } }`,
  },
  {
    id: 'q_order_limit_offset',
    group: 'query',
    client: 'admin',
    query: `{ books(order_by: [{price: desc}, {id: asc}], limit: 5, offset: 10) { id title price } }`,
  },
  {
    id: 'q_aggregate',
    group: 'query',
    client: 'admin',
    query: `{ books_aggregate { aggregate { count avg { price } sum { published_year } max { published_year } min { published_year } } } }`,
  },
  {
    id: 'q_distinct_on',
    group: 'query',
    client: 'admin',
    query: `{ books(distinct_on: genre, order_by: [{genre: asc}, {id: asc}]) { genre id title } }`,
  },
  {
    id: 'q_jsonb_contains',
    group: 'query',
    client: 'admin',
    query: `{ books(where: {tags: {_contains: {featured: true}}}, order_by: {id: asc}, limit: 5) { id tags } }`,
  },
  {
    id: 'q_computed_field',
    group: 'query',
    client: 'admin',
    query: `{ books(where: {id: {_in: [1, 2, 3]}}, order_by: {id: asc}) { id price discounted_price(args: {pct: "12.5"}) } }`,
  },
  {
    id: 'q_sql_function',
    group: 'query',
    client: 'admin',
    query: `{ search_books(args: {search: "Book 010"}, order_by: {id: asc}) { id title } }`,
  },
  {
    id: 'q_view',
    group: 'query',
    client: 'admin',
    query: `{ book_stats(order_by: {genre: asc}) { genre book_count avg_price earliest_year latest_year } }`,
  },
  {
    id: 'q_enum_filter',
    group: 'query',
    client: 'admin',
    query: `{ books(where: {genre: {_in: [poetry, technical]}}, order_by: {id: asc}, limit: 6) { id genre title } }`,
  },
  {
    id: 'q_variables',
    group: 'query',
    client: 'admin',
    query: `query WithVars($y: Int!, $n: Int!) { books(where: {published_year: {_gte: $y}}, order_by: {id: asc}, limit: $n) { id title published_year } }`,
    variables: { y: 2010, n: 4 },
  },
  {
    id: 'q_alias_fragments',
    group: 'query',
    client: 'admin',
    query: `query Aliased { first: books(where: {id: {_eq: 1}}) { ...bookFields } second: books(where: {id: {_eq: 2}}) { ...bookFields } } fragment bookFields on books { id title genre }`,
  },

  // --- RBAC ---------------------------------------------------------------
  // reviewer_id = 1 + (i % 20) over 2000 rows, so reviewer 7 owns exactly 100.
  {
    id: 'rbac_user_own_review_count',
    group: 'rbac',
    client: { role: 'user', userId: 7 },
    query: `{ reviews_aggregate { aggregate { count } } }`,
  },
  {
    id: 'rbac_user_own_rows',
    group: 'rbac',
    client: { role: 'user', userId: 7 },
    query: `{ reviews(order_by: {id: asc}, limit: 5) { id book_id reviewer_id rating } }`,
  },
  // in_print is false when i % 4 = 0, so exactly 375 of 500 are visible to anon.
  {
    id: 'rbac_anon_in_print_count',
    group: 'rbac',
    client: 'anon',
    query: `{ books_aggregate { aggregate { count } } }`,
  },
  {
    id: 'rbac_anon_rows',
    group: 'rbac',
    client: 'anon',
    query: `{ books(order_by: {id: asc}, limit: 5) { id title in_print } }`,
  },
  // A different user must see a disjoint row set. Catches a row-permission
  // regression that a single-user check would miss.
  {
    id: 'rbac_other_user_rows',
    group: 'rbac',
    client: { role: 'user', userId: 12 },
    query: `{ reviews(order_by: {id: asc}, limit: 5) { id reviewer_id } }`,
  },

  // --- remote schema ------------------------------------------------------
  {
    id: 'remote_schema_query',
    group: 'remote',
    client: 'admin',
    query: `{ remotePing remoteBookInfo(bookId: 7) { bookId shelfCode warehouse } }`,
  },
  {
    id: 'remote_relationship',
    group: 'remote',
    client: 'admin',
    query: `{ books(where: {id: {_in: [7, 8]}}, order_by: {id: asc}) { id remote_info { shelfCode warehouse } } }`,
  },

  // --- actions ------------------------------------------------------------
  // Deterministic by construction: total = qty * unitPrice * 1.1 to 2dp.
  {
    id: 'action_sync_quote',
    group: 'action',
    client: 'admin',
    query: `{ computeQuote(qty: 3, unitPrice: "10.00") { qty unitPrice total } }`,
  },

  // --- RESTified endpoint -------------------------------------------------
  {
    id: 'rest_book_by_id',
    group: 'rest',
    client: 'admin',
    restPath: '/api/rest/book/7',
  },
]

/**
 * Probes whose *success* is receiving a specific error.
 *
 * A permission denial is a correctness property: if a version upgrade silently
 * started exposing `reviews.body` to the `user` role, every ordinary probe
 * would still pass while the deployment leaked data. These catch that.
 */
export type DenialSpec = {
  id: string
  group: ProbeGroup
  client: ClientSpec
  query: string
  /** Substring the returned error message must contain. */
  expectErrorContains: string
}

export const DENIAL_SPECS: DenialSpec[] = [
  {
    id: 'rbac_user_denied_body_column',
    group: 'rbac',
    client: { role: 'user', userId: 7 },
    query: `{ reviews(limit: 1) { body } }`,
    expectErrorContains: "field 'body' not found",
  },
  {
    id: 'rbac_anon_denied_price_column',
    group: 'rbac',
    client: 'anon',
    query: `{ books(limit: 1) { price } }`,
    expectErrorContains: "field 'price' not found",
  },
  {
    id: 'rbac_anon_denied_reviews_table',
    group: 'rbac',
    client: 'anon',
    query: `{ reviews(limit: 1) { id } }`,
    expectErrorContains: "field 'reviews' not found",
  },
]
