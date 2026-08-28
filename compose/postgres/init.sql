-- Two databases, per the design's prerequisite: metadata must live separately from
-- the data source so that green can boot against a *clone* of the metadata store
-- while blue keeps serving against the original.
--
-- Note this does NOT isolate event-trigger state. Hasura stores event_log and
-- event_invocation_logs in the hdb_catalog schema of the database containing the
-- source table, i.e. in appdb. That surface stays shared between blue and green
-- during the overlap; the harness measures whether it causes trouble.
CREATE DATABASE appdb;
CREATE DATABASE hasura_metadata;
