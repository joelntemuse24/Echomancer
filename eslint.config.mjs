import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "workers/**",
    "scripts/oracle/**/*.cjs",
    // The pinned upstream checkout that the Modal numeric tests compare
    // against (`scripts/s2/fetch-fish-source.sh`). It is third-party code that
    // is not part of this project; linting it reports its own config as errors.
    ".fish-speech-src/**",
  ]),
]);

export default eslintConfig;
