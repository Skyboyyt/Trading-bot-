import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/migrations/**", "apps/web/playwright-report/**", "apps/web/test-results/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "no-console": ["error", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always"],
      // Money must never pass through floating point: forbid parseFloat and Number() on amounts by convention.
      "no-restricted-globals": ["error", { name: "parseFloat", message: "Use parseDec/parseRaw; never floats for money." }],
    },
  },
  {
    files: ["**/cli/**/*.ts", "scripts/**/*.ts", "**/*.test.ts", "**/*.int.test.ts", "apps/*/src/main.ts"],
    rules: { "no-console": "off" },
  },
);
