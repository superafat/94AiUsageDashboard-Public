module.exports = {
  root: true,
  env: { es2022: true, node: true },
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: ['node_modules/', 'dist/', '.worktrees/'],
  overrides: [{ files: ['**/*.tsx'], parserOptions: { ecmaFeatures: { jsx: true } }, env: { browser: true } }],
};
