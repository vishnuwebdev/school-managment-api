import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage', 'drizzle', 'legacy'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Tenant-scoped data must go through repositories/services, never ad-hoc role-name checks.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'BinaryExpression[right.value=/^(SUPER_ADMIN|SCHOOL_ADMIN|PLATFORM_ADMIN)$/]',
          message:
            'Do not branch on role names. Check a permission with the authorization service instead.',
        },
      ],
    },
  },
  { files: ['tests/**'], rules: { 'no-restricted-syntax': 'off' } },
);
