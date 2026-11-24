import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // `server-only` throws outside the react-server condition; stub it in tests.
    alias: { "server-only": fileURLToPath(new URL("./test/server-only-stub.ts", import.meta.url)) },
  },
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "spike/**", ".next/**", "supabase/**"],
  },
});
