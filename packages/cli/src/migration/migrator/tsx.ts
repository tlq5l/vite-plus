import fs from 'node:fs';
import path from 'node:path';
import { styleText } from 'node:util';

import * as prompts from '@voidzero-dev/vite-plus-prompts';

import { type LiteralCommandToken, parseLiteralCommands } from '../../../binding/index.js';
import { type WorkspacePackage } from '../../types/index.ts';
import { editJsonFile, isJsonFile, readJsonFile } from '../../utils/json.ts';
import { readNearestPackageJson } from '../../utils/package.ts';
import { displayRelative } from '../../utils/path.ts';
import { cancelAndExit } from '../../utils/prompts.ts';
import {
  NODE_OPTIONS_WITH_VALUE,
  SCRIPT_EXTENSIONS,
  WATCH_OPTIONS_WITH_VALUE,
} from '../../vpx-script.ts';
import { sourceTreeMatches } from '../migrator.ts';
import { type MigrationReport } from '../report.ts';
import {
  type DependencyBag,
  getCommandStartIndex,
  isPlainRecord,
  LINT_STAGED_JSON_CONFIG_FILES,
  readPackageJsonIfExists,
  RETENTION_SCAN_SKIP_DIRS,
  SHELL_STATE_COMMANDS,
  warnMigration,
} from './shared.ts';

// tsx in command position: `tsx a.ts`, `npx tsx`, `--import tsx`, `--import=tsx`,
// `-r tsx/cjs`, or inside a quoted command. Not `.tsx` files or packages such as `tsx-foo`.
const TSX_COMMAND = /(?:^|[\s;&|("'=/`])tsx(?:\/(?:esm|cjs))?(?=$|[\s;&|)"'`])/;

// Node.js options that load tsx's hooks, as in `node --import tsx ./a.ts`.
const LOADER_OPTIONS = new Set([
  '--import',
  '--loader',
  '--experimental-loader',
  '--require',
  '-r',
]);
const TSX_LOADER = /^tsx(?:\/(?:esm|cjs))?$/;

const KEEP_EVAL = '`vpx` does not run TypeScript passed to --eval or --print';
const KEEP_CHECK = '`vpx` does not transform TypeScript for -c or --check';
const KEEP_REPL = '`vpx` does not start a TypeScript REPL';
const KEEP_TEST_GLOBS =
  '`--test` without files finds `.ts` tests with tsx globs; list the test files for `vpx --test`';
const KEEP_WATCH_PATH = '`--watch-path` has no `vpx` equivalent; use `--include`';
const KEEP_SHELL =
  'the command uses shell syntax that vp migrate does not rewrite, such as pipes, variables, or subshells';
const KEEP_OTHER = 'vp migrate does not rewrite this use of tsx';
const KEEP_CWD = 'an earlier command changes the directory in a way vp migrate does not follow';

// Options that `vpx` does not run as tsx does. `-c` is Node.js' `--check`, but `vpx -c`
// is `--shell-mode`.
const KEEP_OPTIONS = new Map([
  ['-e', KEEP_EVAL],
  ['--eval', KEEP_EVAL],
  ['-p', KEEP_EVAL],
  ['--print', KEEP_EVAL],
  ['-pe', KEEP_EVAL],
  ['-c', KEEP_CHECK],
  ['--check', KEEP_CHECK],
  ['-i', KEEP_REPL],
  ['--interactive', KEEP_REPL],
  ['--watch-path', KEEP_WATCH_PATH],
]);

// A tsx shebang `vpx` can take over: `#!/usr/bin/env tsx`, `#!/usr/bin/env -S tsx --tsconfig x.json`.
const TSX_ENV_SHEBANG = /^(#!\s*\S*\benv\s+(?:-S\s+)?)(tsx(?=[ \t\r\n]|$)[^\r\n]*)/;
// Stands for the file that the kernel appends to a shebang's command.
const SHEBANG_ENTRY = './shebang.ts';
// Any first line that runs tsx, including `#!/usr/local/bin/tsx`.
const TSX_SHEBANG = /^#![^\n]*[\s/]tsx(?=\s|$)/;
// In code: an import of tsx or a subpath such as `tsx/esm/api`, a string that starts a
// tsx command, or tsx as the program of a process call, as in `spawn('tsx', [...])`.
const TSX_CODE_REFERENCE =
  /(?:\bfrom|\bimport|\brequire(?:\.resolve)?)\s*\(?\s*['"]tsx(?:\/[^'"]*)?['"]|['"`](?:npx |pnpm (?:exec )?|yarn |bunx )?tsx\s|\(\s*['"`]tsx['"`]\s*,/;
// Elsewhere (CI workflows, git hooks, shell scripts, JSON configs): tsx run with an
// argument on the same line, or loaded into Node.js.
const TSX_TEXT_REFERENCE =
  /(?:^|[\s;&|("'=/`])tsx(?:\/(?:esm|cjs))?[ \t]+\S|(?:--import|--loader|--experimental-loader|--require|-r)[= \t]+['"]?tsx(?:\/(?:esm|cjs))?(?![\w./-])/m;
const CODE_EXTENSIONS: ReadonlySet<string> = new Set(SCRIPT_EXTENSIONS);
const REFERENCE_EXTENSIONS: ReadonlySet<string> = new Set([
  ...SCRIPT_EXTENSIONS,
  '.json',
  '.yml',
  '.yaml',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.cmd',
  '.bat',
]);
// Lockfiles name tsx without running it.
const LOCKFILES = new Set([
  'bun.lock',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

// ES module syntax, and uses of the CommonJS globals an ES module does not have.
const ESM_SYNTAX = /^\s*(?:import\s*[\w*{'"]|export\s)|\bimport\.meta\b/m;
const MODULE_EXPORTS = /(?<![.\w$])(?:module\.exports|exports\.\w)/;
const COMMONJS_GLOBALS = [
  ['__dirname', /(?<![.\w$])__dirname\b/],
  ['__filename', /(?<![.\w$])__filename\b/],
  ['require', /(?<![.\w$])require\s*(?:\(|\.resolve\b)/],
] as const;
// Programs that run a command given as one quoted argument, as in
// `concurrently "tsx watch a.ts"`. Elsewhere, a quoted string is data, as for `echo`.
const COMMAND_LAUNCHERS = new Set([
  'bash',
  'concurrently',
  'nodemon',
  'server-test',
  'sh',
  'start-server-and-test',
  'zsh',
]);
// A `package.json#imports` target in tsx, such as `"#tsx": "tsx/esm/api"`.
const TSX_IMPORT_TARGET = /"tsx(?:\/[^"]*)?"/;

export interface TsxCommandRewrite {
  command: string;
  /** Why tsx stays in part of the command. */
  kept: string[];
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

interface Rewrite {
  command: string;
  /** The directory the next segment runs in; null once a command moved it out of sight. */
  cwd?: string | null;
  edits: Edit[];
  kept: string[];
}

/**
 * Rewrite the tsx invocations in a command to `vpx`: `tsx a.ts` becomes `vpx a.ts`,
 * `tsx watch a.ts` becomes `vpx --watch a.ts` (`vpx watch` runs the npm package `watch`),
 * and `node --import tsx a.ts` becomes `vpx a.ts`. Package-manager wrappers such as
 * `npx tsx` go away with tsx, since `vpx` is a bin of vite-plus. A form `vpx` cannot run
 * stays as it is, with the reason in `kept`. With `cwd`, the directory the command runs
 * in, the scripts it runs are checked for syntax `vpx` runs differently.
 */
export function rewriteTsxCommand(command: string, cwd?: string | null): TsxCommandRewrite {
  if (!TSX_COMMAND.test(command)) {
    return { command, kept: [] };
  }
  const segments = parseLiteralCommands(command, true);
  if (!segments) {
    return { command, kept: [KEEP_SHELL] };
  }
  const rewrite: Rewrite = { command, cwd, edits: [], kept: [] };
  for (const tokens of segments) {
    const [name, ...args] = tokens.map(({ value }) => value);
    if (SHELL_STATE_COMMANDS.includes(name)) {
      // Follow `cd <dir>`; after another directory change, scripts cannot be found.
      if (name === 'cd' && args.length === 1 && !/^[-~]/.test(args[0])) {
        rewrite.cwd &&= path.resolve(rewrite.cwd, args[0]);
      } else if (!['export', 'set', 'unset'].includes(name) && rewrite.cwd !== undefined) {
        rewrite.cwd = null;
      }
      continue;
    }
    rewriteSegment(rewrite, tokens);
  }
  let rewritten = command;
  for (const edit of rewrite.edits.toSorted((a, b) => b.start - a.start)) {
    rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end);
  }
  if (!rewrite.kept.length && TSX_COMMAND.test(rewritten)) {
    rewrite.kept.push(KEEP_OTHER);
  }
  return { command: rewritten, kept: rewrite.kept };
}

function rewriteSegment(rewrite: Rewrite, tokens: LiteralCommandToken[]): void {
  const values = tokens.map(({ value }) => value);
  // Environment assignments and cross-env stay in front of the command.
  let first = 0;
  const skipAssignments = () => {
    while (/^[A-Za-z_]\w*=/.test(values[first] ?? '')) {
      first++;
    }
  };
  skipAssignments();
  // cross-env-shell runs its command, given as one quoted argument, in a shell.
  const shell = values[first] === 'cross-env-shell';
  if (values[first] === 'cross-env' || shell) {
    first++;
    skipAssignments();
  }
  if (first >= values.length) {
    return;
  }
  const start = first + getCommandStartIndex(values.slice(first));
  if (values[start] === 'tsx') {
    rewriteTsx(rewrite, tokens, first, start);
  } else if (values[start] === 'node') {
    rewriteNodeLoader(rewrite, tokens, first, start);
  } else if (shell || COMMAND_LAUNCHERS.has(values[start])) {
    for (const token of tokens.slice(start)) {
      rewriteQuotedCommand(rewrite, token);
    }
  }
}

/**
 * An option's name without `=value`. Node.js reads `_` as `-` in long option names, as
 * in `--watch_path`, and so does `vpx`.
 */
function optionName(arg: string): string {
  const name = arg.split('=', 1)[0];
  return name.startsWith('--') ? `--${name.slice(2).replaceAll('_', '-')}` : name;
}

/** Remove `tokens[index]` with the space before it. */
function removal(tokens: LiteralCommandToken[], index: number): Edit {
  return { start: tokens[index - 1].end, end: tokens[index].end, text: '' };
}

/**
 * Why `vpx` would fail on a script that tsx runs, judged from its source. tsx compiles ES
 * module syntax to CommonJS in a `.cts` file and in a package without `"type": "module"`.
 * `vpx` rejects it in a `.cts` file and runs the other files as ES modules, as Node.js
 * does, so `__dirname`, `__filename`, and `require` are not defined.
 */
function scriptKeepReason(cwd: string | undefined, script: string): string | undefined {
  if (cwd === undefined || !/\.(?:c?ts|tsx|jsx?)$/.test(script)) {
    return undefined;
  }
  const file = path.resolve(cwd, script);
  let source: string;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  if (!ESM_SYNTAX.test(source)) {
    return undefined;
  }
  if (script.endsWith('.cts')) {
    return `\`${script}\` uses import or export, which \`vpx\` does not compile to CommonJS; rename it to .mts`;
  }
  if (
    usesCommonJsGlobals(source) &&
    readNearestPackageJson(path.dirname(file))?.type !== 'module'
  ) {
    return `\`${script}\` mixes import with CommonJS globals such as __dirname, require, or module.exports, and \`vpx\` runs it as an ES module; use import.meta.dirname, import.meta.filename, createRequire(), or export`;
  }
  return undefined;
}

/**
 * Whether `source` uses `module.exports`, `exports`, or a CommonJS global it does not
 * declare itself, as in `const require = createRequire(import.meta.url)`.
 */
function usesCommonJsGlobals(source: string): boolean {
  return (
    MODULE_EXPORTS.test(source) ||
    COMMONJS_GLOBALS.some(
      ([name, use]) =>
        use.test(source) && !new RegExp(`\\b(?:const|let|var|function)\\s+${name}\\b`).test(source),
    )
  );
}

/**
 * Why `vpx` cannot run what tsx or `node --import tsx` runs: `positionals` are the entry
 * and its arguments, or with `--test`, the test files.
 */
function runKeepReason(
  cwd: string | null | undefined,
  test: boolean,
  positionals: readonly string[],
): string | undefined {
  const [entry] = positionals;
  if (entry === undefined) {
    return test ? KEEP_TEST_GLOBS : KEEP_REPL;
  }
  // tsx finds `src/index.ts` for `src/index`; `vpx` reads a name without an extension as a package.
  if (!test && !SCRIPT_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
    return `\`${entry}\` has no file extension, which \`vpx\` needs to run it as a script`;
  }
  if (cwd === null) {
    return KEEP_CWD;
  }
  for (const script of test ? positionals.filter((value) => !value.startsWith('-')) : [entry]) {
    const reason = scriptKeepReason(cwd, script);
    if (reason) {
      return reason;
    }
  }
  return undefined;
}

function rewriteTsx(
  rewrite: Rewrite,
  tokens: LiteralCommandToken[],
  first: number,
  start: number,
): void {
  let index = start + 1;
  const watch = tokens[index]?.value === 'watch';
  if (watch) {
    index++;
  }
  const edits: Edit[] = [
    { start: tokens[first].start, end: tokens[index - 1].end, text: watch ? 'vpx --watch' : 'vpx' },
  ];
  let entryIndex = tokens.length;
  let test = false;
  for (; index < tokens.length; index++) {
    const { value } = tokens[index];
    if (value === '--' || !value.startsWith('-')) {
      entryIndex = value === '--' ? index + 1 : index;
      break;
    }
    const name = optionName(value);
    if (name === '--no-cache') {
      // `vpx` has no transform cache, and Node.js would reject the flag.
      edits.push(removal(tokens, index));
      continue;
    }
    const keep = KEEP_OPTIONS.get(name);
    if (keep) {
      rewrite.kept.push(keep);
      return;
    }
    test ||= name === '--test';
    if (
      !value.includes('=') &&
      (NODE_OPTIONS_WITH_VALUE.has(name) ||
        WATCH_OPTIONS_WITH_VALUE.has(name) ||
        name === '--tsconfig')
    ) {
      index++;
    }
  }
  const reason = runKeepReason(
    rewrite.cwd,
    test,
    tokens.slice(entryIndex).map(({ value }) => value),
  );
  if (reason) {
    rewrite.kept.push(reason);
    return;
  }
  rewrite.edits.push(...edits);
}

function rewriteNodeLoader(
  rewrite: Rewrite,
  tokens: LiteralCommandToken[],
  first: number,
  start: number,
): void {
  const loaders: Edit[] = [];
  let entryIndex = tokens.length;
  let optionReason: string | undefined;
  let test = false;
  for (let index = start + 1; index < tokens.length; index++) {
    const { value } = tokens[index];
    if (value === '--' || !value.startsWith('-')) {
      entryIndex = value === '--' ? index + 1 : index;
      break;
    }
    const name = optionName(value);
    const inline = value.includes('=');
    if (LOADER_OPTIONS.has(name)) {
      const loader = inline ? value.slice(value.indexOf('=') + 1) : tokens[index + 1]?.value;
      if (loader !== undefined && TSX_LOADER.test(loader)) {
        loaders.push({ ...removal(tokens, index), end: tokens[inline ? index : index + 1].end });
      }
      if (!inline) {
        index++;
      }
      continue;
    }
    optionReason ??= KEEP_OPTIONS.get(name);
    test ||= name === '--test';
    if (!inline && NODE_OPTIONS_WITH_VALUE.has(name)) {
      index++;
    }
  }
  if (!loaders.length) {
    return;
  }
  const reason =
    optionReason ??
    runKeepReason(
      rewrite.cwd,
      test,
      tokens.slice(entryIndex).map(({ value }) => value),
    );
  if (reason) {
    rewrite.kept.push(reason);
    return;
  }
  rewrite.edits.push(
    { start: tokens[first].start, end: tokens[start].end, text: 'vpx' },
    ...loaders,
  );
}

function rewriteQuotedCommand(rewrite: Rewrite, token: LiteralCommandToken): void {
  const raw = rewrite.command.slice(token.start, token.end);
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'") || raw.length < 2 || !raw.endsWith(quote)) {
    return;
  }
  const inner = rewriteTsxCommand(token.value, rewrite.cwd);
  rewrite.kept.push(...inner.kept);
  if (inner.command !== token.value && !inner.command.includes(quote)) {
    rewrite.edits.push({
      start: token.start,
      end: token.end,
      text: `${quote}${inner.command}${quote}`,
    });
  }
}

/** The commands in a scripts or lint-staged record. */
function recordCommands(record: unknown): string[] {
  if (!isPlainRecord(record)) {
    return [];
  }
  return Object.values(record)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((command): command is string => typeof command === 'string');
}

/** The commands a package.json runs: its scripts and lint-staged tasks. */
function packageCommands(pkg: Record<string, unknown>): string[] {
  return [...recordCommands(pkg.scripts), ...recordCommands(pkg['lint-staged'])];
}

function lintStagedJsonFiles(dir: string): string[] {
  return LINT_STAGED_JSON_CONFIG_FILES.map((name) => path.join(dir, name)).filter(
    (file) => fs.existsSync(file) && isJsonFile(file),
  );
}

/**
 * A package that lists tsx outside devDependencies keeps it: its published code or
 * production scripts can need tsx, and `vpx` comes from the vite-plus devDependency.
 */
function ownsTsxAtRuntime(pkg: DependencyBag): boolean {
  return (
    pkg.dependencies?.tsx !== undefined ||
    pkg.optionalDependencies?.tsx !== undefined ||
    pkg.peerDependencies?.tsx !== undefined
  );
}

function packageDirs(rootDir: string, packages?: readonly WorkspacePackage[]): string[] {
  return [rootDir, ...(packages ?? []).map((pkg) => path.join(rootDir, pkg.path))];
}

/** Whether a script or lint-staged task runs tsx in a form `vpx` replaces. */
export function detectTsxProject(rootDir: string, packages?: readonly WorkspacePackage[]): boolean {
  return packageDirs(rootDir, packages).some((dir) => {
    const pkg = readPackageJsonIfExists(path.join(dir, 'package.json'));
    if (!pkg || ownsTsxAtRuntime(pkg)) {
      return false;
    }
    const commands = [
      ...packageCommands(pkg),
      ...lintStagedJsonFiles(dir).flatMap((file) => recordCommands(readJsonFile(file))),
    ];
    return commands.some((command) => rewriteTsxCommand(command, dir).command !== command);
  });
}

/** Rewrite each command of a scripts or lint-staged record; returns whether one changed. */
function rewriteCommandRecord(
  record: Record<string, unknown>,
  label: string,
  cwd: string,
  report?: MigrationReport,
): boolean {
  let edited = false;
  for (const [key, value] of Object.entries(record)) {
    const commands: unknown[] = Array.isArray(value) ? value : [value];
    const rewritten = commands.map((command) => {
      if (typeof command !== 'string') {
        return command;
      }
      const result = rewriteTsxCommand(command, cwd);
      for (const reason of result.kept) {
        warnMigration(`Kept tsx in ${label} "${key}": ${reason}.`, report);
      }
      return result.command;
    });
    if (rewritten.some((command, index) => command !== commands[index])) {
      record[key] = Array.isArray(value) ? rewritten : rewritten[0];
      edited = true;
    }
  }
  return edited;
}

/** Point `#!/usr/bin/env tsx` shebangs of a package's script files at `vpx`. */
function rewriteTsxShebangs(dir: string, report?: MigrationReport): boolean {
  let changed = false;
  // The callback never reports a match, so the walk visits every file.
  sourceTreeMatches(dir, (content, file) => {
    const match = TSX_ENV_SHEBANG.exec(content);
    if (!match) {
      return false;
    }
    const [line, prefix, command] = match;
    // The kernel runs the shebang's command with the file appended.
    const result = rewriteTsxCommand(`${command.trimEnd()} ${SHEBANG_ENTRY}`);
    const reason =
      result.kept[0] ?? scriptKeepReason(path.dirname(file), `./${path.basename(file)}`);
    if (reason) {
      warnMigration(`Kept tsx in the shebang of ${displayRelative(file)}: ${reason}.`, report);
      return false;
    }
    const vpxCommand = result.command.slice(0, -` ${SHEBANG_ENTRY}`.length);
    fs.writeFileSync(file, `${prefix}${vpxCommand}${content.slice(line.length)}`);
    changed = true;
    return false;
  });
  return changed;
}

/**
 * What still runs or imports tsx under `dir`, or undefined. The scan crosses into nested
 * packages, which can resolve this package's tsx, and reads build output, which can
 * still load it.
 */
function findTsxUse(dir: string): string | undefined {
  let found: string | undefined;
  sourceTreeMatches(
    dir,
    (content, file) => {
      if (
        LOCKFILES.has(path.basename(file)) ||
        !(
          TSX_SHEBANG.test(content) ||
          (CODE_EXTENSIONS.has(path.extname(file)) ? TSX_CODE_REFERENCE : TSX_TEXT_REFERENCE).test(
            content,
          )
        )
      ) {
        return false;
      }
      found = `${displayRelative(file)} still uses tsx`;
      return true;
    },
    {
      crossPackageBoundaries: true,
      extensions: REFERENCE_EXTENSIONS,
      includeExtensionless: true,
      includePackageReferences: true,
      matchesPackage: (packageDir, pkg) => {
        const file = displayRelative(path.join(packageDir, 'package.json'));
        if (packageCommands(pkg).some((c) => TSX_COMMAND.test(c))) {
          found = `scripts in ${file} still run tsx`;
        } else if (
          TSX_IMPORT_TARGET.test(JSON.stringify((pkg as { imports?: unknown }).imports ?? null))
        ) {
          found = `imports in ${file} still map to tsx`;
        }
        return found !== undefined;
      },
      skipDirs: RETENTION_SCAN_SKIP_DIRS,
    },
  );
  return found;
}

/**
 * Move tsx scripts to `vpx`: rewrite package.json scripts, lint-staged tasks, and
 * `#!/usr/bin/env tsx` shebangs, then remove the tsx devDependency from each package
 * where nothing uses tsx anymore.
 */
export function migrateTsxToVpx(
  rootDir: string,
  packages?: readonly WorkspacePackage[],
  report?: MigrationReport,
): { changed: boolean; dependencyRemoved: boolean } {
  let changed = false;
  const migrated: string[] = [];
  for (const dir of packageDirs(rootDir, packages)) {
    const packageJsonPath = path.join(dir, 'package.json');
    const pkg = readPackageJsonIfExists(packageJsonPath);
    if (!pkg) {
      continue;
    }
    if (ownsTsxAtRuntime(pkg)) {
      if (packageCommands(pkg).some((c) => TSX_COMMAND.test(c))) {
        warnMigration(
          `Kept tsx in ${displayRelative(packageJsonPath)}: it is listed in dependencies, optionalDependencies, or peerDependencies there, and \`vpx\` comes from the vite-plus devDependency.`,
          report,
        );
      }
      continue;
    }
    migrated.push(dir);
    editJsonFile(packageJsonPath, (json) => {
      let edited = false;
      for (const field of ['scripts', 'lint-staged']) {
        const record = json[field];
        if (
          isPlainRecord(record) &&
          rewriteCommandRecord(record, `${displayRelative(packageJsonPath)} ${field}`, dir, report)
        ) {
          edited = true;
        }
      }
      changed ||= edited;
      return edited ? json : undefined;
    });
    for (const file of lintStagedJsonFiles(dir)) {
      editJsonFile(file, (config) => {
        const edited = rewriteCommandRecord(config, displayRelative(file), dir, report);
        changed ||= edited;
        return edited ? config : undefined;
      });
    }
    if (rewriteTsxShebangs(dir, report)) {
      changed = true;
    }
  }

  // Remove the dependency once every package is rewritten: the root's tsx can serve
  // any package, so its scan covers the whole workspace.
  let dependencyRemoved = false;
  for (const dir of migrated) {
    const packageJsonPath = path.join(dir, 'package.json');
    if (readPackageJsonIfExists(packageJsonPath)?.devDependencies?.tsx === undefined) {
      continue;
    }
    const use = findTsxUse(dir);
    if (use) {
      warnMigration(
        `Kept the tsx devDependency in ${displayRelative(packageJsonPath)}: ${use}.`,
        report,
      );
      continue;
    }
    editJsonFile<DependencyBag>(packageJsonPath, (json) => {
      delete json.devDependencies!.tsx;
      return json;
    });
    dependencyRemoved = true;
  }
  if (report && changed) {
    report.tsxMigrated = true;
  }
  return { changed: changed || dependencyRemoved, dependencyRemoved };
}

export async function confirmTsxMigration(interactive: boolean): Promise<boolean> {
  if (interactive) {
    const confirmed = await prompts.confirm({
      message:
        'Migrate tsx scripts to vpx?\n  ' +
        styleText(
          'gray',
          "vpx is Vite+'s built-in TypeScript script runner: `tsx <file>` becomes `vpx <file>`, `tsx watch` becomes `vpx --watch`, and the tsx dependency is removed once nothing uses it.",
        ),
      initialValue: true,
    });
    if (prompts.isCancel(confirmed)) {
      cancelAndExit();
    }
    return confirmed;
  }
  prompts.log.info('tsx scripts detected. Auto-migrating to vpx...');
  return true;
}
