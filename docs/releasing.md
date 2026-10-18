# Releasing

Releases are Bun source archives for Linux, including the CLI, installers,
Omarchy plugin, documentation, and tests. Bun remains a runtime requirement.
The package is private to prevent accidental npm publication; GitHub releases
are the distribution channel.

## Prepare and verify

1. Update `version` in `package.json` and `omarchy/manifest.json` together. The CLI
   and app-server client read the package version automatically.
2. Add the release's `## VERSION` section to `CHANGELOG.md`. Verify any changed
   model prices against official sources and update their verification date.
3. Run:

   ```sh
   bun install --frozen-lockfile
   bun run verify
   bun run release:pack
   ```

4. If the plugin changed, run `omarchy plugin validate omarchy` and inspect it on
   a running Omarchy desktop. CI cannot validate desktop rendering.
5. Review the archive, release notes, and diff. Commit the release changes.

`release:pack` checks matching versions and changelog notes, packages only an
explicit file list, and writes `dist/codex-fomo-VERSION.tar.gz`, its SHA-256
checksum, and `dist/RELEASE_NOTES.md`. It extracts the archive into a temporary
directory and smoke-tests every offline JSON command without installed packages.
No local databases, logs, credentials, generated plugin paths, or `node_modules`
are packaged. GNU tar is required to build deterministic archives on Linux.
Update the allowlist in `scripts/release.ts` when adding distributable files.

## Publish on GitHub

Once the repository has a GitHub remote and the release commit is on its default
branch, push the matching tag (example for the first release):

```sh
git tag -a v0.1.0 -m 'Release v0.1.0'
git push origin v0.1.0
```

The tag workflow repeats verification, requires the tag to match the package
version, builds the archive, and creates a **draft** GitHub Release containing
its archive and checksum. Review and publish that draft in GitHub when ready.
The workflow uses the repository's built-in token; no separate secret is needed.

An existing release causes draft creation to fail rather than overwriting its
assets. For a partial failure, inspect the existing draft before uploading any
missing assets. Never replace an already-published version with different code.

CI also runs on pushes and pull requests and saves its archive as an Actions
artifact. It does not install the timer or plugin or use a real Codex account.
