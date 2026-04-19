# nylio-cli

Open-source CLI for the Nylio public API.

Related docs:

- npm package: [nylio-cli](https://www.npmjs.com/package/nylio-cli)
- monorepo integration note: [`function/docs/nylio-cli.md`](https://github.com/prodev1000/function/blob/main/docs/nylio-cli.md)

## Install

```bash
npm install -g nylio-cli
```

macOS users can also install a self-contained Bun-compiled binary via Homebrew once a tap formula is published.

## Commands

```bash
nylio --help
nylio documents --help
nylio login
nylio login --print-url
nylio auth status
nylio whoami
nylio workspaces list
nylio documents create --title "Draft"
nylio documents list --limit 10 --offset 0
nylio documents get <document-id-or-url>
nylio documents import ./draft.docx
nylio documents import ./notes.md
nylio documents import ./my-vault
nylio comments list --document <document-id-or-url>
nylio comments create --document <document-id-or-url> --text "Please clarify this section."
nylio comments reply --comment <comment-id> --text "Updated in the latest pass."
nylio comments resolve --thread <thread-id>
nylio documents edit --document <document-id-or-url> --old-string "<oldString>" --new-string "<newString>"
cat replacement.txt | nylio documents edit --document <document-id-or-url> --old-string "<oldString>" --new-string-stdin
nylio documents replace --document <document-id-or-url> --markdown "<full-enhanced-markdown-body>"
cat body.md | nylio documents replace --document <document-id-or-url> --stdin
nylio documents export <document-id-or-url> --format markdown
nylio search "query"
```

Each command and subcommand now supports `--help` with targeted examples, for example:

```bash
nylio documents get --help
nylio documents replace --help
```

## Build

```bash
npm run check:publish-safety
npm run lint
npm run typecheck
npm run build
npm pack --dry-run
```

The publish safety check fails if the CLI imports server-only code, workspace-internal aliases, or files outside `src`.

## Publish

GitHub Actions publishes the package from the `Publish CLI` workflow when you push a tag in the format `nylio-cli-v<version>`, for example:

```bash
git tag nylio-cli-v0.1.0
git push origin nylio-cli-v0.1.0
```

That same workflow also creates a GitHub Release for the tag and uploads:

- `nylio-cli-<version>-darwin-arm64.tar.gz`
- `nylio-cli-<version>-darwin-x64.tar.gz`
- `SHA256SUMS`
- `nylio.rb` for Homebrew

GitHub Releases are the distribution point for the self-contained macOS binaries. Homebrew should point at those release assets.

Manual local publish is also wired:

```bash
npm run publish:npm
```

To build the macOS release artifacts locally:

```bash
npm run release:artifacts -- --repo prodev1000/nylio-cli --tag v0.1.0
```

That writes the archives, checksums, and a generated Homebrew formula to `dist/release`.

## Homebrew

The generated `nylio.rb` formula is intended for a tap repo and references the GitHub Release assets for the tagged version.

Recommended setup:

- keep `npm` as the cross-platform install path
- publish macOS Bun binaries to GitHub Releases
- maintain a small Homebrew tap repo that contains the generated `nylio.rb`

Once a tap exists, installs look like:

```bash
brew tap <owner>/<tap-repo>
brew install nylio
```

## Configuration

- `--api-base-url <url>` overrides the default API origin
- default output is compact plain text
- `--json` renders machine-readable JSON output
- `BETTER_AUTH_URL` sets the default API origin when `--api-base-url` is not passed
- `NYLIO_OAUTH_CLI_CLIENT_ID` overrides the OAuth client id for custom environments

## Agent-friendly usage

- Unknown flags fail fast instead of being ignored.
- Write commands accept explicit flags instead of requiring positional-only input.
- `nylio documents import <path>` uploads a local `.docx`, `.odt`, Markdown, text, or Obsidian vault `.zip` file and creates personal documents.
- Passing a local directory to `nylio documents import` packages it as an Obsidian vault ZIP before upload.
- `nylio documents replace --stdin` reads the replacement body from stdin.
- `nylio documents edit --old-string-stdin` and `--new-string-stdin` let you pipe one side of the edit.
- `nylio comments create --author-mode assistant` and `nylio comments reply --author-mode assistant` post from the user's AI assistant label.
- `--dry-run` previews `documents edit` and `documents replace` requests without sending them.

## Auth

The CLI uses OAuth 2.1 Authorization Code + PKCE against the Nylio Better Auth issuer and stores user tokens locally at `~/.config/nylio/auth.json`.

Use `nylio login --print-url` if you do not want the CLI to open a browser automatically.

## License

MIT
