import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".tmp-specs", reporter: "line", workers: 2 });
