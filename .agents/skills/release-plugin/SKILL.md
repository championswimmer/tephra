---
name: release-plugin
description: Publish a new Tephra Sync plugin release (version bump, tag, GitHub release with main.js and manifest.json) so BRAT and manual installs get it. Use when the user says "release plugin" or asks to ship, publish, or cut a plugin release.
---

# Release the Tephra Sync plugin

Releases are built by `.github/workflows/release-plugin.yml` when a version tag is pushed. The tag must equal `tephra-plugin/manifest.json` `version` exactly (no `v` prefix). BRAT and manual installs download `main.js` and `manifest.json` from the release, so never ask users to build.

## Steps

1. Confirm the working tree is clean and on `main` (`git status`, `git branch --show-current`). Run `git pull --ff-only`.
2. Choose the next version. Default to a patch bump of the current `tephra-plugin/manifest.json` version; use the bump (or `x.y.z-beta.N` for a pre-release) the user names. Check the tag does not exist: `git tag -l <version>`.
3. Set the version in `tephra-plugin/manifest.json` and `tephra-plugin/package.json`, and add `"<version>": "<minAppVersion>"` to `tephra-plugin/versions.json`.
4. Run `npm run check`. Stop on failure.
5. Commit (`Release plugin <version>`), push `main`, then tag and push:
   ```sh
   git tag <version> && git push origin <version>
   ```
6. Watch the run: `gh run list --workflow=release-plugin.yml --limit 1` until it completes (poll, don't sleep in a chain).
7. Verify: `gh release view <version> --json assets,tagName,isPrerelease`. It must list `main.js` and `manifest.json`.
8. Report the release URL and version. If the workflow failed, show `gh run view --log-failed` output; do not delete or move published tags without asking.

Pushing to `main` and pushing a tag are outward-facing: if the user did not say "release plugin" (or equivalent) in this session, confirm first.
