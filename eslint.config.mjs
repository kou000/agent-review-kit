import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      // ignoreRestSiblings: `const { x, ...rest } = obj` is how this codebase
      // builds an object minus one field (see deliveredPayload); the omitted
      // binding is intentionally unused.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'src/client/'],
  }
);
