import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      ".bun/**",
      ".tmp/**",
      "data/**",
      "dist/**",
      "node_modules/**",
      "example/**",
      "test-results/**",
      "tests/**",
      "commitlint.config.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
];
