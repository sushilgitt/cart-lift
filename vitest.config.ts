import { defineConfig } from "vitest/config";

// Tests for the shared packages. The Discount Function has its own suite in
// extensions/cartlift-discount (it builds the Wasm module); `npm test` runs both.
export default defineConfig({
  test: {
    include: ["packages/**/tests/**/*.test.ts", "app/**/*.test.ts"],
  },
});
