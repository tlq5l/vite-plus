import fs from 'node:fs';
import path from 'node:path';
import { styleText } from 'node:util';

import * as prompts from '@voidzero-dev/vite-plus-prompts';

import { type LiteralCommandToken, parseLiteralCommands } from '../../../binding/index.js';
import { type WorkspacePackage } from '../../types/index.ts';
import { editJsonFile, isJsonFile } from '../../utils/json.ts';
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
const EVAL_OPTIONS = new Set(['-e', '--eval', '-p', '--print', '-pe']);

const KEEP_EVAL = '`vpx` does not run TypeScript passed to --eval or --print';
const KEEP_REPL = '`vpx` does not start a TypeScript REPL';
const KEEP_TEST_GLOBS =
  '`--test` without files finds `.ts` tests with tsx globs; list the test files for `vpx --test`';
const KEEP_WATCH_PATH = '`--watch-path` has no `vpx` equivalent; use `--include`';
const KEEP_SHELL =
  'the command uses shell syntax that vp migrate does not rewrite, such as pipes, variables, or subshells';
const KEEP_OTHER = 'vp migrate does not rewrite this use of tsx';

// A tsx shebang that `vpx` can take over: `#!/usr/bin/env tsx`, `#!/usr/bin/env -S tsx --tsconfig x.json`.
const TSX_ENV_SHEBANG = /^(#!\s*\S*\benv\s+(?:-S\s+)?)tsx(?=\s|$)/;
// Any first line that runs tsx, including `#!/usr/local/bin/tsx`.
const TSX_SHEBANG = /^#![^\n]*[\s/]tsx(?=\s|$)/;
// In code: an import of tsx or a subpath such as `tsx/esm/api`, or a string that starts a tsx command.
const TSX_CODE_REFERENCE =
  /(?:\bfrom|\bimport|\brequire(?:\.resolve)?)\s*\(?\s*['"]tsx(?:\/[^'"]*)?['"]|['"`](?:npx |pnpm (?:exec )?|yarn |bunx )?tsx\s/;
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
]);
// Lockfiles name tsx without running it.
const LOCKFILES = new Set([
  'bun.lock',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

// ES module syntax, and the CommonJS globals an ES module does not have.
const ESM_SYNTAX = /^\s*(?:import\s*[\w*{'"]|export\s)|\bimport\.meta\b/m;
const COMMONJS_GLOBALS = /\b(?:__dirname|__filename)\b|\brequire\s*\(/;

export interface TsxCommandRewrite {
  command: string;
  /** The scripts the rewritten command runs, as written. */
  entries: string[];
  /** Why tsx stays in part of the command. */
  kept: string[];
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/**
 * Rewrite the tsx invocations in a command to `vpx`: `tsx a.ts` becomes `vpx a.ts`,
 * `tsx watch a.ts` becomes `vpx --watch a.ts` (`vpx watch` runs the npm package `watch`),
 * and `node --import tsx a.ts` becomes `vpx a.ts`. Package-manager wrappers such as
 * `npx tsx` go away with tsx, since `vpx` is a bin of vite-plus. A form `vpx` cannot run
 * stays as it is, with the reason in `kept`.
 */
export function rewriteTsxCommand(command: string): TsxCommandRewrite {
  const result: TsxCommandRewrite = { command, entries: [], kept: [] };
  if (!TSX_COMMAND.test(command)) {
    return result;
  }
  const segments = parseLiteralCommands(command, true);
  if (!segments) {
    result.kept.push(KEEP_SHELL);
    return result;
  }
  const edits: Edit[] = [];
  for (const tokens of segments) {
    rewriteSegment(command, tokens, edits, result);
  }
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    result.command =
      result.command.slice(0, edit.start) + edit.text + result.command.slice(edit.end);
  }
  if (!result.kept.length && TSX_COMMAND.test(result.command)) {
    result.kept.push(KEEP_OTHER);
  }
  return result;
}

function rewriteSegment(
  command: string,
  tokens: LiteralCommandToken[],
  edits: Edit[],
  result: TsxCommandRewrite,
): void {
  const values = tokens.map(({ value }) => value);
  // Environment assignments and cross-env stay in front of the command.
  let first = 0;
  const skipAssignments = () => {
    while (/^[A-Za-z_]\w*=/.test(values[first] ?? '')) {
      first++;
    }
  };
  skipAssignments();
  if (values[first] === 'cross-env' || values[first] === 'cross-env-shell') {
    first++;
    skipAssignments();
  }
  if (first >= values.length) {
    return;
  }
  const start = first + getCommandStartIndex(values.slice(first));
  if (values[start] === 'tsx') {
    rewriteTsx(tokens, first, start, edits, result);
  } else if (values[start] === 'node') {
    rewriteNodeLoader(tokens, first, start, edits, result);
  } else {
    // A command another tool runs, given as one quoted argument: `concurrently "tsx watch a.ts"`.
    for (const token of tokens.slice(start)) {
      rewriteQuotedCommand(command, token, edits, result);
    }
  }
}

/** Remove `tokens[index]` with the space before it. */
function removal(tokens: LiteralCommandToken[], index: number): Edit {
  return { start: tokens[index - 1].end, end: tokens[index].end, text: '' };
}

function hasScriptExtension(entry: string): boolean {
  return SCRIPT_EXTENSIONS.some((extension) => entry.endsWith(extension));
}

/** The reason to keep a run of `entry`, or undefined when `vpx` runs it. */
function entryKeepReason(entry: string | undefined, test: boolean): string | undefined {
  if (entry === undefined) {
    return test ? KEEP_TEST_GLOBS : KEEP_REPL;
  }
  // tsx finds `src/index.ts` for `src/index`; `vpx` reads a name without an extension as a package.
  if (!test && !hasScriptExtension(entry)) {
    return `\`${entry}\` has no file extension, which \`vpx\` needs to run it as a script`;
  }
  return undefined;
}

function rewriteTsx(
  tokens: LiteralCommandToken[],
  first: number,
  start: number,
  edits: Edit[],
  result: TsxCommandRewrite,
): void {
  let index = start + 1;
  const watch = tokens[index]?.value === 'watch';
  if (watch) {
    index++;
  }
  const local: Edit[] = [
    { start: tokens[first].start, end: tokens[index - 1].end, text: watch ? 'vpx --watch' : 'vpx' },
  ];
  let entry: string | undefined;
  let test = false;
  for (; index < tokens.length; index++) {
    const { value } = tokens[index];
    if (value === '--' || !value.startsWith('-')) {
      entry = value === '--' ? tokens[index + 1]?.value : value;
      break;
    }
    const name = value.split('=', 1)[0];
    if (name === '--no-cache') {
      // `vpx` has no transform cache, and Node.js would reject the flag.
      local.push(removal(tokens, index));
      continue;
    }
    if (EVAL_OPTIONS.has(name)) {
      result.kept.push(KEEP_EVAL);
      return;
    }
    if (name === '-i' || name === '--interactive') {
      result.kept.push(KEEP_REPL);
      return;
    }
    if (name === '--watch-path') {
      result.kept.push(KEEP_WATCH_PATH);
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
  const reason = entryKeepReason(entry, test);
  if (reason) {
    result.kept.push(reason);
    return;
  }
  edits.push(...local);
  if (!test) {
    result.entries.push(entry!);
  }
}

function rewriteNodeLoader(
  tokens: LiteralCommandToken[],
  first: number,
  start: number,
  edits: Edit[],
  result: TsxCommandRewrite,
): void {
  const loaders: Edit[] = [];
  let entry: string | undefined;
  let evaluates = false;
  let test = false;
  for (let index = start + 1; index < tokens.length; index++) {
    const { value } = tokens[index];
    if (value === '--' || !value.startsWith('-')) {
      entry = value === '--' ? tokens[index + 1]?.value : value;
      break;
    }
    const name = value.split('=', 1)[0];
    const inline = value.includes('=');
    if (LOADER_OPTIONS.has(name)) {
      const loader = inline ? value.slice(name.length + 1) : tokens[index + 1]?.value;
      if (loader !== undefined && TSX_LOADER.test(loader)) {
        loaders.push({ ...removal(tokens, index), end: tokens[inline ? index : index + 1].end });
      }
      if (!inline) {
        index++;
      }
      continue;
    }
    evaluates ||= EVAL_OPTIONS.has(name);
    test ||= name === '--test';
    if (!inline && NODE_OPTIONS_WITH_VALUE.has(name)) {
      index++;
    }
  }
  if (!loaders.length) {
    return;
  }
  const reason = evaluates ? KEEP_EVAL : entryKeepReason(entry, test);
  if (reason) {
    result.kept.push(reason);
    return;
  }
  edits.push({ start: tokens[first].start, end: tokens[start].end, text: 'vpx' }, ...loaders);
  if (!test) {
    result.entries.push(entry!);
  }
}

function rewriteQuotedCommand(
  command: string,
  token: LiteralCommandToken,
  edits: Edit[],
  result: TsxCommandRewrite,
): void {
  const raw = command.slice(token.start, token.end);
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'") || raw.length < 2 || !raw.endsWith(quote)) {
    return;
  }
  const inner = rewriteTsxCommand(token.value);
  result.kept.push(...inner.kept);
  if (inner.command === token.value || inner.command.includes(quote)) {
    return;
  }
  result.entries.push(...inner.entries);
  edits.push({ start: token.start, end: token.end, text: `${quote}${inner.command}${quote}` });
}

/** The commands a package.json runs: its scripts and lint-staged tasks. */
function packageCommands(pkg: Record<string, unknown>): string[] {
  const commands: string[] = [];
  for (const field of ['scripts', 'lint-staged']) {
    const record = pkg[field];
    if (!isPlainRecord(record)) {
      continue;
    }
    for (const value of Object.values(record)) {
      for (const command of Array.isArray(value) ? value : [value]) {
        if (typeof command === 'string') {
          commands.push(command);
        }
      }
    }
  }
  return commands;
}

/**
 * A package that ships tsx as a dependency or peer dependency keeps it: its published
 * code or production scripts can need tsx, and `vpx` comes from a devDependency.
 */
function ownsTsxAtRuntime(pkg: DependencyBag): boolean {
  return pkg.dependencies?.tsx !== undefined || pkg.peerDependencies?.tsx !== undefined;
}

function packageDirs(rootDir: string, packages?: readonly WorkspacePackage[]): string[] {
  return [rootDir, ...(packages ?? []).map((pkg) => path.join(rootDir, pkg.path))];
}

/** Whether a package.json script or lint-staged task runs tsx in a form `vpx` replaces. */
export function detectTsxProject(rootDir: string, packages?: readonly WorkspacePackage[]): boolean {
  return packageDirs(rootDir, packages).some((dir) => {
    const pkg = readPackageJsonIfExists(path.join(dir, 'package.json'));
    return (
      pkg !== undefined &&
      !ownsTsxAtRuntime(pkg) &&
      packageCommands(pkg).some((command) => rewriteTsxCommand(command).command !== command)
    );
  });
}

/** Rewrite each command of a scripts or lint-staged record; returns whether one changed. */
function rewriteCommandRecord(
  record: Record<string, unknown>,
  label: string,
  entries: string[],
  report?: MigrationReport,
): boolean {
  let edited = false;
  for (const [key, value] of Object.entries(record)) {
    const commands: unknown[] = Array.isArray(value) ? value : [value];
    const rewritten = commands.map((command) => {
      if (typeof command !== 'string') {
        return command;
      }
      const result = rewriteTsxCommand(command);
      entries.push(...result.entries);
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
function rewriteTsxShebangs(dir: string): string[] {
  const files: string[] = [];
  // The callback never reports a match, so the walk visits every file.
  sourceTreeMatches(dir, (content, file) => {
    if (TSX_ENV_SHEBANG.test(content)) {
      fs.writeFileSync(file, content.replace(TSX_ENV_SHEBANG, '$1vpx'));
      files.push(file);
    }
    return false;
  });
  return files;
}

/**
 * The first file under `dir` that still runs or imports tsx, or undefined. For the
 * workspace root, the scan crosses into packages, which can use the root's tsx.
 */
function findTsxReference(dir: string, crossPackageBoundaries: boolean): string | undefined {
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
      found = file;
      return true;
    },
    {
      crossPackageBoundaries,
      extensions: REFERENCE_EXTENSIONS,
      includeExtensionless: true,
      includePackageReferences: true,
      matchesPackage: (packageDir, pkg) => {
        if (!packageCommands(pkg).some((c) => TSX_COMMAND.test(c))) {
          return false;
        }
        found = path.join(packageDir, 'package.json');
        return true;
      },
    },
  );
  return found;
}

/**
 * tsx runs a file with ES module syntax as CommonJS in a package without
 * `"type": "module"`; `vpx`, like Node.js, runs it as an ES module, which has no
 * `__dirname`, `__filename`, or `require`. Check the scripts the commands now run.
 */
function warnCommonJsEntries(dir: string, entries: readonly string[], report?: MigrationReport) {
  const pkg = readPackageJsonIfExists(path.join(dir, 'package.json')) as
    | { type?: unknown }
    | undefined;
  if (pkg?.type === 'module') {
    return;
  }
  for (const entry of new Set(entries)) {
    if (!/\.(?:ts|tsx|js|jsx)$/.test(entry)) {
      continue;
    }
    const file = path.resolve(dir, entry);
    let source: string;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (ESM_SYNTAX.test(source) && COMMONJS_GLOBALS.test(source)) {
      warnMigration(
        `${displayRelative(file)} uses ES module syntax with __dirname, __filename, or require() in a package without "type": "module". tsx ran it as CommonJS, and vpx runs it as an ES module, as Node.js does; use import.meta.dirname, import.meta.filename, or createRequire().`,
        report,
      );
    }
  }
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
          `Kept tsx in ${displayRelative(packageJsonPath)}: it is a dependency or peer dependency there, and \`vpx\` comes from the vite-plus devDependency.`,
          report,
        );
      }
      continue;
    }
    migrated.push(dir);
    const entries: string[] = [];
    editJsonFile(packageJsonPath, (json) => {
      let edited = false;
      for (const field of ['scripts', 'lint-staged']) {
        const record = json[field];
        if (
          isPlainRecord(record) &&
          rewriteCommandRecord(
            record,
            `${displayRelative(packageJsonPath)} ${field}`,
            entries,
            report,
          )
        ) {
          edited = true;
        }
      }
      changed ||= edited;
      return edited ? json : undefined;
    });
    for (const name of LINT_STAGED_JSON_CONFIG_FILES) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file) || !isJsonFile(file)) {
        continue;
      }
      editJsonFile(file, (config) => {
        const edited = rewriteCommandRecord(config, displayRelative(file), entries, report);
        changed ||= edited;
        return edited ? config : undefined;
      });
    }
    for (const file of rewriteTsxShebangs(dir)) {
      entries.push(path.relative(dir, file));
      changed = true;
    }
    warnCommonJsEntries(dir, entries, report);
  }

  // Remove the dependency once every package is rewritten: the root's tsx can serve
  // any package, so its scan covers the whole workspace.
  let dependencyRemoved = false;
  for (const dir of migrated) {
    const packageJsonPath = path.join(dir, 'package.json');
    if (readPackageJsonIfExists(packageJsonPath)?.devDependencies?.tsx === undefined) {
      continue;
    }
    const reference = findTsxReference(dir, dir === rootDir);
    if (reference) {
      const user =
        path.basename(reference) === 'package.json'
          ? `scripts in ${displayRelative(reference)} still run tsx`
          : `${displayRelative(reference)} still uses tsx`;
      warnMigration(
        `Kept the tsx devDependency in ${displayRelative(packageJsonPath)}: ${user}.`,
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
