import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Production runs on MariaDB, local development on MySQL 8. Some MySQL 8 syntax is a
 * syntax error on MariaDB and only fails once deployed, so guard against it here.
 */
const SRC = fileURLToPath(new URL('../../src', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

const RULES: { name: string; pattern: RegExp; hint: string }[] = [
  {
    // Drizzle renders .for('share') as `FOR SHARE`, which MariaDB rejects.
    name: 'FOR SHARE row lock',
    pattern:
      /\.for\(\s*['"]share['"]|['"]share['"]\s*\|\s*['"]update['"]|['"]update['"]\s*\|\s*['"]share['"]|\bfor share\b/i,
    hint: "use .for('update') instead",
  },
  {
    name: 'MySQL-only SQL function or clause',
    pattern:
      /\b(JSON_TABLE|ANY_VALUE|REGEXP_LIKE|BIN_TO_UUID|UUID_TO_BIN|JSON_OVERLAPS)\s*\(|\bjoin\s+lateral\b|\bmember of\s*\(|utf8mb4_0900_ai_ci/i,
    hint: 'not available on MariaDB',
  },
];

describe('MariaDB compatibility', () => {
  const files = sourceFiles(SRC);

  for (const rule of RULES) {
    it(`src/ has no ${rule.name}`, () => {
      const hits: string[] = [];
      for (const file of files) {
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (rule.pattern.test(line)) hits.push(`${file.slice(SRC.length + 1)}:${i + 1}`);
          });
      }
      expect(hits, rule.hint).toEqual([]);
    });
  }
});
