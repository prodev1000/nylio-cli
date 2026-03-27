#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  CLI_CLIENT_ID,
  DEFAULT_API_BASE_URL,
  PUBLIC_SCOPE,
  buildPublicApiConfig,
} from "./public-config.js";

type TokenStore = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope: string;
  tokenType: string;
};

type CommandContext = {
  json: boolean;
  apiBaseUrl: string;
  issuer: string;
  publicApiAudience: string;
};

type OptionValue = string | boolean | undefined;

type ParsedCli = {
  options: Record<string, OptionValue>;
  positionals: string[];
};

type HelpSection = {
  description: string;
  usage: string[];
  subcommands?: Array<{ name: string; description: string }>;
  options?: Array<{ flag: string; description: string }>;
  examples?: string[];
};

type HelpKey =
  | "root"
  | "login"
  | "logout"
  | "auth"
  | "auth status"
  | "whoami"
  | "workspaces"
  | "workspaces list"
  | "documents"
  | "documents list"
  | "documents get"
  | "documents edit"
  | "documents replace"
  | "search";

const CONFIG_DIR = path.join(os.homedir(), ".config", "nylio");
const TOKEN_PATH = path.join(CONFIG_DIR, "auth.json");
const DEFAULT_CALLBACK_PORT = 39123;
const DEFAULT_CALLBACK_URL = `http://127.0.0.1:${DEFAULT_CALLBACK_PORT}/callback`;

const HELP_SECTIONS: Record<HelpKey, HelpSection> = {
  root: {
    description: "CLI for the Nylio public API.",
    usage: ["nylio <command> [subcommand] [options]", "nylio help <command> [subcommand]"],
    subcommands: [
      { name: "login", description: "Authenticate with OAuth 2.1 + PKCE." },
      { name: "logout", description: "Clear locally stored tokens." },
      { name: "auth status", description: "Show current auth state." },
      { name: "whoami", description: "Alias for auth status." },
      { name: "workspaces list", description: "List accessible workspaces." },
      { name: "documents", description: "List, fetch, edit, or replace documents." },
      { name: "search", description: "Search documents across workspaces." },
    ],
    options: [
      { flag: "--help", description: "Show help for the current command." },
      { flag: "--json", description: "Render machine-readable JSON output." },
      { flag: "--api-base-url <url>", description: "Override the API origin." },
    ],
    examples: [
      "nylio documents --help",
      "nylio documents get doc_123",
      "nylio documents replace --document doc_123 --stdin < body.md",
    ],
  },
  login: {
    description: "Authenticate and store local OAuth tokens.",
    usage: ["nylio login [--print-url] [--json] [--api-base-url <url>]"],
    options: [
      {
        flag: "--print-url",
        description: "Print the auth URL instead of opening a browser automatically.",
      },
      { flag: "--json", description: "Render the final auth result as JSON." },
      { flag: "--api-base-url <url>", description: "Override the API origin." },
    ],
    examples: ["nylio login", "nylio login --print-url"],
  },
  logout: {
    description: "Clear locally stored OAuth tokens.",
    usage: ["nylio logout [--json]"],
    options: [{ flag: "--json", description: "Render machine-readable JSON output." }],
    examples: ["nylio logout"],
  },
  auth: {
    description: "Authentication helpers.",
    usage: ["nylio auth <subcommand> [options]"],
    subcommands: [{ name: "status", description: "Show current auth state." }],
    examples: ["nylio auth status"],
  },
  "auth status": {
    description: "Show current auth state without making an API request.",
    usage: ["nylio auth status [--json] [--api-base-url <url>]"],
    options: [
      { flag: "--json", description: "Render machine-readable JSON output." },
      { flag: "--api-base-url <url>", description: "Override the API origin." },
    ],
    examples: ["nylio auth status", "nylio auth status --json"],
  },
  whoami: {
    description: "Alias for `nylio auth status`.",
    usage: ["nylio whoami [--json] [--api-base-url <url>]"],
    options: [
      { flag: "--json", description: "Render machine-readable JSON output." },
      { flag: "--api-base-url <url>", description: "Override the API origin." },
    ],
    examples: ["nylio whoami", "nylio whoami --json"],
  },
  workspaces: {
    description: "Workspace commands.",
    usage: ["nylio workspaces <subcommand> [options]"],
    subcommands: [{ name: "list", description: "List accessible workspaces." }],
    examples: ["nylio workspaces list"],
  },
  "workspaces list": {
    description: "List workspaces accessible to the current user.",
    usage: ["nylio workspaces list [--json] [--api-base-url <url>]"],
    options: [
      { flag: "--json", description: "Render machine-readable JSON output." },
      { flag: "--api-base-url <url>", description: "Override the API origin." },
    ],
    examples: ["nylio workspaces list", "nylio workspaces list --json"],
  },
  documents: {
    description: "Document commands.",
    usage: ["nylio documents <subcommand> [options]"],
    subcommands: [
      { name: "list", description: "List documents." },
      { name: "get", description: "Fetch a single document by id or URL." },
      { name: "edit", description: "Replace one string in a document." },
      { name: "replace", description: "Replace a document body." },
    ],
    examples: [
      "nylio documents list --limit 10",
      "nylio documents get doc_123",
      "nylio documents replace --document doc_123 --stdin < body.md",
    ],
  },
  "documents list": {
    description: "List documents in the current account scope.",
    usage: [
      "nylio documents list [--workspace-scope personal|organization] [--workspace-slug <slug>] [--limit <n>] [--offset <n>] [--cursor <cursor>]",
    ],
    options: [
      {
        flag: "--workspace-scope <scope>",
        description: "Limit results to `personal` or `organization` workspaces.",
      },
      { flag: "--workspace-slug <slug>", description: "Limit results to one workspace slug." },
      { flag: "--limit <n>", description: "Maximum number of documents to return." },
      { flag: "--offset <n>", description: "Offset for offset-based pagination." },
      { flag: "--cursor <cursor>", description: "Cursor for cursor-based pagination." },
      { flag: "--json", description: "Render machine-readable JSON output." },
      { flag: "--api-base-url <url>", description: "Override the API origin." },
    ],
    examples: [
      "nylio documents list --limit 10",
      "nylio documents list --workspace-slug my-workspace --limit 25",
    ],
  },
  "documents get": {
    description: "Fetch a document by id or supported Nylio URL.",
    usage: [
      "nylio documents get <id-or-url> [--workspace-scope personal|organization] [--workspace-slug <slug>]",
    ],
    options: [
      {
        flag: "--workspace-scope <scope>",
        description: "Override workspace resolution for ambiguous ids.",
      },
      { flag: "--workspace-slug <slug>", description: "Override workspace resolution." },
      { flag: "--json", description: "Render machine-readable JSON output." },
      { flag: "--api-base-url <url>", description: "Override the API origin." },
    ],
    examples: [
      "nylio documents get doc_123",
      "nylio documents get https://app.nylio.app/app/doc/doc_123",
    ],
  },
  "documents edit": {
    description: "Replace one string in a document.",
    usage: [
      "nylio documents edit <id-or-url> <oldString> <newString>",
      "nylio documents edit --document <id-or-url> --old-string <value> --new-string <value>",
      "nylio documents edit --document <id-or-url> --old-string <value> --new-string-stdin < replacement.txt",
    ],
    options: [
      { flag: "--document <id-or-url>", description: "Document id or supported Nylio URL." },
      { flag: "--old-string <value>", description: "Text to replace." },
      { flag: "--new-string <value>", description: "Replacement text." },
      { flag: "--old-string-stdin", description: "Read `oldString` from stdin." },
      { flag: "--new-string-stdin", description: "Read `newString` from stdin." },
      {
        flag: "--dry-run",
        description: "Preview the request payload without sending the mutation.",
      },
      { flag: "--json", description: "Render machine-readable JSON output." },
      { flag: "--api-base-url <url>", description: "Override the API origin." },
    ],
    examples: [
      'nylio documents edit doc_123 "Old heading" "New heading"',
      'nylio documents edit --document doc_123 --old-string "Old heading" --new-string "New heading"',
      "printf 'New heading' | nylio documents edit --document doc_123 --old-string \"Old heading\" --new-string-stdin",
    ],
  },
  "documents replace": {
    description: "Replace the full enhanced-markdown body of a document.",
    usage: [
      "nylio documents replace <id-or-url> <markdown>",
      "nylio documents replace --document <id-or-url> --markdown <markdown>",
      "nylio documents replace --document <id-or-url> --stdin < body.md",
    ],
    options: [
      { flag: "--document <id-or-url>", description: "Document id or supported Nylio URL." },
      { flag: "--markdown <markdown>", description: "Replacement markdown body." },
      { flag: "--stdin", description: "Read replacement markdown from stdin." },
      {
        flag: "--dry-run",
        description: "Preview the request payload without sending the mutation.",
      },
      { flag: "--json", description: "Render machine-readable JSON output." },
      { flag: "--api-base-url <url>", description: "Override the API origin." },
    ],
    examples: [
      'nylio documents replace doc_123 "# New title"',
      "nylio documents replace --document doc_123 --stdin < body.md",
      "cat body.md | nylio documents replace --document doc_123 --stdin",
    ],
  },
  search: {
    description: "Search documents across accessible workspaces.",
    usage: [
      "nylio search <query> [--workspace-scope personal|organization] [--workspace-slug <slug>] [--limit <n>] [--offset <n>]",
    ],
    options: [
      {
        flag: "--workspace-scope <scope>",
        description: "Limit results to `personal` or `organization` workspaces.",
      },
      { flag: "--workspace-slug <slug>", description: "Limit results to one workspace slug." },
      { flag: "--limit <n>", description: "Maximum number of results to return." },
      { flag: "--offset <n>", description: "Offset for pagination." },
      { flag: "--json", description: "Render machine-readable JSON output." },
      { flag: "--api-base-url <url>", description: "Override the API origin." },
    ],
    examples: [
      'nylio search "project plan"',
      'nylio search "quarterly review" --workspace-slug my-workspace --limit 5',
    ],
  },
};

const ROOT_HELP = (() => {
  const rootSection = HELP_SECTIONS.root;
  const lines = [rootSection.description, "", "Usage:"];

  for (const usage of rootSection.usage) {
    lines.push(`  ${usage}`);
  }

  if (rootSection.subcommands) {
    lines.push("", "Commands:");
    for (const subcommand of rootSection.subcommands) {
      lines.push(`  ${subcommand.name.padEnd(18)} ${subcommand.description}`);
    }
  }

  if (rootSection.options) {
    lines.push("", "Options:");
    for (const option of rootSection.options) {
      lines.push(`  ${option.flag.padEnd(28)} ${option.description}`);
    }
  }

  if (rootSection.examples) {
    lines.push("", "Examples:");
    for (const example of rootSection.examples) {
      lines.push(`  ${example}`);
    }
  }

  return lines.join("\n");
})();

const COMMAND_ALLOWED_OPTIONS: Record<HelpKey, readonly string[]> = {
  root: ["help", "json", "api-base-url"],
  login: ["help", "json", "api-base-url", "print-url"],
  logout: ["help", "json", "api-base-url"],
  auth: ["help", "json", "api-base-url"],
  "auth status": ["help", "json", "api-base-url"],
  whoami: ["help", "json", "api-base-url"],
  workspaces: ["help", "json", "api-base-url"],
  "workspaces list": ["help", "json", "api-base-url"],
  documents: ["help", "json", "api-base-url"],
  "documents list": [
    "help",
    "json",
    "api-base-url",
    "workspace-scope",
    "workspace-slug",
    "limit",
    "offset",
    "cursor",
  ],
  "documents get": ["help", "json", "api-base-url", "workspace-scope", "workspace-slug"],
  "documents edit": [
    "help",
    "json",
    "api-base-url",
    "document",
    "old-string",
    "new-string",
    "old-string-stdin",
    "new-string-stdin",
    "dry-run",
  ],
  "documents replace": ["help", "json", "api-base-url", "document", "markdown", "stdin", "dry-run"],
  search: ["help", "json", "api-base-url", "workspace-scope", "workspace-slug", "limit", "offset"],
};

const ALL_OPTIONS = {
  help: { type: "boolean" },
  json: { type: "boolean" },
  "api-base-url": { type: "string" },
  "workspace-scope": { type: "string" },
  "workspace-slug": { type: "string" },
  limit: { type: "string" },
  offset: { type: "string" },
  cursor: { type: "string" },
  document: { type: "string" },
  markdown: { type: "string" },
  stdin: { type: "boolean" },
  "old-string": { type: "string" },
  "new-string": { type: "string" },
  "old-string-stdin": { type: "boolean" },
  "new-string-stdin": { type: "boolean" },
  "print-url": { type: "boolean" },
  "dry-run": { type: "boolean" },
} as const;

const PUBLIC_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  PUBLIC_SCOPE.workspaceRead,
  PUBLIC_SCOPE.documentRead,
  PUBLIC_SCOPE.documentWrite,
  PUBLIC_SCOPE.searchRead,
].join(" ");

const decodeJwtExpiry = (token: string): number | null => {
  const parts = token.split(".");
  const payloadPart = parts[1];

  if (!payloadPart) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as {
      exp?: number;
    };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
};

const sha256Base64Url = (value: string) => createHash("sha256").update(value).digest("base64url");

const randomBase64Url = (size: number) => randomBytes(size).toString("base64url");

const formatHelp = (key: HelpKey): string => {
  const section = HELP_SECTIONS[key];
  const lines = [section.description, "", "Usage:"];

  for (const usage of section.usage) {
    lines.push(`  ${usage}`);
  }

  if (section.subcommands?.length) {
    lines.push("", "Subcommands:");
    for (const subcommand of section.subcommands) {
      lines.push(`  ${subcommand.name.padEnd(18)} ${subcommand.description}`);
    }
  }

  if (section.options?.length) {
    lines.push("", "Options:");
    for (const option of section.options) {
      lines.push(`  ${option.flag.padEnd(28)} ${option.description}`);
    }
  }

  if (section.examples?.length) {
    lines.push("", "Examples:");
    for (const example of section.examples) {
      lines.push(`  ${example}`);
    }
  }

  return lines.join("\n");
};

const resolveHelpKey = (positionals: string[]): HelpKey | null => {
  const [command, subcommand] = positionals;

  if (!command) {
    return "root";
  }

  if (command === "login") {
    return "login";
  }

  if (command === "logout") {
    return "logout";
  }

  if (command === "auth") {
    if (!subcommand) {
      return "auth";
    }

    if (subcommand === "status") {
      return "auth status";
    }

    return null;
  }

  if (command === "whoami") {
    return "whoami";
  }

  if (command === "workspaces") {
    if (!subcommand) {
      return "workspaces";
    }

    if (subcommand === "list") {
      return "workspaces list";
    }

    return null;
  }

  if (command === "documents") {
    if (!subcommand) {
      return "documents";
    }

    if (subcommand === "list") {
      return "documents list";
    }

    if (subcommand === "get") {
      return "documents get";
    }

    if (subcommand === "edit") {
      return "documents edit";
    }

    if (subcommand === "replace") {
      return "documents replace";
    }

    return null;
  }

  if (command === "search") {
    return "search";
  }

  return null;
};

const usageError = (message: string, helpKey: HelpKey): never => {
  throw new Error(`${message}\n\n${formatHelp(helpKey)}`);
};

const getProvidedOptions = (options: Record<string, OptionValue>) =>
  Object.entries(options)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);

const validateAllowedOptions = (helpKey: HelpKey, options: Record<string, OptionValue>) => {
  const allowed = new Set(COMMAND_ALLOWED_OPTIONS[helpKey]);
  const unsupported = getProvidedOptions(options)
    .filter((key) => !allowed.has(key))
    .map((key) => `--${key}`);

  if (unsupported.length > 0) {
    usageError(
      `Unsupported option${unsupported.length === 1 ? "" : "s"} for \`${helpKey}\`: ${unsupported.join(", ")}`,
      helpKey,
    );
  }
};

const readStdin = async (): Promise<string> => {
  if (process.stdin.isTTY) {
    throw new Error("Expected piped stdin input, but stdin is a TTY.");
  }

  let input = "";
  for await (const chunk of process.stdin) {
    input += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }

  return input;
};

const getStringOption = (options: Record<string, OptionValue>, key: string): string | undefined =>
  typeof options[key] === "string" ? (options[key] as string) : undefined;

const openBrowser = async (url: string) => {
  const platform = process.platform;
  const command =
    platform === "darwin"
      ? ["open", url]
      : platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];

  const [commandName, ...commandArgs] = command;
  if (!commandName) {
    throw new Error("No browser launcher available");
  }

  const child = spawn(commandName, commandArgs, {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
};

const ensureConfigDir = async () => {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
};

const readTokenStore = async (): Promise<TokenStore | null> => {
  try {
    const content = await readFile(TOKEN_PATH, "utf8");
    return JSON.parse(content) as TokenStore;
  } catch {
    return null;
  }
};

const writeTokenStore = async (value: TokenStore) => {
  await ensureConfigDir();
  await writeFile(TOKEN_PATH, JSON.stringify(value, null, 2), {
    mode: 0o600,
  });
  await chmod(TOKEN_PATH, 0o600);
};

const clearTokenStore = async () => {
  await rm(TOKEN_PATH, { force: true });
};

const exchangeToken = async (baseUrl: string, input: Record<string, string>) => {
  const body = new URLSearchParams(input);
  const response = await fetch(`${baseUrl}/api/auth/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const payload = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };

  const expiresAt =
    typeof payload.expires_in === "number"
      ? Date.now() + payload.expires_in * 1000
      : (decodeJwtExpiry(payload.access_token) ?? Date.now() + 15 * 60 * 1000);

  const tokenStore: TokenStore = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt,
    scope: payload.scope ?? PUBLIC_SCOPES,
    tokenType: payload.token_type ?? "Bearer",
  };

  await writeTokenStore(tokenStore);
  return tokenStore;
};

const ensureValidToken = async (ctx: CommandContext): Promise<TokenStore> => {
  const tokens = await readTokenStore();
  if (!tokens) {
    throw new Error("Not logged in. Run `nylio login` first.");
  }

  if (tokens.expiresAt - Date.now() > 30_000) {
    return tokens;
  }

  if (!tokens.refreshToken) {
    throw new Error("Access token expired and no refresh token is available.");
  }

  return exchangeToken(ctx.apiBaseUrl, {
    grant_type: "refresh_token",
    client_id: CLI_CLIENT_ID,
    refresh_token: tokens.refreshToken,
    resource: ctx.publicApiAudience,
  });
};

const authorizedFetch = async (
  ctx: CommandContext,
  url: string,
  init?: RequestInit,
): Promise<unknown> => {
  const tokens = await ensureValidToken(ctx);
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${tokens.accessToken}`,
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    let parsedMessage: string | null = null;
    try {
      const payload = JSON.parse(text) as {
        error?: { code?: string; message?: string };
      };
      const message = payload.error?.message?.trim();
      const code = payload.error?.code?.trim();
      if (message) {
        parsedMessage = code ? `HTTP ${response.status} ${code}: ${message}` : message;
      }
    } catch {}

    if (parsedMessage) {
      throw new Error(parsedMessage);
    }

    throw new Error(text);
  }

  return response.json();
};

const resolveDocumentRef = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Document reference is required");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return trimmed;
  }

  const segments = parsedUrl.pathname.split("/").filter((segment) => segment.length > 0);

  if (segments[0] === "app" && segments[1] === "doc" && segments[2]) {
    return decodeURIComponent(segments[2]);
  }

  if (segments[0] === "d" && segments[1]) {
    return decodeURIComponent(segments[1]);
  }

  throw new Error("Unsupported document URL. Use a Nylio /app/doc/... or /d/... document URL.");
};

const render = (ctx: CommandContext, value: unknown) => {
  if (ctx.json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  if (typeof value === "string") {
    console.log(value);
    return;
  }

  console.log(JSON.stringify(value, null, 2));
};

const login = async (ctx: CommandContext, options: Record<string, OptionValue>) => {
  const codeVerifier = randomBase64Url(48);
  const codeChallenge = sha256Base64Url(codeVerifier);
  const state = randomBase64Url(24);

  const callbackPromise = new Promise<URL>((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${DEFAULT_CALLBACK_PORT}`);

      if (url.pathname !== "/callback") {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }

      response.statusCode = 200;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("Authentication complete. You can return to the terminal.");
      server.close(() => resolve(url));
    });

    server.listen(DEFAULT_CALLBACK_PORT, "127.0.0.1");
    server.on("error", reject);
  });

  const authorizeUrl = new URL(`${ctx.apiBaseUrl}/api/auth/oauth2/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", CLI_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", DEFAULT_CALLBACK_URL);
  authorizeUrl.searchParams.set("scope", PUBLIC_SCOPES);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("resource", ctx.publicApiAudience);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const authUrl = authorizeUrl.toString();
  if (options["print-url"] === true) {
    console.error(`Open this URL to continue login:\n${authUrl}`);
  } else {
    console.error(`Opening browser for login: ${authUrl}`);
    void openBrowser(authUrl);
  }

  const callback = await callbackPromise;

  if (callback.searchParams.get("state") !== state) {
    throw new Error("OAuth state mismatch");
  }

  const code = callback.searchParams.get("code");
  if (!code) {
    throw new Error(callback.searchParams.get("error") ?? "Missing auth code");
  }

  const tokenStore = await exchangeToken(ctx.apiBaseUrl, {
    grant_type: "authorization_code",
    client_id: CLI_CLIENT_ID,
    redirect_uri: DEFAULT_CALLBACK_URL,
    code,
    code_verifier: codeVerifier,
    resource: ctx.publicApiAudience,
  });

  render(ctx, {
    status: "ok",
    issuer: ctx.issuer,
    audience: ctx.publicApiAudience,
    expiresAt: new Date(tokenStore.expiresAt).toISOString(),
  });
};

const authStatus = async (ctx: CommandContext) => {
  const tokens = await readTokenStore();
  if (!tokens) {
    render(ctx, { authenticated: false });
    return;
  }

  render(ctx, {
    authenticated: true,
    issuer: ctx.issuer,
    audience: ctx.publicApiAudience,
    expiresAt: new Date(tokens.expiresAt).toISOString(),
    scope: tokens.scope,
  });
};

const workspacesList = async (ctx: CommandContext) => {
  const value = await authorizedFetch(ctx, `${ctx.apiBaseUrl}/api/public/v1/workspaces`);
  render(ctx, value);
};

const documentsList = async (
  ctx: CommandContext,
  args: string[],
  options: Record<string, string | boolean | undefined>,
) => {
  const url = new URL(`${ctx.apiBaseUrl}/api/public/v1/documents`);
  if (typeof options["workspace-scope"] === "string") {
    url.searchParams.set("workspaceScope", options["workspace-scope"]);
  }
  if (typeof options["workspace-slug"] === "string") {
    url.searchParams.set("workspaceSlug", options["workspace-slug"]);
  }
  if (typeof options.limit === "string") {
    url.searchParams.set("limit", options.limit);
  }
  if (typeof options.offset === "string") {
    url.searchParams.set("offset", options.offset);
  }
  if (typeof options.cursor === "string") {
    url.searchParams.set("cursor", options.cursor);
  }

  render(ctx, await authorizedFetch(ctx, url.toString()));
};

const documentsGet = async (
  ctx: CommandContext,
  args: string[],
  options: Record<string, string | boolean | undefined>,
) => {
  const documentRef = args[0];
  if (!documentRef) {
    throw new Error("Document ID or URL is required");
  }

  const documentId = resolveDocumentRef(documentRef);
  const url = new URL(`${ctx.apiBaseUrl}/api/public/v1/documents/${documentId}`);
  if (typeof options["workspace-scope"] === "string") {
    url.searchParams.set("workspaceScope", options["workspace-scope"]);
  }
  if (typeof options["workspace-slug"] === "string") {
    url.searchParams.set("workspaceSlug", options["workspace-slug"]);
  }

  render(ctx, await authorizedFetch(ctx, url.toString()));
};

const documentsEdit = async (
  ctx: CommandContext,
  args: string[],
  options: Record<string, OptionValue>,
) => {
  const stdinTargets = [
    options["old-string-stdin"] === true ? "oldString" : null,
    options["new-string-stdin"] === true ? "newString" : null,
  ].filter((value): value is "oldString" | "newString" => value !== null);

  if (stdinTargets.length > 1) {
    usageError(
      "Only one stdin-backed field is supported per `documents edit` invocation.",
      "documents edit",
    );
  }

  const documentRef = getStringOption(options, "document") ?? args[0];
  if (!documentRef) {
    usageError(
      "Document ID or URL is required. Pass it positionally or with `--document`.",
      "documents edit",
    );
  }

  const stdinValue = stdinTargets.length === 1 ? await readStdin() : undefined;
  const oldString =
    stdinTargets[0] === "oldString"
      ? stdinValue
      : (getStringOption(options, "old-string") ?? args[1]);
  const newString =
    stdinTargets[0] === "newString"
      ? stdinValue
      : (getStringOption(options, "new-string") ?? args[2]);

  if (typeof oldString !== "string") {
    usageError(
      "Missing `oldString`. Pass `<oldString>`, `--old-string`, or `--old-string-stdin`.",
      "documents edit",
    );
  }
  if (typeof newString !== "string") {
    usageError(
      "Missing `newString`. Pass `<newString>`, `--new-string`, or `--new-string-stdin`.",
      "documents edit",
    );
  }

  const payload = {
    document: documentRef,
    oldString,
    newString,
  };

  if (options["dry-run"] === true) {
    render(ctx, {
      dryRun: true,
      command: "documents edit",
      endpoint: `${ctx.apiBaseUrl}/api/public/v1/documents/edit`,
      method: "POST",
      payload,
      note: "No changes made.",
    });
    return;
  }

  render(
    ctx,
    await authorizedFetch(ctx, `${ctx.apiBaseUrl}/api/public/v1/documents/edit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    }),
  );
};

const documentsReplace = async (
  ctx: CommandContext,
  args: string[],
  options: Record<string, OptionValue>,
) => {
  const documentRef = getStringOption(options, "document") ?? args[0];
  if (!documentRef) {
    usageError(
      "Document ID or URL is required. Pass it positionally or with `--document`.",
      "documents replace",
    );
  }

  const stdinMarkdown = options.stdin === true ? await readStdin() : undefined;
  const positionalMarkdown =
    getStringOption(options, "document") !== undefined ? args.join(" ") : args.slice(1).join(" ");
  const markdown = stdinMarkdown ?? getStringOption(options, "markdown") ?? positionalMarkdown;

  if (!markdown) {
    usageError(
      "Replacement markdown is required. Pass `<markdown>`, `--markdown`, or `--stdin`.",
      "documents replace",
    );
  }

  const payload = {
    document: documentRef,
    markdown,
  };

  if (options["dry-run"] === true) {
    render(ctx, {
      dryRun: true,
      command: "documents replace",
      endpoint: `${ctx.apiBaseUrl}/api/public/v1/documents/replace`,
      method: "POST",
      payload,
      note: "No changes made.",
    });
    return;
  }

  render(
    ctx,
    await authorizedFetch(ctx, `${ctx.apiBaseUrl}/api/public/v1/documents/replace`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    }),
  );
};

const search = async (
  ctx: CommandContext,
  args: string[],
  options: Record<string, string | boolean | undefined>,
) => {
  const query = args.join(" ").trim();
  if (!query) {
    throw new Error("Search query is required");
  }

  const url = new URL(`${ctx.apiBaseUrl}/api/public/v1/search`);
  url.searchParams.set("q", query);
  if (typeof options["workspace-scope"] === "string") {
    url.searchParams.set("workspaceScope", options["workspace-scope"]);
  }
  if (typeof options["workspace-slug"] === "string") {
    url.searchParams.set("workspaceSlug", options["workspace-slug"]);
  }
  if (typeof options.limit === "string") {
    url.searchParams.set("limit", options.limit);
  }
  if (typeof options.offset === "string") {
    url.searchParams.set("offset", options.offset);
  }

  render(ctx, await authorizedFetch(ctx, url.toString()));
};

const parseCli = (argv: string[]): ParsedCli => {
  try {
    const options = parseArgs({
      args: argv,
      options: ALL_OPTIONS,
      allowPositionals: true,
      strict: true,
    });

    return {
      options: options.values,
      positionals: options.positionals,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n\n${ROOT_HELP}`);
  }
};

const main = async () => {
  const { options, positionals } = parseCli(process.argv.slice(2));
  const [command, subcommand, ...rest] = positionals;
  const authConfig = buildPublicApiConfig(
    typeof options["api-base-url"] === "string" ? options["api-base-url"] : DEFAULT_API_BASE_URL,
  );
  const ctx: CommandContext = {
    json: options.json === true,
    apiBaseUrl: authConfig.apiBaseUrl,
    issuer: authConfig.issuer,
    publicApiAudience: authConfig.publicApiAudience,
  };

  const helpKey =
    command === "help" ? resolveHelpKey(positionals.slice(1)) : resolveHelpKey(positionals);

  if (options.help === true || command === "help" || !command) {
    if (!helpKey) {
      throw new Error(`Unknown command: ${positionals.join(" ")}\n\n${ROOT_HELP}`);
    }

    render(ctx, formatHelp(helpKey));
    return;
  }

  if (!helpKey) {
    throw new Error(`Unknown command: ${positionals.join(" ")}\n\n${ROOT_HELP}`);
  }

  validateAllowedOptions(helpKey, options);

  if (helpKey === "auth" || helpKey === "workspaces" || helpKey === "documents") {
    render(ctx, formatHelp(helpKey));
    return;
  }

  if (command === "login") {
    await login(ctx, options);
    return;
  }

  if (command === "logout") {
    await clearTokenStore();
    render(ctx, { status: "logged_out" });
    return;
  }

  if (command === "auth" && subcommand === "status") {
    await authStatus(ctx);
    return;
  }

  if (command === "whoami") {
    await authStatus(ctx);
    return;
  }

  if (command === "workspaces" && subcommand === "list") {
    await workspacesList(ctx);
    return;
  }

  if (command === "documents" && subcommand === "list") {
    await documentsList(ctx, rest, options);
    return;
  }

  if (command === "documents" && subcommand === "get") {
    await documentsGet(ctx, rest, options);
    return;
  }

  if (command === "documents" && subcommand === "edit") {
    await documentsEdit(ctx, rest, options);
    return;
  }

  if (command === "documents" && subcommand === "replace") {
    await documentsReplace(ctx, rest, options);
    return;
  }

  if (command === "search") {
    await search(
      ctx,
      [subcommand, ...rest].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      ),
      options,
    );
    return;
  }

  throw new Error(`Unknown command: ${positionals.join(" ")}\n\n${ROOT_HELP}`);
};

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
