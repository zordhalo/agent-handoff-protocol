import { existsSync } from "node:fs";

// Same pattern as scripts/demo.ts: load a local .env/.env.local if present.
// In CI, DATABASE_URL and TRANSFER_TOKEN_SECRET come from repository
// secrets instead — see .github/workflows/ci.yml.
for (const file of [".env.local", ".env", "../../.env.local", "../../.env"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}
