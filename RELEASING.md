# Releasing

This bundle ships **only through GitHub** — no npm publication, no registry
index. Users install the repository spec (`github:ceasarXuu/dsh-better-markdown`)
or a release tarball.

## Checklist

```sh
# 1. Version: bump for every release (tags and tarballs carry the version)
npm version patch --no-git-tag-version      # or minor/major

# 2. Tests, syntax checks, and the packed file list
npm test
npm run check
npm pack --dry-run                          # confirm files, size, no private data

# 3. Commit, tag, push
git add -A
git commit -m "release: v$(node -p "require('./package.json').version")"
git tag "v$(node -p "require('./package.json').version")"
git push origin main --tags

# 4. Publish the release artifact (optional but recommended)
npm pack
gh release create "v$(node -p "require('./package.json').version")" \
  "ceasarxuu-dsh-better-markdown-$(node -p "require('./package.json').version").tgz" \
  --title "v$(node -p "require('./package.json').version")" \
  --notes-file CHANGELOG.md
```

Post-release checks on a clean profile:

- `dsh plugin --profile <profile> add github:ceasarXuu/dsh-better-markdown#v<version>`
  installs and the plugin row appears in Plugins.
- Composer: type `# hi` → preview appears with an `<h1>`; `⌘⇧M` toggles it;
  reload keeps the browser choice.
- Transcript: send a Markdown message → the durable user bubble renders
  headings/lists/code, the copy action still copies the raw Markdown.
- Set `transcript: false` / `enabled: false` in the profile patch and reload →
  shipped plain-text behavior returns.
- Check the plugin card shows the localized title/description (`locale/*.json`)
  and `icon.svg`.

## Compatibility policy

- `engines.dsh` currently allows `>=0.2.1-rc.5 <0.3.0`. Verified live on DSH
  0.2.2-rc.1 (desktop runtime) and statically on 0.2.1-rc.5 for every slot,
  priority, and platform module this plugin uses. Widen only after installing
  and running on the older version; narrow when a slot contract breaks.
- The plugin uses only public seams: the keyed `conversation.user.text.node`
  slot, the `conversation.input.dock` / `conversation.input.right` list slots,
  locale registration, the `hooks` injection compartment, and the platform
  `@deepseek-ai/dsh-client-ui-primitives` module. If DSH changes one, bump the
  minor version and state the tested DSH version in the README.
- Re-run `dev/verify.mjs` on every DSH bump; it fails loudly when a slot stops
  rendering or the highlight API changes.

## Rollback

A GitHub-only distribution rolls back by moving the tag or by pinning users to
the previous tag: `github:ceasarXuu/dsh-better-markdown#v<previous>`.
