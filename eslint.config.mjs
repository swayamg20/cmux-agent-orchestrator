import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig(
  globalIgnores([
    "coverage/**",
    "docs/**",
    "main.js",
    "node_modules/**",
    "tests/fixtures/**"
  ]),
  ...obsidianmd.configs.recommended,
  {
    files: ["scripts/**/*.mts", "src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".json"]
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "obsidianmd/settings-tab/prefer-setting-definitions": "off",
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          brands: ["Agent Cockpit", "Claude", "Codex", "Markdown", "cmux", "cmux Agent Orchestrator"]
        }
      ]
    }
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: globals.node
    },
    rules: {
      "obsidianmd/rule-custom-message": "off"
    }
  }
);
