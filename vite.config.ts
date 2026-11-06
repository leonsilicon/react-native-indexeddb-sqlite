import { defineConfig } from "vite-plus";
import flatcap from "eslint-plugin-flatcap";

const pkg = "npm/react-native-indexeddb-sqlite";

export default defineConfig({
  lint: {
    ...flatcap.configs.oxlint,
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: ["**/dist/**"],
    overrides: [
      {
        // node:test registers top-level tests through promises managed by its runner.
        files: ["**/__tests__/**"],
        rules: { "typescript/no-floating-promises": "off" },
      },
    ],
  },
  fmt: { ignorePatterns: ["**/dist/**"] },
  run: {
    tasks: {
      build: {
        command: `tsc -p ${pkg}/tsconfig.build.json`,
      },
      test: {
        cache: false,
        command: `node --test ${pkg}/__tests__/*.test.ts`,
      },
      typecheck: { command: "tsc --noEmit" },
    },
  },
});
