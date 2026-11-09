<!-- HYPRGATE NAPPLET MIRROR NOTICE:START -->
> This repository is a read-only mirror of the `creator-signals` napplet from `hyprgate/gui`.
> Open issues and pull requests in https://github.com/hyprgate/gui.
> Do not push commits to this standalone napplet repository; direct changes are overwritten by Hyprgate's mirror workflow.
<!-- HYPRGATE NAPPLET MIRROR NOTICE:END -->

# Creator Signals

See the replies, comments, reactions, reposts and zaps on your recent notes and
articles, plus who follows you. Counts are what your relays returned over the last
30 days, so read them as coverage rather than global totals.

The source lives in the Hyprgate monorepo at `napplets/creator-signals`. The standalone
`hyprgate/napplet-creator-signals` repository is a generated, read-only mirror, so send
changes to [hyprgate/web](https://github.com/hyprgate/web).

## Developing

Run these from the root of a Hyprgate checkout so workspace dependencies resolve:

```bash
pnpm install --frozen-lockfile
pnpm --filter ./napplets/creator-signals paja        # Kehto Paja plus the Vite dev server
pnpm --filter ./napplets/creator-signals test
pnpm --filter ./napplets/creator-signals type-check
pnpm --filter ./napplets/creator-signals conformance # builds, then checks dist/
```
