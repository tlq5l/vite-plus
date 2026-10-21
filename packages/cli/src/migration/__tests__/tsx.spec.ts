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
    ['tsx --no_cache ./a.ts', 'vpx ./a.ts'],
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
    ["sh -c 'tsx src/a.ts && vp build'", "sh -c 'vpx src/a.ts && vp build'"],
    ['cross-env-shell "tsx src/a.ts"', 'cross-env-shell "vpx src/a.ts"'],
  ])('rewrites %s', (command, expected) => {
    const result = rewriteTsxCommand(command);
    expect(result.command).toBe(expected);
    expect(result.kept).toEqual([]);
    // Running the migration again changes nothing.
    expect(rewriteTsxCommand(expected)).toEqual({ command: expected, kept: [] });
  });

  it.each([
    ['vpx ./a.ts'],
    ['vp build'],
    ['oxlint src/app.tsx'],
    ['node ./a.js'],
    ['tsx-foo ./a.ts'],
  ])('leaves %s alone', (command) => {
    expect(rewriteTsxCommand(command)).toEqual({ command, kept: [] });
  });

  it.each([
    ["tsx -e 'console.log(1)'", '--eval or --print'],
    ['tsx --print 1', '--eval or --print'],
    ['tsx -c ./a.js', '-c or --check'],
    ['tsx', 'REPL'],
    ['tsx watch', 'REPL'],
    ['tsx --test', 'list the test files'],
    ['tsx src/index', '`src/index` has no file extension'],
    ['tsx --watch-path=src ./a.ts', '--watch-path'],
    ['tsx --watch_path=src ./a.ts', '--watch-path'],
    ['tsx ./a.ts | tee log', 'shell syntax'],
    ['tsx $ENTRY', 'shell syntax'],
    ['node --import tsx', 'REPL'],
    ['node --import tsx -e 1', '--eval or --print'],
    ['node --import tsx --watch-path src ./a.ts', '--watch-path'],
    ["NODE_OPTIONS='--import tsx' node ./a.ts", 'does not rewrite this use of tsx'],
    ['pnpm dlx tsx ./a.ts', 'does not rewrite this use of tsx'],
    // A quoted argument of a program that does not run commands is data.
    ['echo "tsx scripts/build.ts"', 'does not rewrite this use of tsx'],
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

  describe('with the scripts it runs', () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-test-tsx-scripts-'));
      fs.writeFileSync(path.join(dir, 'package.json'), '{}\n');
      fs.writeFileSync(path.join(dir, 'esm.cts'), 'export const a = 1;\n');
      fs.writeFileSync(path.join(dir, 'cjs.cts'), 'exports.a = 1;\n');
      fs.writeFileSync(
        path.join(dir, 'dirname.ts'),
        "import fs from 'node:fs';\nfs.readdirSync(__dirname);\n",
      );
      fs.writeFileSync(
        path.join(dir, 'plain.ts'),
        "import fs from 'node:fs';\nfs.readdirSync('.');\n",
      );
      fs.writeFileSync(
        path.join(dir, 'exports.ts'),
        "import fs from 'node:fs';\nmodule.exports = fs.readdirSync('.');\n",
      );
      // ES module idioms that only look like CommonJS globals.
      fs.writeFileSync(
        path.join(dir, 'esm-idioms.ts'),
        [
          "import path from 'node:path';",
          "import { createRequire } from 'node:module';",
          "import { fileURLToPath } from 'node:url';",
          'const __dirname = path.dirname(fileURLToPath(import.meta.url));',
          'const require = createRequire(import.meta.url);',
          "const pkg = require(path.join(__dirname, 'package.json'));",
          'console.log(pkg.exports.x);',
          '',
        ].join('\n'),
      );
      // Only `cd tools` finds this script.
      fs.mkdirSync(path.join(dir, 'tools'));
      fs.writeFileSync(
        path.join(dir, 'tools/only.ts'),
        "import fs from 'node:fs';\nfs.readdirSync(__dirname);\n",
      );
      fs.writeFileSync(path.join(dir, 'tools/plain.ts'), 'export {};\n');
      // tsx resolves `require('./helper.js')` to `helper.ts`; `vpx` does not.
      fs.writeFileSync(path.join(dir, 'helper.ts'), 'exports.x = 1;\n');
      fs.writeFileSync(path.join(dir, 'require-js.cts'), "const { x } = require('./helper.js');\n");
      fs.writeFileSync(path.join(dir, 'require-bare.cts'), "const { x } = require('./helper');\n");
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it.each([
      ['tsx esm.cts', '`esm.cts` uses import or export'],
      ['node --import tsx ./esm.cts', '`./esm.cts` uses import or export'],
      ['tsx watch dirname.ts', '`dirname.ts` mixes import with CommonJS globals'],
      ['tsx --test plain.ts dirname.ts', '`dirname.ts` mixes import with CommonJS globals'],
      ['concurrently "tsx dirname.ts"', '`dirname.ts` mixes import with CommonJS globals'],
      ['cd tools && tsx only.ts', '`only.ts` mixes import with CommonJS globals'],
      ['tsx exports.ts', '`exports.ts` mixes import with CommonJS globals'],
      ['tsx require-js.cts', 'requires `./helper.js`, which only tsx resolves to `./helper.ts`'],
      ['pushd tools && tsx plain.ts', 'changes the directory'],
    ])('keeps %s', (command, reason) => {
      expect(rewriteTsxCommand(command, dir)).toEqual({
        command,
        kept: [expect.stringContaining(reason)],
      });
    });

    it.each([
      ['tsx cjs.cts', 'vpx cjs.cts'],
      ['tsx plain.ts', 'vpx plain.ts'],
      ['tsx esm-idioms.ts', 'vpx esm-idioms.ts'],
      ['tsx require-bare.cts', 'vpx require-bare.cts'],
      ['tsx --test plain.ts', 'vpx --test plain.ts'],
      ['cd tools && tsx plain.ts', 'cd tools && vpx plain.ts'],
    ])('rewrites %s', (command, expected) => {
      expect(rewriteTsxCommand(command, dir)).toEqual({ command: expected, kept: [] });
    });

    it('rewrites a script with __dirname in an ES module package', () => {
      fs.writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }\n');
      // `"type": "module"` already ran it as an ES module under tsx.
      expect(rewriteTsxCommand('tsx dirname.ts', dir).command).toBe('vpx dirname.ts');
    });
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
    // File extensions are not uses of tsx.
    write('vite.config.ts', "export default { resolve: { extensions: ['ts', 'tsx'] } };\n");
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
    ['a kept script', 'package.json', undefined, '`scripts` in package.json still uses tsx'],
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
      'a bash script',
      'tools/release.bash',
      'tsx scripts/release.ts\n',
      'tools/release.bash still uses tsx',
    ],
    [
      'an extensionless shebang file',
      'bin/release',
      '#!/usr/bin/env tsx\nexport {};\n',
      'bin/release still uses tsx',
    ],
    [
      'a nested package',
      'examples/demo/package.json',
      '{ "scripts": { "start": "tsx index.ts" } }\n',
      '`scripts` in examples/demo/package.json still uses tsx',
    ],
    [
      'build output',
      'dist/launcher.js',
      "import { register } from 'tsx/esm/api';\n",
      'dist/launcher.js still uses tsx',
    ],
    [
      'a process call',
      'src/run.ts',
      "import { spawn } from 'node:child_process';\nspawn('tsx', ['job.ts']);\n",
      'src/run.ts still uses tsx',
    ],
    [
      'a shell pipe into tsx',
      'scripts/run.sh',
      'cat job.ts | tsx\n',
      'scripts/run.sh still uses tsx',
    ],
    [
      'a JSON tool config',
      '.mocharc.json',
      '{ "require": "tsx", "spec": "test/**/*.test.ts" }\n',
      '.mocharc.json still uses tsx',
    ],
    [
      'a JavaScript tool config',
      'ava.config.js',
      "export default { nodeArguments: ['--import=tsx'] };\n",
      'ava.config.js still uses tsx',
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

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'])(
    'keeps tsx in a package that lists it in %s',
    (field) => {
      write('package.json', {
        scripts: { start: 'tsx src/server.ts' },
        [field]: { tsx: '^4.20.0' },
      });
      const report = createMigrationReport();

      expect(detectTsxProject(root)).toBe(false);
      expect(migrateTsxToVpx(root, undefined, report).changed).toBe(false);
      expect(readJson('package.json').scripts.start).toBe('tsx src/server.ts');
      expect(report.warnings).toEqual([expect.stringContaining('Kept tsx in package.json')]);
    },
  );

  it('keeps the tsx dependency of a workspace package used by its nested example', () => {
    write('package.json', { private: true });
    write('packages/a/package.json', {
      scripts: { gen: 'tsx gen.ts' },
      devDependencies: { tsx: '^4.20.0' },
    });
    write('packages/a/examples/demo/main.ts', "import { tsImport } from 'tsx/esm/api';\n");
    write('packages/a/examples/demo/package.json', { private: true });
    const report = createMigrationReport();

    migrateTsxToVpx(root, [{ name: 'a', path: 'packages/a' }], report);

    expect(readJson('packages/a/package.json')).toEqual({
      scripts: { gen: 'vpx gen.ts' },
      devDependencies: { tsx: '^4.20.0' },
    });
    expect(report.warnings).toEqual([
      'Kept the tsx devDependency in packages/a/package.json: packages/a/examples/demo/main.ts still uses tsx.',
    ]);
  });

  it.each([
    ['imports', { '#loader': { node: 'tsx/esm/api' } }],
    ['ava', { extensions: { ts: 'module' }, nodeArguments: ['--import=tsx'] }],
  ])('keeps the tsx dependency used by the %s field of package.json', (field, value) => {
    write('package.json', {
      scripts: { dev: 'tsx watch src/server.ts' },
      [field]: value,
      devDependencies: { tsx: '^4.20.0' },
    });
    const report = createMigrationReport();

    expect(migrateTsxToVpx(root, undefined, report).dependencyRemoved).toBe(false);
    expect(readJson('package.json').scripts.dev).toBe('vpx --watch src/server.ts');
    expect(report.warnings).toEqual([
      `Kept the tsx devDependency in package.json: \`${field}\` in package.json still uses tsx.`,
    ]);
  });

  it('detects tsx tasks in a lint-staged JSON file', () => {
    write('package.json', { scripts: { prepare: 'husky' } });
    write('.lintstagedrc.json', { '*.ts': 'tsx scripts/check.ts' });

    expect(detectTsxProject(root)).toBe(true);
    migrateTsxToVpx(root);
    expect(readJson('.lintstagedrc.json')).toEqual({ '*.ts': 'vpx scripts/check.ts' });
    expect(detectTsxProject(root)).toBe(false);
  });

  it('rewrites shebang options as it rewrites commands', () => {
    write('package.json', { type: 'module' });
    write('scripts/a.ts', '#!/usr/bin/env -S tsx --no-cache --tsconfig cli.json\nexport {};\n');
    write('scripts/b.ts', '#!/usr/bin/env -S tsx -e x\nexport {};\n');
    const report = createMigrationReport();

    migrateTsxToVpx(root, undefined, report);

    expect(read('scripts/a.ts')).toBe('#!/usr/bin/env -S vpx --tsconfig cli.json\nexport {};\n');
    expect(read('scripts/b.ts')).toBe('#!/usr/bin/env -S tsx -e x\nexport {};\n');
    expect(report.warnings).toEqual([
      expect.stringContaining('Kept tsx in the shebang of scripts/b.ts: `vpx` does not run'),
    ]);
  });

  it('keeps tsx for a script that would lose CommonJS globals under vpx', () => {
    write('package.json', { scripts: { build: 'tsx scripts/build.ts' } });
    write('scripts/build.ts', "import fs from 'node:fs';\nfs.readdirSync(__dirname);\n");
    write('scripts/release.ts', '#!/usr/bin/env tsx\nimport fs from "node:fs";\nrequire("x");\n');
    const report = createMigrationReport();

    expect(detectTsxProject(root)).toBe(false);
    migrateTsxToVpx(root, undefined, report);

    expect(readJson('package.json').scripts.build).toBe('tsx scripts/build.ts');
    expect(read('scripts/release.ts')).toMatch(/^#!\/usr\/bin\/env tsx\n/);
    expect(report.warnings).toEqual([
      expect.stringContaining(
        'Kept tsx in package.json scripts "build": `scripts/build.ts` mixes import with CommonJS globals',
      ),
      expect.stringContaining(
        'Kept tsx in the shebang of scripts/release.ts: `./release.ts` mixes import with CommonJS globals',
      ),
    ]);
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
      'Kept the tsx devDependency in package.json: `scripts` in packages/b/package.json still uses tsx.',
    ]);
  });
});
