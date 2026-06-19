# napplet-creator-signals

[![CI](https://github.com/hyprgate/napplet-creator-signals/actions/workflows/ci.yml/badge.svg)](https://github.com/hyprgate/napplet-creator-signals/actions/workflows/ci.yml)

Forkable source repository for the Hyprgate built-in napplet currently packaged as `@hyprgate/napp-creator-signals`.

This repository was split from `hyprgate/gui` and is mounted back into the parent checkout as `napplets/creator-signals`.
It still expects the parent workspace when built through Hyprgate because shared `@hyprgate/*` packages remain workspace dependencies.

## Parent checkout

```bash
git clone --recurse-submodules git@github.com:hyprgate/gui.git
cd gui
pnpm install --frozen-lockfile
pnpm --filter @hyprgate/napp-creator-signals build
```

## Testing

Run these checks from a Hyprgate parent checkout so workspace dependencies resolve:

```bash
git clone --recurse-submodules git@github.com:hyprgate/gui.git
cd gui
pnpm install --frozen-lockfile
pnpm --filter @hyprgate/napp-creator-signals conformance
pnpm --filter @hyprgate/napp-creator-signals test
pnpm --filter @hyprgate/napp-creator-signals build
```

The `conformance` script builds the napplet and runs `@napplet/conformance-cli` against `dist/`. CI runs the same conformance, unit test, and build checks for every push and pull request.
