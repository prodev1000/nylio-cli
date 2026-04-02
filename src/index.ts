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

type ExportPayload = {
  document: {
    id: string;
    title: string;
    url: string;
  };
  export: {
    format: "markdown" | "docx" | "pdf";
    mimeType: string;
    fileName: string;
    text: string | null;
    dataBase64: string | null;
  };
};

type WorkspaceSummaryPayload = {
  id: string;
  kind: "personal" | "organization";
  name: string;
  slug: string | null;
  role: string | null;
  isCurrent: boolean;
};

type WorkspacesPayload = {
  currentWorkspace: WorkspaceSummaryPayload;
  workspaces: WorkspaceSummaryPayload[];
};

type DocumentSummaryPayload = {
  id: string;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
};

type DocumentPagePayload = {
  data: DocumentSummaryPayload[];
  pageInfo: {
    nextCursor: string | null;
    nextOffset: number | null;
    hasMore: boolean;
    limit: number;
    offset: number;
  };
};

type DocumentGetPayload = {
  document: DocumentSummaryPayload;
  content: {
    mimeType: "text/x-nylio-enhanced-markdown";
    format: "nylio_enhanced_markdown";
    target: "body";
    pageMode: "document" | "pages" | "markdown";
    source?: "projection";
    markdown: string;
  };
};

type DocumentCreatePayload = {
  created: true;
  document: DocumentSummaryPayload;
};

type DocumentMutationPayload = {
  applied: boolean;
  message: string;
  operation:
    | {
        type: "edit";
        replacements: number;
      }
    | {
        type: "replace";
      };
  document: DocumentSummaryPayload;
};

type SearchPayload = {
  data: Array<{
    documentId: string;
    title: string | null;
    score: number;
  }>;
  pageInfo: {
    nextOffset: number | null;
    hasMore: boolean;
    limit: number;
    offset: number;
  };
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
  | "documents create"
  | "documents list"
  | "documents get"
  | "documents edit"
  | "documents replace"
  | "documents export"
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
      {
        name: "documents",
        description: "List, fetch, edit, or replace documents.",
      },
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
      { name: "create", description: "Create a new personal document." },
      { name: "list", description: "List documents." },
      { name: "get", description: "Fetch a single document by id or URL." },
      { name: "edit", description: "Replace one string in a document." },
      { name: "replace", description: "Replace a document body." },
      { name: "export", description: "Export one document." },
    ],
    examples: [
      "nylio documents list --limit 10",
      'nylio documents create --title "Draft"',
      "nylio documents get doc_123",
      "nylio documents replace --document doc_123 --stdin < body.md",
      "nylio documents export doc_123 --format pdf",
    ],
  },
  "documents create": {
    description: "Create a new personal document with optional initial enhanced markdown.",
    usage: [
      "nylio documents create [--title <title>] [--markdown <markdown>]",
      "nylio documents create [--title <title>] [--stdin]",
    ],
    options: [
      {
        flag: "--title <title>",
        description: "Document title. Defaults to `Untitled document`.",
      },
      {
        flag: "--markdown <markdown>",
        description: "Initial enhanced markdown body.",
      },
      {
        flag: "--stdin",
        description: "Read initial enhanced markdown body from stdin.",
      },
      { flag: "--json", description: "Render machine-readable JSON output." },
      { flag: "--api-base-url <url>", description: "Override the API origin." },
    ],
    examples: [
      'nylio documents create --title "Draft"',
      'nylio documents create --title "Draft" --markdown "# Draft"',
      'cat body.md | nylio documents create --title "Draft" --stdin',
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
      {
        flag: "--workspace-slug <slug>",
        description: "Limit results to one workspace slug.",
      },
      {
        flag: "--limit <n>",
        description: "Maximum number of documents to return.",
      },
      {
        flag: "--offset <n>",
        description: "Offset for offset-based pagination.",
      },
      {
        flag: "--cursor <cursor>",
        description: "Cursor for cursor-based pagination.",
      },
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
      {
        flag: "--workspace-slug <slug>",
        description: "Override workspace resolution.",
      },
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
      {
        flag: "--document <id-or-url>",
        description: "Document id or supported Nylio URL.",
      },
      { flag: "--old-string <value>", description: "Text to replace." },
      { flag: "--new-string <value>", description: "Replacement text." },
      {
        flag: "--old-string-stdin",
        description: "Read `oldString` from stdin.",
      },
      {
        flag: "--new-string-stdin",
        description: "Read `newString` from stdin.",
      },
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
      {
        flag: "--document <id-or-url>",
        description: "Document id or supported Nylio URL.",
      },
      {
        flag: "--markdown <markdown>",
        description: "Replacement markdown body.",
      },
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
  "documents export": {
    description: "Export one document as standard markdown, DOCX, or PDF.",
    usage: ["nylio documents export <id-or-url> --format markdown|docx|pdf [--output <path>]"],
    options: [
      {
        flag: "--format <format>",
        description: "Export format: `markdown`, `docx`, or `pdf`.",
      },
      {
        flag: "--output <path>",
        description: "Write the exported file to this path.",
      },
      {
        flag: "--workspace-scope <scope>",
        description: "Override workspace resolution for ambiguous ids.",
      },
      {
        flag: "--workspace-slug <slug>",
        description: "Override workspace resolution.",
      },
      { flag: "--json", description: "Render the raw export payload as JSON." },
      { flag: "--api-base-url <url>", description: "Override the API origin." },
    ],
    examples: [
      "nylio documents export doc_123 --format markdown",
      "nylio documents export doc_123 --format pdf --output ./draft.pdf",
      "nylio documents export https://app.nylio.app/app/doc/doc_123 --format docx",
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
      {
        flag: "--workspace-slug <slug>",
        description: "Limit results to one workspace slug.",
      },
      {
        flag: "--limit <n>",
        description: "Maximum number of results to return.",
      },
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
  "documents create": ["help", "json", "api-base-url", "title", "markdown", "stdin"],
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
  "documents export": [
    "help",
    "json",
    "api-base-url",
    "workspace-scope",
    "workspace-slug",
    "format",
    "output",
  ],
  search: ["help", "json", "api-base-url", "workspace-scope", "workspace-slug", "limit", "offset"],
};

const ALL_OPTIONS = {
  help: { type: "boolean" },
  json: { type: "boolean" },
  "api-base-url": { type: "string" },
  "workspace-scope": { type: "string" },
  "workspace-slug": { type: "string" },
  title: { type: "string" },
  limit: { type: "string" },
  offset: { type: "string" },
  cursor: { type: "string" },
  document: { type: "string" },
  markdown: { type: "string" },
  format: { type: "string" },
  output: { type: "string" },
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
  if (parts.length < 2) {
    return null;
  }
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

    if (subcommand === "create") {
      return "documents create";
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

    if (subcommand === "export") {
      return "documents export";
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

const renderText = (ctx: CommandContext, text: string, jsonValue?: unknown) => {
  if (ctx.json) {
    render(ctx, jsonValue ?? text);
    return;
  }

  console.log(text);
};

const clampCell = (value: string, width: number): string => {
  if (value.length <= width) {
    return value;
  }

  if (width <= 3) {
    return value.slice(0, width);
  }

  return `${value.slice(0, width - 3)}...`;
};

const formatTable = (headers: string[], rows: string[][], maxWidths?: number[]): string => {
  const widths = headers.map((header, index) => {
    const longestCell = rows.reduce((max, row) => {
      const cell = row[index] ?? "";
      return Math.max(max, cell.length);
    }, header.length);
    const cap = maxWidths?.[index];
    return cap ? Math.min(longestCell, cap) : longestCell;
  });

  const renderRow = (row: string[]) =>
    row
      .map((cell, index) => clampCell(cell ?? "", widths[index] ?? 0))
      .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
      .join("  ")
      .trimEnd();

  return [renderRow(headers), ...rows.map(renderRow)].join("\n");
};

const formatOffsetPageInfo = (pageInfo: {
  hasMore: boolean;
  limit: number;
  offset: number;
  nextOffset: number | null;
}) => {
  const lines = [
    `limit ${pageInfo.limit}`,
    `offset ${pageInfo.offset}`,
    `has_more ${pageInfo.hasMore ? "true" : "false"}`,
  ];

  if (pageInfo.nextOffset !== null) {
    lines.push(`next_offset ${pageInfo.nextOffset}`);
  }

  return lines.join("\n");
};

const formatDocumentPageInfo = (pageInfo: DocumentPagePayload["pageInfo"]) => {
  const lines = [formatOffsetPageInfo(pageInfo)];

  if (pageInfo.nextCursor) {
    lines.push(`next_cursor ${pageInfo.nextCursor}`);
  }

  return lines.join("\n");
};

const formatLoginText = (value: {
  status: string;
  issuer: string;
  audience: string;
  expiresAt: string;
}) =>
  [
    `status ${value.status}`,
    `issuer ${value.issuer}`,
    `audience ${value.audience}`,
    `expires_at ${value.expiresAt}`,
  ].join("\n");

const formatAuthStatusText = (value: {
  authenticated: boolean;
  issuer?: string;
  audience?: string;
  expiresAt?: string;
  scope?: string;
}) => {
  if (!value.authenticated) {
    return "authenticated false";
  }

  return [
    "authenticated true",
    `issuer ${value.issuer ?? "-"}`,
    `audience ${value.audience ?? "-"}`,
    `expires_at ${value.expiresAt ?? "-"}`,
    `scope ${value.scope ?? "-"}`,
  ].join("\n");
};

const formatWorkspacesText = (payload: WorkspacesPayload) => {
  const rows = payload.workspaces.map((workspace) => [
    workspace.isCurrent ? "*" : "",
    workspace.kind,
    workspace.slug ?? "-",
    workspace.role ?? "-",
    workspace.name,
  ]);
  return rows.length > 0
    ? formatTable(["current", "kind", "slug", "role", "name"], rows, [7, 12, 18, 12, 32])
    : "(no workspaces)";
};

const formatDocumentsListText = (payload: DocumentPagePayload) => {
  const rows = payload.data.map((document) => [document.updatedAt, document.id, document.title]);
  const table =
    rows.length > 0
      ? formatTable(["updated_at", "id", "title"], rows, [24, 28, 64])
      : "(no documents)";

  return `${table}\n\n${formatDocumentPageInfo(payload.pageInfo)}`;
};

const formatDocumentGetText = (payload: DocumentGetPayload) =>
  [
    `id ${payload.document.id}`,
    `title ${payload.document.title}`,
    `updated_at ${payload.document.updatedAt}`,
    `url ${payload.document.url}`,
    `page_mode ${payload.content.pageMode}`,
    ...(payload.content.source ? [`source ${payload.content.source}`] : []),
    "",
    payload.content.markdown,
  ].join("\n");

const formatDocumentCreateText = (payload: DocumentCreatePayload) =>
  [
    "created true",
    `id ${payload.document.id}`,
    `title ${payload.document.title}`,
    `updated_at ${payload.document.updatedAt}`,
    `url ${payload.document.url}`,
  ].join("\n");

const formatDocumentMutationText = (payload: DocumentMutationPayload) => {
  const lines = [
    `operation ${payload.operation.type}`,
    `applied ${payload.applied ? "true" : "false"}`,
    `id ${payload.document.id}`,
    `title ${payload.document.title}`,
    `updated_at ${payload.document.updatedAt}`,
    `url ${payload.document.url}`,
    `message ${payload.message}`,
  ];

  if ("replacements" in payload.operation) {
    lines.splice(2, 0, `replacements ${payload.operation.replacements}`);
  }

  return lines.join("\n");
};

const formatDryRunText = (value: {
  command: string;
  endpoint: string;
  method: string;
  payload: Record<string, string>;
}) => {
  const lines = [
    "dry_run true",
    `command ${value.command}`,
    `method ${value.method}`,
    `endpoint ${value.endpoint}`,
  ];

  for (const [key, rawValue] of Object.entries(value.payload)) {
    const normalized = rawValue.replace(/\s+/g, " ").trim();
    lines.push(
      `${key} ${normalized ? clampCell(normalized, 80) : "(empty)"} (${rawValue.length} chars)`,
    );
  }

  return lines.join("\n");
};

const formatExportSummaryText = (payload: {
  exported: true;
  format: "markdown" | "docx" | "pdf";
  path: string;
  documentId: string;
}) =>
  [
    "exported true",
    `format ${payload.format}`,
    `path ${payload.path}`,
    `document_id ${payload.documentId}`,
  ].join("\n");

const formatSearchText = (payload: SearchPayload) => {
  const rows = payload.data.map((result) => [
    result.score.toFixed(3),
    result.documentId,
    result.title ?? "-",
  ]);
  const table =
    rows.length > 0
      ? formatTable(["score", "document_id", "title"], rows, [8, 28, 64])
      : "(no results)";

  return `${table}\n\n${formatOffsetPageInfo(payload.pageInfo)}`;
};

const writeExportOutput = async (args: {
  payload: ExportPayload;
  outputPath?: string;
}) => {
  const targetPath = args.outputPath ?? args.payload.export.fileName;

  if (args.payload.export.format === "markdown") {
    const text = args.payload.export.text ?? "";
    await writeFile(targetPath, text, "utf8");
    return targetPath;
  }

  const rawBase64 = args.payload.export.dataBase64;
  if (!rawBase64) {
    throw new Error("Export payload did not include binary data.");
  }

  await writeFile(targetPath, Buffer.from(rawBase64, "base64"));
  return targetPath;
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

  const payload = {
    status: "ok",
    issuer: ctx.issuer,
    audience: ctx.publicApiAudience,
    expiresAt: new Date(tokenStore.expiresAt).toISOString(),
  };

  renderText(ctx, formatLoginText(payload), payload);
};

const authStatus = async (ctx: CommandContext) => {
  const tokens = await readTokenStore();
  if (!tokens) {
    const payload = { authenticated: false };
    renderText(ctx, formatAuthStatusText(payload), payload);
    return;
  }

  const payload = {
    authenticated: true,
    issuer: ctx.issuer,
    audience: ctx.publicApiAudience,
    expiresAt: new Date(tokens.expiresAt).toISOString(),
    scope: tokens.scope,
  };

  renderText(ctx, formatAuthStatusText(payload), payload);
};

const workspacesList = async (ctx: CommandContext) => {
  const value = (await authorizedFetch(
    ctx,
    `${ctx.apiBaseUrl}/api/public/v1/workspaces`,
  )) as WorkspacesPayload;
  renderText(ctx, formatWorkspacesText(value), value);
};

const documentsCreate = async (
  ctx: CommandContext,
  args: string[],
  options: Record<string, OptionValue>,
) => {
  const stdinMarkdown = options.stdin === true ? await readStdin() : undefined;
  const positionalMarkdown = args.join(" ").trim();
  const markdown = stdinMarkdown ?? getStringOption(options, "markdown") ?? positionalMarkdown;
  const title = getStringOption(options, "title");
  const payload = {
    ...(title ? { title } : {}),
    ...(markdown ? { markdown } : {}),
  };

  const result = (await authorizedFetch(ctx, `${ctx.apiBaseUrl}/api/public/v1/documents`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  })) as DocumentCreatePayload;

  renderText(ctx, formatDocumentCreateText(result), result);
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

  const result = (await authorizedFetch(ctx, url.toString())) as DocumentPagePayload;
  renderText(ctx, formatDocumentsListText(result), result);
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

  const result = (await authorizedFetch(ctx, url.toString())) as DocumentGetPayload;
  renderText(ctx, formatDocumentGetText(result), result);
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
  const document =
    documentRef ??
    usageError(
      "Document ID or URL is required. Pass it positionally or with `--document`.",
      "documents edit",
    );

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
  const oldStringValue =
    oldString ??
    usageError(
      "Missing `oldString`. Pass `<oldString>`, `--old-string`, or `--old-string-stdin`.",
      "documents edit",
    );
  const newStringValue =
    newString ??
    usageError(
      "Missing `newString`. Pass `<newString>`, `--new-string`, or `--new-string-stdin`.",
      "documents edit",
    );

  const payload = {
    document,
    oldString: oldStringValue,
    newString: newStringValue,
  };

  if (options["dry-run"] === true) {
    const dryRun = {
      dryRun: true,
      command: "documents edit",
      endpoint: `${ctx.apiBaseUrl}/api/public/v1/documents/edit`,
      method: "POST",
      payload,
      note: "No changes made.",
    };
    renderText(
      ctx,
      formatDryRunText({
        command: dryRun.command,
        endpoint: dryRun.endpoint,
        method: dryRun.method,
        payload: dryRun.payload,
      }),
      dryRun,
    );
    return;
  }

  const result = (await authorizedFetch(ctx, `${ctx.apiBaseUrl}/api/public/v1/documents/edit`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  })) as DocumentMutationPayload;

  renderText(ctx, formatDocumentMutationText(result), result);
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
  const document =
    documentRef ??
    usageError(
      "Document ID or URL is required. Pass it positionally or with `--document`.",
      "documents replace",
    );

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
  const markdownValue =
    markdown ??
    usageError(
      "Replacement markdown is required. Pass `<markdown>`, `--markdown`, or `--stdin`.",
      "documents replace",
    );

  const payload = {
    document,
    markdown: markdownValue,
  };

  if (options["dry-run"] === true) {
    const dryRun = {
      dryRun: true,
      command: "documents replace",
      endpoint: `${ctx.apiBaseUrl}/api/public/v1/documents/replace`,
      method: "POST",
      payload,
      note: "No changes made.",
    };
    renderText(
      ctx,
      formatDryRunText({
        command: dryRun.command,
        endpoint: dryRun.endpoint,
        method: dryRun.method,
        payload: dryRun.payload,
      }),
      dryRun,
    );
    return;
  }

  const result = (await authorizedFetch(ctx, `${ctx.apiBaseUrl}/api/public/v1/documents/replace`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  })) as DocumentMutationPayload;

  renderText(ctx, formatDocumentMutationText(result), result);
};

const documentsExport = async (
  ctx: CommandContext,
  args: string[],
  options: Record<string, OptionValue>,
) => {
  const documentRef = args[0];
  if (!documentRef) {
    usageError("Document ID or URL is required.", "documents export");
  }

  const format = getStringOption(options, "format");
  if (format !== "markdown" && format !== "docx" && format !== "pdf") {
    usageError(
      "Export format is required and must be one of `markdown`, `docx`, or `pdf`.",
      "documents export",
    );
  }

  const url = new URL(`${ctx.apiBaseUrl}/api/public/v1/documents/export`);
  if (typeof options["workspace-scope"] === "string") {
    url.searchParams.set("workspaceScope", options["workspace-scope"]);
  }
  if (typeof options["workspace-slug"] === "string") {
    url.searchParams.set("workspaceSlug", options["workspace-slug"]);
  }

  const payload = (await authorizedFetch(ctx, url.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      document: documentRef,
      format,
    }),
  })) as ExportPayload;

  if (ctx.json) {
    render(ctx, payload);
    return;
  }

  const outputPath = getStringOption(options, "output");
  if (payload.export.format === "markdown" && !outputPath) {
    render(ctx, payload.export.text ?? "");
    return;
  }

  const writtenPath = await writeExportOutput({ payload, outputPath });
  const result = {
    exported: true as const,
    format: payload.export.format,
    path: writtenPath,
    documentId: payload.document.id,
  };
  renderText(ctx, formatExportSummaryText(result), result);
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

  const result = (await authorizedFetch(ctx, url.toString())) as SearchPayload;
  renderText(ctx, formatSearchText(result), result);
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
    const payload = { status: "logged_out" };
    renderText(ctx, "status logged_out", payload);
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

  if (command === "documents" && subcommand === "create") {
    await documentsCreate(ctx, rest, options);
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

  if (command === "documents" && subcommand === "export") {
    await documentsExport(ctx, rest, options);
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
