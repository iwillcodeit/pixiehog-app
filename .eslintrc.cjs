/** @type {import('@types/eslint').Linter.BaseConfig} */
module.exports = {
  root: true,
  extends: [
    "@remix-run/eslint-config",
    "@remix-run/eslint-config/node",
    "@remix-run/eslint-config/jest-testing-library",
    "prettier",
  ],
  globals: {
    shopify: "readonly"
  },
  settings: {
    // eslint-plugin-jest (pulled in by the Remix jest preset) crashes without a version when jest is absent; tests run on vitest
    jest: { version: 29 },
  },
};
