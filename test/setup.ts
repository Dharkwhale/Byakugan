// Loads .env into process.env for tests that need real config (e.g. later
// integration tests hitting real RPC endpoints). Absent-file case is
// intentionally swallowed: most environments (CI, fresh checkouts) won't
// have a .env at all, and that must be harmless here.
try {
  process.loadEnvFile('.env');
} catch {
  // .env not present (or unreadable) — nothing to load, nothing to do.
}
