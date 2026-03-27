# nylio-cli

Open-source CLI for the Nylio public API.

## License

Apache-2.0

## Install

```bash
npm install -g nylio-cli
```

## Commands

```bash
nylio --help
nylio documents --help
nylio login
nylio login --print-url
nylio auth status
nylio whoami
nylio workspaces list
nylio documents list --limit 10 --offset 0
nylio documents get <document-id-or-url>
nylio documents edit --document <document-id-or-url> --old-string "<oldString>" --new-string "<newString>"
cat replacement.txt | nylio documents edit --document <document-id-or-url> --old-string "<oldString>" --new-string-stdin
nylio documents replace --document <document-id-or-url> --markdown "<full-enhanced-markdown-body>"
cat body.md | nylio documents replace --document <document-id-or-url> --stdin
nylio search "query"
```

Every command and subcommand supports `--help` with targeted examples.

## Build

```bash
npm install
npm run ci
npm run pack:dry-run
```

The publish safety check rejects:

- imports from server-only or monorepo-internal modules
- `process.env` usage inside `src`

## CI

GitHub Actions runs:

- `lint`
- `typecheck`
- `build`
- `pack:dry-run`

The workflows run through Turborepo and persist the local `.turbo` cache between CI runs.

## Publish

Push a tag that matches the package version:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The publish workflow verifies the tag, runs the Turbo pipeline, and publishes to npm.

## Configuration

- `--api-base-url <url>` overrides the default API origin
- `--json` renders machine-readable JSON output

The default API origin is `https://api.nylio.app`.

## Auth

The CLI uses OAuth 2.1 Authorization Code + PKCE and stores user tokens locally at `~/.config/nylio/auth.json`.

Use `nylio login --print-url` if you do not want the CLI to open a browser automatically.
