import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify("0.0.0-test") },
  test: { include: ["tests/**/*.test.ts"] },
});
