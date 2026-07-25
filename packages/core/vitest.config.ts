import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 20_000,
    setupFiles: ["./tests/setup.ts"],
    // These are integration tests against a real Neon Postgres database
    // (see tests/service.test.ts) — the neon-http driver talks to Neon's
    // HTTPS endpoint, not the Postgres wire protocol, so there's no local
    // container equivalent to run against instead. Each test cleans up the
    // rows it creates; see the afterEach hook in the test file.
  },
});
