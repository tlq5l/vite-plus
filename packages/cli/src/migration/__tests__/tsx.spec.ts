import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn() },
}));

import { detectTsxProject, migrateTsxToVpx, rewriteTsxCommand } from '../migrator/tsx.ts';
import { createMigrationReport } from '../report.ts';

describe('rewriteTsxCommand', () => {
  it.each([
    ['tsx ./src/seed.ts --flag', 'vpx ./src/seed.ts --flag'],
    ['tsx src/seed.ts', 'vpx src/seed.ts'],
    ['tsx watch src/server.ts', 'vpx --watch src/server.ts'],
    [
      'tsx watch --clear-screen=false --include "config/*.json" --exclude src/gen.ts --tsconfig tsconfig.app.json src/server.ts --port 3000',
      'vpx --watch --clear-screen=false --include "config/*.json" --exclude src/gen.ts --tsconfig tsconfig.app.json src/server.ts --port 3000',
    ],
    ['tsx watch --no-cache src/server.ts', 'vpx --watch src/server.ts'],
    ['tsx --no-cache ./a.ts', 'vpx ./a.ts'],
    ['tsx --watch ./a.ts', 'vpx --watch ./a.ts'],
    ['tsx --env-file=.env --inspect ./a.ts', 'vpx --env-file=.env --inspect ./a.ts'],
    ['tsx --env-file .env ./a.ts arg', 'vpx --env-file .env ./a.ts arg'],
    ['tsx --test ./a.test.ts', 'vpx --test ./a.test.ts'],
    ["tsx 'my script.ts'", "vpx 'my script.ts'"],
    ['npx tsx ./a.ts', 'vpx ./a.ts'],
    ['pnpm exec tsx ./a.ts', 'vpx ./a.ts'],
    ['pnpm tsx ./a.ts', 'vpx ./a.ts'],
    ['yarn tsx watch ./a.ts', 'vpx --watch ./a.ts'],
    ['bunx tsx ./a.ts', 'vpx ./a.ts'],
    ['NODE_ENV=test tsx ./a.ts', 'NODE_ENV=test vpx ./a.ts'],
    ['cross-env NODE_ENV=production tsx ./a.ts', 'cross-env NODE_ENV=production vpx ./a.ts'],
    ['tsx ./a.ts && tsx watch ./b.ts; vp build', 'vpx ./a.ts && vpx --watch ./b.ts; vp build'],
    ['node --import tsx ./a.ts', 'vpx ./a.ts'],
    ['node --import=tsx --inspect ./a.ts', 'vpx --inspect ./a.ts'],
    ['node --loader tsx/esm --watch ./a.ts', 'vpx --watch ./a.ts'],
    ['node -r tsx/cjs ./a.cts', 'vpx ./a.cts'],
    ['node --import tsx --import ./setup.ts ./a.ts', 'vpx --import ./setup.ts ./a.ts'],
    [
      'concurrently "tsx watch src/api.ts" "vp dev"',
      'concurrently "vpx --watch src/api.ts" "vp dev"',
    ],
    ["nodemon --exec 'tsx src/a.ts'", "nodemon --exec 'vpx src/a.ts'"],
  ])('rewrites %s', (command, expected) => {
    const result = rewriteTsxCommand(command);
    expect(result.command).toBe(expected);
    expect(result.kept).toEqual([]);
    // Running the migration again changes nothing.
    expect(rewriteTsxCommand(expected)).toEqual({
      command: expected,
      entries: [],
      kept: [],
    });
  });

  it.each([
    ['vpx ./a.ts'],
    ['vp build'],
    ['oxlint src/app.tsx'],
    ['node ./a.js'],
    ['tsx-foo ./a.ts'],
  ])('leaves %s alone', (command) => {
    expect(rewriteTsxCommand(command)).toEqual({ command, entries: [], kept: [] });
  });

  it.each([
    ["tsx -e 'console.log(1)'", '--eval or --print'],
    ['tsx --print 1', '--eval or --print'],
    ['tsx', 'REPL'],
    ['tsx watch', 'REPL'],
    ['tsx --test', 'list the test files'],
    ['tsx src/index', '`src/index` has no file extension'],
    ['tsx --watch-path=src ./a.ts', '--watch-path'],
    ['tsx ./a.ts | tee log', 'shell syntax'],
    ['tsx $ENTRY', 'shell syntax'],
    ['node --import tsx', 'REPL'],
    ['node --import tsx -e 1', '--eval or --print'],
    ["NODE_OPTIONS='--import tsx' node ./a.ts", 'does not rewrite this use of tsx'],
    ['pnpm dlx tsx ./a.ts', 'does not rewrite this use of tsx'],
  ])('keeps %s', (command, reason) => {
    const result = rewriteTsxCommand(command);
    expect(result.command).toBe(command);
    expect(result.kept).toEqual([expect.stringContaining(reason)]);
  });

  it('rewrites the parts of a command list that vpx can run', () => {
    const result = rewriteTsxCommand("tsx ./a.ts && tsx -e 'run()'");
    expect(result.command).toBe("vpx ./a.ts && tsx -e 'run()'");
    expect(result.kept).toEqual([expect.stringContaining('--eval')]);
  });

  it('reports the scripts the rewritten commands run', () => {
    expect(
      rewriteTsxCommand('tsx watch --include x.json src/a.ts && node --import tsx ./b.ts').entries,
    ).toEqual(['src/a.ts', './b.ts']);
    expect(rewriteTsxCommand('tsx --test ./a.test.ts').entries).toEqual([]);
  });
});

describe('migrateTsxToVpx', () => {
  let root: string;

  const write = (file: string, content: string | object) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`,
    );
  };
  const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
  const readJson = (file: string) => JSON.parse(read(file));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-test-tsx-'));
    vi.spyOn(process, 'cwd').mockReturnValue(root);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rewrites scripts, lint-staged tasks, and shebangs, then removes tsx', () => {
    write('package.json', {
      type: 'module',
      scripts: { dev: 'tsx watch src/server.ts', seed: 'npx tsx scripts/seed.ts' },
      'lint-staged': { '*.ts': ['tsx scripts/check.ts'] },
      devDependencies: { tsx: '^4.20.0', vite: '^7.0.0' },
    });
    write('.lintstagedrc.json', { '*.md': 'tsx scripts/docs.ts' });
    write('scripts/release.ts', '#!/usr/bin/env tsx\nconsole.log("release");\n');
    write('src/server.ts', 'export {};\n');
    const report = createMigrationReport();

    expect(detectTsxProject(root)).toBe(true);
    expect(migrateTsxToVpx(root, undefined, report)).toEqual({
      changed: true,
      dependencyRemoved: true,
    });

    expect(readJson('package.json')).toEqual({
      type: 'module',
      scripts: { dev: 'vpx --watch src/server.ts', seed: 'vpx scripts/seed.ts' },
      'lint-staged': { '*.ts': ['vpx scripts/check.ts'] },
      devDependencies: { vite: '^7.0.0' },
    });
    expect(readJson('.lintstagedrc.json')).toEqual({ '*.md': 'vpx scripts/docs.ts' });
    expect(read('scripts/release.ts')).toBe('#!/usr/bin/env vpx\nconsole.log("release");\n');
    expect(report.tsxMigrated).toBe(true);
    expect(report.warnings).toEqual([]);

    // A second run has nothing left to do.
    expect(detectTsxProject(root)).toBe(false);
    expect(migrateTsxToVpx(root, undefined, createMigrationReport())).toEqual({
      changed: false,
      dependencyRemoved: false,
    });
  });

  it.each([
    ['a kept script', 'package.json', undefined, 'scripts in package.json still run tsx'],
    [
      'an import of the tsx API',
      'src/load.ts',
      "import { tsImport } from 'tsx/esm/api';\n",
      'src/load.ts still uses tsx',
    ],
    [
      'a CI workflow',
      '.github/workflows/ci.yml',
      'jobs:\n  run: npx tsx scripts/ci.ts\n',
      '.github/workflows/ci.yml still uses tsx',
    ],
    [
      'a git hook',
      '.husky/pre-commit',
      'npx tsx scripts/check.ts\n',
      '.husky/pre-commit still uses tsx',
    ],
    [
      'an extensionless shebang file',
      'bin/release',
      '#!/usr/bin/env tsx\nexport {};\n',
      'bin/release still uses tsx',
    ],
  ])('keeps the tsx dependency used by %s', (_, file, content, user) => {
    write('package.json', {
      scripts: {
        dev: 'tsx watch src/server.ts',
        ...(content === undefined ? { repl: 'tsx' } : {}),
      },
      devDependencies: { tsx: '^4.20.0' },
    });
    if (content !== undefined) {
      write(file, content);
    }
    const report = createMigrationReport();

    expect(migrateTsxToVpx(root, undefined, report).dependencyRemoved).toBe(false);
    expect(readJson('package.json').scripts.dev).toBe('vpx --watch src/server.ts');
    expect(readJson('package.json').devDependencies).toEqual({ tsx: '^4.20.0' });
    expect(report.warnings).toContain(`Kept the tsx devDependency in package.json: ${user}.`);
  });

  it('keeps tsx in a package that depends on it at runtime', () => {
    write('package.json', {
      scripts: { start: 'tsx src/server.ts' },
      dependencies: { tsx: '^4.20.0' },
    });
    const report = createMigrationReport();

    expect(detectTsxProject(root)).toBe(false);
    expect(migrateTsxToVpx(root, undefined, report).changed).toBe(false);
    expect(readJson('package.json').scripts.start).toBe('tsx src/server.ts');
    expect(report.warnings).toEqual([expect.stringContaining('Kept tsx in package.json')]);
  });

  it('keeps the root tsx while a workspace package still uses it', () => {
    write('package.json', { private: true, devDependencies: { tsx: '^4.20.0' } });
    write('packages/a/package.json', { scripts: { gen: 'tsx gen.ts' } });
    write('packages/b/package.json', { scripts: { calc: "tsx -e 'run()'" } });
    const packages = [
      { name: 'a', path: 'packages/a' },
      { name: 'b', path: 'packages/b' },
    ];
    const report = createMigrationReport();

    migrateTsxToVpx(root, packages, report);

    expect(readJson('packages/a/package.json').scripts.gen).toBe('vpx gen.ts');
    expect(readJson('packages/b/package.json').scripts.calc).toBe("tsx -e 'run()'");
    expect(readJson('package.json').devDependencies).toEqual({ tsx: '^4.20.0' });
    expect(report.warnings).toEqual([
      expect.stringContaining('Kept tsx in packages/b/package.json scripts "calc"'),
      'Kept the tsx devDependency in package.json: scripts in packages/b/package.json still run tsx.',
    ]);
  });

  it('warns about CommonJS globals in an entry that now runs as an ES module', () => {
    write('package.json', { scripts: { build: 'tsx scripts/build.ts' } });
    write('scripts/build.ts', "import fs from 'node:fs';\nfs.readdirSync(__dirname);\n");
    const report = createMigrationReport();

    migrateTsxToVpx(root, undefined, report);

    expect(report.warnings).toEqual([
      expect.stringContaining('scripts/build.ts uses ES module syntax with __dirname'),
    ]);
  });
});
