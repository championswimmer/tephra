# Install the Tephra Sync plugin with BRAT

[BRAT](https://github.com/TfTHacker/obsidian42-brat) (Beta Reviewers Auto-update Tool) installs Obsidian plugins straight from a GitHub repo and keeps them updated. It works on desktop and mobile, so it is the easiest way to get Tephra Sync onto a phone.

## Install

1. In Obsidian, open **Settings → Community plugins**, turn off **Restricted mode**, then **Browse**, search for **Obsidian42 - BRAT**, and install and enable it.
2. Open the command palette and run **BRAT: Plugins: Add a beta plugin for testing**.
3. Paste `championswimmer/tephra` (or the full `https://github.com/championswimmer/tephra` URL) and click **Add Plugin**.
4. Go to **Settings → Community plugins**, refresh the list, and enable **Tephra Sync**.

Then continue with plugin settings in the [Getting Started guide](GETTING_STARTED.md#step-5--connect-the-plugin-to-your-server).

## Updates

BRAT checks for new releases when Obsidian starts if **Auto-update plugins at startup** is on (BRAT settings). To update on demand, run **BRAT: Check for updates to all beta plugins and UPDATE**.

To pin a version, use **BRAT: Plugins: Add a beta plugin with frozen version based on a release tag** and enter a tag such as `0.2.0`. Frozen plugins are skipped by updates.

## How it works

BRAT does not read the repo's files. It downloads `manifest.json` and `main.js` from the **latest GitHub release** of the repo. The plugin lives in `tephra-plugin/`, so a release workflow builds it and attaches those two files. If a repo has no release, BRAT cannot install from it.

## Publishing a release (maintainers)

Ask the agent to "release plugin" (see the `release-plugin` skill), or do it by hand:

[`.github/workflows/release-plugin.yml`](../.github/workflows/release-plugin.yml) runs when a version tag is pushed.

1. Set the same version in `tephra-plugin/manifest.json` and `tephra-plugin/package.json`, and commit it.
2. Tag and push. The tag must equal the manifest version, with no `v` prefix (Obsidian and BRAT compare them):

   ```sh
   git tag 0.2.0
   git push origin 0.2.0
   ```

3. The workflow fails if the tag and manifest version differ, builds the plugin, and creates the release with `main.js` and `manifest.json`. Tags with a suffix such as `0.3.0-beta.1` are marked pre-release; BRAT installs them as the latest, while Obsidian's own updater ignores them.

## Troubleshooting

| Symptom                                               | Fix                                                                                                         |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| BRAT says it cannot find `manifest.json` or a release | The repo has no release yet, or the release is missing its assets. Check the repo's Releases page.          |
| Plugin does not appear after adding                   | Refresh the Community plugins list, or restart Obsidian.                                                    |
| Version mismatch notice                               | The release tag and `manifest.json` version differ; BRAT trusts the tag. Re-release with matching versions. |
| Private fork                                          | BRAT needs a GitHub personal access token (BRAT settings) to read private repos.                            |
