// Loads .env into process.env for tests that need real config — the real-provider
// smoke test hits a live endpoint and needs a credential.
//
// The absent-file case is swallowed on purpose: CI and fresh checkouts have no .env at
// all, and that must be harmless. Suites needing credentials skip themselves with a
// printed reason rather than failing.
//
// BYAKUGAN_NO_DOTENV=1 skips the load, so the skip path can be VERIFIED on a machine
// that does have a .env. Without it the only way to test "behaves correctly without
// credentials" is to move the real .env aside and remember to move it back — and a
// forgotten restore is precisely the failure this project has already had once, when a
// mutated scrubbing guard sat in the working tree unnoticed. Same fix as always: remove
// the step that depends on remembering.
if (process.env.BYAKUGAN_NO_DOTENV !== '1') {
  try {
    process.loadEnvFile('.env');
  } catch {
    // .env not present (or unreadable) — nothing to load, nothing to do.
  }
}
