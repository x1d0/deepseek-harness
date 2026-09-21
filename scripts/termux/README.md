# Termux 部署件

本目录承载在 Termux 上恢复 dsh 部署所需、但不在常规源码树里的产物。

## `dsh` — 启动器

目标位置：`/data/data/com.termux/files/usr/bin/dsh`（需 `chmod +x`）。内容：

```bash
export CI=true
DSH_REPO=/data/data/com.termux/files/home/build/deepseek-harness
exec node --expose-internals \
  --import "$DSH_REPO/node_modules/tsx/dist/esm/index.mjs" \
  "$DSH_REPO/apps/cli/src/bin.ts" "$@"
```

`--expose-internals` 是必需项：`node-addon-require-builtin` 没有 android-arm64 预编译产物，profile 解析必须经
`packages/boot/app-boot/src/profile-resolution/resolver.ts` 的 `require` 分支取 Node internal。

## `native/system/prebuilds/android-arm64/system.node`

flock 的原生 binding（bionic 编译，11504 字节）。`native/system/.gitignore` 忽略 `prebuilds/`，本仓库以
`git add -f` 显式纳管。重建：

```bash
clang -shared -fPIC native/system/packages/entry/src/flock.c \
  -I$PREFIX/include/node -o native/system/prebuilds/android-arm64/system.node
```

## 未纳入仓库

`~/.dsh/profiles/{sdk,web,headless}`、`~/.dsh/settings.yaml`、`~/.dsh/storages`、`~/.config/xi/config.toml`、
`~/.venvs/xi-probe` 都是本机状态，需单独备份。
