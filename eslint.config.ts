// ESLint for every TypeScript package: sdk, app, agent and web. Prettier formats; ESLint finds bugs.
// Typed rules read each package's own tsconfig.json through the project service.
//
// A rule is turned off or changed here only with its reason beside it. A finding in one place is
// suppressed there instead, with "-- <reason>; review-by: YYYY-MM-DD".
import js from "@eslint/js";
import vitest from "@vitest/eslint-plugin";
import prettier from "eslint-config-prettier/flat";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

const tests = ["*/test/**/*.ts"];

export default defineConfig(
  globalIgnores(["**/node_modules/", "**/dist/", "contracts/", "app/test/fixtures/", "app/data/"]),
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
      reportUnusedInlineConfigs: "error",
    },
  },
  {
    name: "bona-fide/typescript",
    files: ["{sdk,app,agent,web}/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // verbatimModuleSyntax keeps every import as written, so type-only imports must say so, and
      // inline, as the code already writes them.
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/consistent-type-exports": ["error", { fixMixedExportsWithInlineTypeSpecifier: true }],
      "@typescript-eslint/no-import-type-side-effects": "error",
      // A switch over a union names every member, so a new Kind or outcome can't fall through unseen.
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { allowDefaultCaseForExhaustiveSwitch: true, considerDefaultExhaustiveForUnions: true },
      ],
      // Numbers and bigints (amounts, Serials, ports) print exactly in a template; null, undefined,
      // objects and any are still refused.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // `return show(...)` and `(note = text, paint())` end a step in one line, on purpose, across the
      // pages; the rule is about style, and no-floating-promises still covers what a void can hide.
      "@typescript-eslint/no-confusing-void-expression": "off",
      // noUncheckedIndexedAccess is on, so `!` is how the code says a lookup it knows succeeds does;
      // a wrong one throws at once. no-unnecessary-type-assertion still removes the needless ones.
      "@typescript-eslint/no-non-null-assertion": "off",
      // `{ block: _, ...event }` drops a field on purpose: a leading underscore marks it unused.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // `process.env.X || DEFAULT` treats an empty variable as unset, on purpose; `??` would keep "".
      "@typescript-eslint/prefer-nullish-coalescing": ["error", { ignorePrimitives: { string: true } }],
      // `catch {}` is how the code says a failure there is expected and changes nothing.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // `() => {}` is the code's no-op: the swallowed tail of a queue, a stop with nothing to stop,
      // a silenced log level.
      "@typescript-eslint/no-empty-function": "off",
      // An async function that doesn't await yet still keeps its interface's promise and turns a
      // throw into a rejection; dropping `async` to please the rule would change that.
      "@typescript-eslint/require-await": "off",
      // Dependencies are passed as objects of functions and destructured; no function in src reads
      // `this`, so a method passed on its own can't lose it.
      "@typescript-eslint/unbound-method": "off",
      // `return void f()` is the house way to end a step with a call, whatever f returns.
      "@typescript-eslint/no-meaningless-void-operator": "off",
      // `!link || link.outcome === "active"` narrows `link` for the code after it; `link?.outcome`
      // doesn't, and reads no clearer.
      "@typescript-eslint/prefer-optional-chain": "off",
    },
  },
  {
    name: "bona-fide/tests",
    files: tests,
    extends: [vitest.configs.recommended],
    rules: {
      // Tests read fakes' bodies and JSON as they come: a wrong shape fails the assertion that reads it.
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/restrict-plus-operands": "off",
      // CDP messages, fake GitHub replies and fake fetches are untyped by nature.
      "@typescript-eslint/no-explicit-any": "off",
      // Fake fetches stringify the URL and body they were sent, which are strings and URLs here.
      "@typescript-eslint/no-base-to-string": "off",
      // `anvil?.stop()` in afterAll still runs when beforeAll failed and left it unset, though its
      // declared type says it is always set.
      "@typescript-eslint/no-unnecessary-condition": "off",
      // A test's `"0x…" as Hex` or `"pr" as Kind` sets the type a literal is inferred as, which the
      // rule doesn't see: removing one fails tsc.
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      // Test helpers use `this`: vitest's version of the rule also knows expect(fake.method).
      "vitest/unbound-method": "error",
      // vitest's expect takes a message as its second argument, and the tests use it.
      "vitest/valid-expect": ["error", { maxArgs: 2 }],
    },
  },
  {
    // The root config isn't in any package's tsconfig: lint it without type information.
    name: "bona-fide/config",
    files: ["eslint.config.ts"],
    extends: [js.configs.recommended, tseslint.configs.strict, tseslint.configs.stylistic],
  },
  {
    // The landing page's scripts load as written in the browser, with no build step and no types.
    name: "bona-fide/landing",
    files: ["web/landing/**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.browser },
  },
  // Last, so Prettier stays the only formatter.
  prettier,
);
