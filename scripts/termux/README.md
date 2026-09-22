# Termux deployment artifacts

English | [中文](README.zh.md)

This directory carries what a Termux deployment of dsh needs to be restored but does not live in the
ordinary source tree.

## `dsh` — launcher

Target location: `$PREFIX/bin/dsh` (Termux's `PREFIX`, usually `/data/data/com.termux/files/usr`;
requires `chmod +x`). Contents:

```bash
export CI=true
DSH_REPO="${DSH_REPO:-$HOME/build/deepseek-harness}"
exec node --expose-internals \
  --import "$DSH_REPO/node_modules/tsx/dist/esm/index.mjs" \
  "$DSH_REPO/apps/cli/src/bin.ts" "$@"
```

`DSH_REPO` defaults to `$HOME/build/deepseek-harness`; when the checkout lives elsewhere, override it
with the environment variable.

`--expose-internals` is required: `node-addon-require-builtin` has no android-arm64 prebuilt, so
profile resolution must reach the Node internal through the `require` branch of
`packages/boot/app-boot/src/profile-resolution/resolver.ts`.

## `native/system/prebuilds/android-arm64/system.node`

The flock native binding (bionic build, 11504 bytes). `native/system/.gitignore` ignores
`prebuilds/`; this repository tracks the file explicitly with `git add -f`. To rebuild:

```bash
clang -shared -fPIC native/system/packages/entry/src/flock.c \
  -I$PREFIX/include/node -o native/system/prebuilds/android-arm64/system.node
```

## Not tracked here

`~/.dsh/profiles/{sdk,web,headless}`, `~/.dsh/settings.yaml`, `~/.dsh/storages`,
`~/.config/xi/config.toml` and `~/.venvs/xi-probe` are machine-local state and need a separate backup.
