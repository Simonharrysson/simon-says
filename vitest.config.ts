import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const resolve = {
  // `server-only` throws outside the react-server condition; stub it in tests.
  alias: {
    "server-only": fileURLToPath(new URL("./test/server-only-stub.ts", import.meta.url)),
    "@": fileURLToPath(new URL("./", import.meta.url)),
  },
};

// Everything under tests/ runs against ONE local Supabase stack (test/local-supabase.ts) in CI.
// Those files run one at a time: in parallel they overloaded the stack's API gateway, which then
// answered writes with 502 "An invalid response was received from the upstream server" (a
// random insert/update/rpc in a random file; the gateway retries GETs, not writes), and
// load-sensitive timing checks (leases, elapsed seconds, mint spacing) drifted. The unit tests
// (no DB) stay parallel and run alongside them.
const DB = "tests/**/*.test.ts";

export default defineConfig({
  resolve,
  test: {
    projects: [
      {
        resolve,
        test: {
          name: "unit",
          include: ["**/*.test.ts"],
          exclude: ["node_modules/**", "spike/**", ".next/**", "supabase/**", DB],
        },
      },
      {
        resolve,
        test: {
          name: "db",
          include: [DB],
          fileParallelism: false,
        },
      },
    ],
  },
});
