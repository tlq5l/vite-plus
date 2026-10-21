# command_run_pnpm_verify_deps

## `vpt stat-file node_modules`

dependencies are not installed yet

```
node_modules: missing
```

## `vp run check`

pnpm's verifyDepsBeforeRun installs the missing dependencies, then the script runs

```
VITE+ - The Unified Toolchain for the Web

dependencies:
 testnpm2 1.0.0

Done in <duration> using pnpm <version>
$ node -e "console.log(require('testnpm2/package.json').name)" ⊘ cache disabled
testnpm2
```
