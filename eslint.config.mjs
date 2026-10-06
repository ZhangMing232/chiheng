import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Flat ESLint config for the TanStack Start app-builder template. */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      ".output/**",
      ".vercel/**",
      ".nitro/**",
      "node_modules/**",
      "src/routeTree.gen.ts",
      // 小程序移植的编译产物：tsc 生成的 CommonJS，全是 require()。
      // 不是手写代码，不该按源码的规则去扫。mp/src 才是维护用的那份 TS。
      "mp/build/**",
      "mp/miniprogram/lib/market/**",
      "mp/cloudfunctions/*/market/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // Disable rules that conflict with Prettier formatting.
  prettier,
  // 小程序是另一套运行时：CommonJS（require/module.exports）+ wx 全局对象。
  // 上面那套规则是给 React ESM 应用定的，套过来会满屏报错，所以单开一段。
  {
    files: ["mp/**/*.js", "mp/**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        // 微信小程序运行时注入的全局
        wx: "readonly",
        App: "readonly",
        Page: "readonly",
        Component: "readonly",
        Behavior: "readonly",
        getApp: "readonly",
        getCurrentPages: "readonly",
        requirePlugin: "readonly",
      },
    },
    rules: {
      // CommonJS 的 require 在这里是唯一合法的模块写法
      "@typescript-eslint/no-require-imports": "off",
      "no-undef": "error",
    },
  },
);
