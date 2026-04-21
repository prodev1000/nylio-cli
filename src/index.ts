#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import JSZip from "jszip";
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

type DocumentImportKind = "docx" | "odt" | "markdown" | "text" | "obsidian-vault";

type DocumentImportPayload = {
  document?: DocumentSummaryPayload;
  documents: DocumentSummaryPayload[];
  import: {
    sourceFileName: string;
    sourceFileSize: number;
    title: string | null;
    importKind: DocumentImportKind;
    importedCount: number;
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
  kind: "rich" | "markdown";
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
    target: string;
    pageMode: "document" | "pages" | "markdown";
    source?: "projection";
    markdown: string;
  };
  tabs?: Array<{
    id: string;
    title: string;
    target: string;
    markdown: string;
  }>;
  selectedTab?: {
    id: string;
    title: string;
    target: string;
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

type CommentAuthorPayload = {
  id: string | null;
  type: "user" | "assistant";
  label: string;
};

type CommentRecordPayload = {
  id: string;
  text: string | null;
  parentId: string | null;
  threadId: string;
  depth: number;
  mentionId: string | null;
  diffId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  author: CommentAuthorPayload;
};

type CommentThreadPayload = {
  id: string;
  resolved: boolean;
  comments: CommentRecordPayload[];
};

type DocumentCommentsPayload = {
  document: DocumentSummaryPayload;
  threads: CommentThreadPayload[];
};

type CommentMutationPayload = {
  applied: boolean;
  message: string;
  operation: {
    type: "comment_create" | "comment_reply" | "comment_resolve";
  };
  document: DocumentSummaryPayload;
  thread: CommentThreadPayload;
  comment?: CommentRecordPayload;
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

type CommandRegistry = Record<string, readonly string[]>;

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
  | "documents import"
  | "documents edit"
  | "documents replace"
  | "documents export"
  | "comments"
  | "comments list"
  | "comments create"
  | "comments reply"
  | "comments resolve"
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
        description: "List, fetch, import, edit, or replace documents.",
      },
      { name: "comments", description: "Read and write document comments." },
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
    options: [
      { flag: "--help", description: "Show help for the current command." },
      { flag: "--json", description: "Render machine-readable JSON output." },
      { flag: "--api-base-url <url>", description: "Override the API origin." },
    ],
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
    options: [
      { flag: "--help", description: "Show help for the current command." },
      { flag: "--json", description: "Render machine-readable JSON output." },
      { flag: "--api-base-url <url>", description: "Override the API origin." },
    ],
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
      {
        name: "import",
        description: "Import a DOCX, ODT, Markdown file, or Obsidian vault.",
      },
      { name: "edit", description: "Replace one string in a document." },
      { name: "replace", description: "Replace a document body." },
      { name: "export", description: "Export one document." },
    ],
    options: [
      { flag: "--help", description: "Show help for the current command." },
      { flag: "--json", description: "Render machine-readable JSON output." },
      { flag: "--api-base-url <url>", description: "Override the API origin." },
    ],
    examples: [
      "nylio documents list --limit 10",
      'nylio documents create --title "Draft"',
      "nylio documents get doc_123",
      "nylio documents import ./draft.docx",
      "nylio documents import ./notes.md",
      "nylio documents import ./my-vault",
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
    description:
      "Fetch a document by id or supported Nylio URL. Plain-text output shows the body first and then secondary tabs unless `--tab` is provided.",
    usage: [
      "nylio documents get <id-or-url> [--workspace-scope personal|organization] [--workspace-slug <slug>]",
      "nylio documents get <id-or-url> --tab <tab-id-or-target>",
    ],
    options: [
      {
        flag: "--tab <tab-id-or-target>",
        description:
          "Read one secondary tab by tab id or `tab.<id>` target instead of the full body-plus-tabs view.",
      },
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
      "nylio documents get doc_123 --tab appendix",
    ],
  },
  "documents import": {
    description:
      "Import one local DOCX, ODT, Markdown, or text file, or import an Obsidian vault ZIP or directory.",
    usage: ["nylio documents import <path-to-file-or-vault> [--title <title>]"],
    options: [
      {
        flag: "--title <title>",
        description:
          "Optional document title override for single-file imports. Not supported for Obsidian vault imports.",
      },
      { flag: "--json", description: "Render machine-readable JSON output." },
      { flag: "--api-base-url <url>", description: "Override the API origin." },
    ],
    examples: [
      "nylio documents import ./draft.docx",
      "nylio documents import ./notes.md",
      "nylio documents import ./vault.zip",
      "nylio documents import ./my-vault",
      'nylio documents import "./Quarterly Review.odt" --title "Quarterly Review"',
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
      {
        flag: "--old-string <value>",
        description:
          "Text to replace in the main body. Copy it verbatim from the body section of the latest `documents get` output.",
      },
      {
        flag: "--new-string <value>",
        description:
          "Replacement text for the main body. Public CLI edits do not target secondary tabs.",
      },
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
    description: "Replace the full main-body markdown of a document.",
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
        description:
          "Replacement markdown body for the main body target. Public CLI replace does not target secondary tabs.",
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
  comments: {
    description: "Comment commands.",
    usage: ["nylio comments <subcommand> [options]"],
    subcommands: [
      { name: "list", description: "List comment threads for one document." },
      { name: "create", description: "Create a top-level comment thread." },
      { name: "reply", description: "Reply to an existing comment." },
      {
        name: "resolve",
        description: "Resolve or reopen a comment thread.",
      },
    ],
    options: [
      { flag: "--help", description: "Show help for the current command." },
      { flag: "--json", description: "Render machine-readable JSON output." },
      { flag: "--api-base-url <url>", description: "Override the API origin." },
    ],
    examples: [
      "nylio comments list --document doc_123",
      'nylio comments create --document doc_123 --text "Please clarify the final decision."',
      'nylio comments reply --comment comment_123 --text "Handled in the latest revision."',
    ],
  },
  "comments list": {
    description: "List comment threads for one document with compact plain-text output.",
    usage: ["nylio comments list --document <id-or-url>"],
    options: [
      {
        flag: "--document <id-or-url>",
        description: "Document id or supported Nylio URL.",
      },
      { flag: "--json", description: "Render machine-readable JSON output." },
      { flag: "--api-base-url <url>", description: "Override the API origin." },
    ],
    examples: [
      "nylio comments list --document doc_123",
      "nylio comments list --document https://app.nylio.app/app/doc/doc_123",
    ],
  },
  "comments create": {
    description:
      "Create one top-level comment thread on a document. Use assistant mode when the comment should appear from the user's AI assistant label instead of the user.",
    usage: [
      "nylio comments create --document <id-or-url> --text <text>",
      "nylio comments create --document <id-or-url> --stdin",
    ],
    options: [
      {
        flag: "--document <id-or-url>",
        description: "Document id or supported Nylio URL.",
      },
      {
        flag: "--text <text>",
        description: "Comment body text.",
      },
      {
        flag: "--stdin",
        description: "Read comment text from stdin.",
      },
      {
        flag: "--author-mode <mode>",
        description: "Author mode: `user` or `assistant`.",
      },
      {
        flag: "--author-label <label>",
        description: "Optional assistant display label. Ignored in `user` mode.",
      },
      { flag: "--json", description: "Render machine-readable JSON output." },
      { flag: "--api-base-url <url>", description: "Override the API origin." },
    ],
    examples: [
      'nylio comments create --document doc_123 --text "Please shorten this section."',
      'nylio comments create --document doc_123 --text "I summarized the next step below." --author-mode assistant',
      "cat note.txt | nylio comments create --document doc_123 --stdin --author-mode assistant",
    ],
  },
  "comments reply": {
    description:
      "Reply to an existing comment. Use assistant mode when the reply should appear from the user's AI assistant label instead of the user.",
    usage: [
      "nylio comments reply --comment <comment-id> --text <text>",
      "nylio comments reply --comment <comment-id> --stdin",
    ],
    options: [
      {
        flag: "--comment <comment-id>",
        description: "Parent comment id to reply to.",
      },
      {
        flag: "--text <text>",
        description: "Reply body text.",
      },
      {
        flag: "--stdin",
        description: "Read reply text from stdin.",
      },
      {
        flag: "--author-mode <mode>",
        description: "Author mode: `user` or `assistant`.",
      },
      {
        flag: "--author-label <label>",
        description: "Optional assistant display label. Ignored in `user` mode.",
      },
      { flag: "--json", description: "Render machine-readable JSON output." },
      { flag: "--api-base-url <url>", description: "Override the API origin." },
    ],
    examples: [
      'nylio comments reply --comment comment_123 --text "Updated in the latest pass."',
      'printf "Handled" | nylio comments reply --comment comment_123 --stdin --author-mode assistant',
    ],
  },
  "comments resolve": {
    description:
      "Resolve or reopen a comment thread by id. Use `--open` to reopen instead of resolve.",
    usage: ["nylio comments resolve --thread <thread-id> [--open]"],
    options: [
      {
        flag: "--thread <thread-id>",
        description: "Comment thread id.",
      },
      {
        flag: "--open",
        description: "Reopen the thread instead of resolving it.",
      },
      { flag: "--json", description: "Render machine-readable JSON output." },
      { flag: "--api-base-url <url>", description: "Override the API origin." },
    ],
    examples: [
      "nylio comments resolve --thread thread_123",
      "nylio comments resolve --thread thread_123 --open",
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

const COMMAND_REGISTRY: CommandRegistry = {
  login: [],
  logout: [],
  auth: ["status"],
  whoami: [],
  workspaces: ["list"],
  documents: ["create", "list", "get", "import", "edit", "replace", "export"],
  comments: ["list", "create", "reply", "resolve"],
  search: [],
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
  "documents get": ["help", "json", "api-base-url", "workspace-scope", "workspace-slug", "tab"],
  "documents import": ["help", "json", "api-base-url", "title"],
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
  comments: ["help", "json", "api-base-url"],
  "comments list": ["help", "json", "api-base-url", "document"],
  "comments create": [
    "help",
    "json",
    "api-base-url",
    "document",
    "text",
    "stdin",
    "author-mode",
    "author-label",
  ],
  "comments reply": [
    "help",
    "json",
    "api-base-url",
    "comment",
    "text",
    "stdin",
    "author-mode",
    "author-label",
  ],
  "comments resolve": ["help", "json", "api-base-url", "thread", "open"],
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
  comment: { type: "string" },
  thread: { type: "string" },
  markdown: { type: "string" },
  format: { type: "string" },
  output: { type: "string" },
  tab: { type: "string" },
  stdin: { type: "boolean" },
  text: { type: "string" },
  "author-mode": { type: "string" },
  "author-label": { type: "string" },
  "old-string": { type: "string" },
  "new-string": { type: "string" },
  "old-string-stdin": { type: "boolean" },
  "new-string-stdin": { type: "boolean" },
  "print-url": { type: "boolean" },
  "dry-run": { type: "boolean" },
  open: { type: "boolean" },
} as const;

const levenshteinDistance = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }

  if (left.length === 0) {
    return right.length;
  }

  if (right.length === 0) {
    return left.length;
  }

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = row;

    for (let column = 1; column <= right.length; column += 1) {
      const current = previous[column] ?? 0;
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      previous[column] = Math.min((previous[column - 1] ?? 0) + 1, current + 1, diagonal + cost);
      diagonal = current;
    }
  }

  return previous[right.length] ?? Math.max(left.length, right.length);
};

const findClosestSuggestion = (input: string, candidates: readonly string[]): string | null => {
  const normalizedInput = input.trim().toLowerCase();
  if (!normalizedInput) {
    return null;
  }

  let bestCandidate: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const distance = levenshteinDistance(normalizedInput, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestCandidate = candidate;
      bestDistance = distance;
    }
  }

  if (!bestCandidate) {
    return null;
  }

  const threshold = Math.max(2, Math.ceil(bestCandidate.length / 3));
  return bestDistance <= threshold ? bestCandidate : null;
};

const formatDidYouMean = (value: string | null): string =>
  value ? `Did you mean \`${value}\`?` : "";

const buildUnknownCommandError = (positionals: string[]): string => {
  const [command, subcommand] = positionals;
  const provided = positionals.join(" ").trim();

  if (!command) {
    return ROOT_HELP;
  }

  const knownCommand = COMMAND_REGISTRY[command];
  if (!knownCommand) {
    const suggestion = findClosestSuggestion(command, Object.keys(COMMAND_REGISTRY));
    return [`Unknown command: ${provided}`, formatDidYouMean(suggestion), ROOT_HELP]
      .filter((line) => line.length > 0)
      .join("\n\n");
  }

  if (subcommand && !knownCommand.includes(subcommand)) {
    const suggestion = findClosestSuggestion(subcommand, knownCommand);
    return [
      `Unknown subcommand: ${command} ${subcommand}`,
      formatDidYouMean(suggestion ? `${command} ${suggestion}` : null),
      formatHelp(command as HelpKey),
    ]
      .filter((line) => line.length > 0)
      .join("\n\n");
  }

  return `Unknown command: ${provided}\n\n${ROOT_HELP}`;
};

const extractCommandWords = (argv: string[]): string[] => {
  const commandWords: string[] = [];

  for (const token of argv) {
    if (token.startsWith("-")) {
      break;
    }

    commandWords.push(token);
    if (commandWords.length === 2) {
      break;
    }
  }

  return commandWords;
};

const buildUnknownOptionError = (argv: string[], optionName: string): string => {
  const commandWords = extractCommandWords(argv);
  const helpKey =
    commandWords[0] === "help"
      ? resolveHelpKey(commandWords.slice(1))
      : resolveHelpKey(commandWords);
  const scopedHelpKey = helpKey ?? "root";
  const allowedOptions = COMMAND_ALLOWED_OPTIONS[scopedHelpKey].map((option) => `--${option}`);
  const suggestion = findClosestSuggestion(`--${optionName}`, allowedOptions);

  return [
    `Unknown option \`--${optionName}\` for \`${scopedHelpKey}\`.`,
    formatDidYouMean(suggestion),
    formatHelp(scopedHelpKey),
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");
};

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

    if (subcommand === "import") {
      return "documents import";
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

  if (command === "comments") {
    if (!subcommand) {
      return "comments";
    }

    if (subcommand === "list") {
      return "comments list";
    }

    if (subcommand === "create") {
      return "comments create";
    }

    if (subcommand === "reply") {
      return "comments reply";
    }

    if (subcommand === "resolve") {
      return "comments resolve";
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
    `target ${payload.content.target}`,
    `page_mode ${payload.content.pageMode}`,
    ...(payload.selectedTab ? [`tab_name ${payload.selectedTab.title}`] : []),
    ...(payload.content.source ? [`source ${payload.content.source}`] : []),
    "",
    payload.content.markdown,
    ...(payload.tabs ?? []).flatMap((tab, index) => [
      "",
      `---------- tab ${index + 1} name: ${tab.title} -----------`,
      tab.markdown,
    ]),
  ].join("\n");

const formatDocumentCreateText = (payload: DocumentCreatePayload) =>
  [
    "created true",
    `id ${payload.document.id}`,
    `title ${payload.document.title}`,
    `updated_at ${payload.document.updatedAt}`,
    `url ${payload.document.url}`,
  ].join("\n");

const formatDocumentImportText = (payload: DocumentImportPayload) =>
  payload.documents.length === 1 && payload.document
    ? [
        "imported true",
        `import_kind ${payload.import.importKind}`,
        `imported_count ${payload.import.importedCount}`,
        `id ${payload.document.id}`,
        `title ${payload.document.title}`,
        `kind ${payload.document.kind}`,
        `updated_at ${payload.document.updatedAt}`,
        `url ${payload.document.url}`,
        `source_file ${payload.import.sourceFileName}`,
        `source_size ${payload.import.sourceFileSize}`,
      ].join("\n")
    : [
        "imported true",
        `import_kind ${payload.import.importKind}`,
        `imported_count ${payload.import.importedCount}`,
        `source_file ${payload.import.sourceFileName}`,
        `source_size ${payload.import.sourceFileSize}`,
        "",
        ...(payload.documents.length > 0
          ? [
              formatTable(
                ["id", "kind", "title"],
                payload.documents.map((document) => [document.id, document.kind, document.title]),
                [28, 12, 64],
              ),
            ]
          : ["(no documents imported)"]),
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

const formatCommentsListText = (payload: DocumentCommentsPayload) =>
  [
    `id ${payload.document.id}`,
    `title ${payload.document.title}`,
    `url ${payload.document.url}`,
    "",
    ...(payload.threads.length === 0
      ? ["(no comments)"]
      : payload.threads.flatMap((thread, index) => [
          `thread ${index + 1} ${thread.id} resolved=${thread.resolved ? "true" : "false"}`,
          ...thread.comments.map((comment) => {
            const indent = "  ".repeat(comment.depth);
            const body = comment.text?.trim() || "(empty)";
            return `${indent}- ${comment.author.label}: ${body}`;
          }),
          "",
        ])),
  ]
    .join("\n")
    .trimEnd();

const formatCommentMutationText = (payload: CommentMutationPayload) => {
  const lines = [
    `operation ${payload.operation.type}`,
    `applied ${payload.applied ? "true" : "false"}`,
    `document_id ${payload.document.id}`,
    `title ${payload.document.title}`,
    `updated_at ${payload.document.updatedAt}`,
    `url ${payload.document.url}`,
    `thread_id ${payload.thread.id}`,
  ];

  if (payload.comment) {
    lines.push(`comment_id ${payload.comment.id}`);
    lines.push(`author ${payload.comment.author.label}`);
  }

  lines.push(`message ${payload.message}`);

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

const parseAuthorMode = (value: string | undefined): "user" | "assistant" => {
  if (value === undefined || value === "user") {
    return "user";
  }

  if (value === "assistant") {
    return "assistant";
  }

  throw new Error("Author mode must be `user` or `assistant`.");
};

const getImportMimeType = (filePath: string): string | undefined => {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (extension === ".odt") {
    return "application/vnd.oasis.opendocument.text";
  }
  if (
    extension === ".md" ||
    extension === ".markdown" ||
    extension === ".mdown" ||
    extension === ".mkd" ||
    extension === ".mkdn"
  ) {
    return "text/markdown";
  }
  if (extension === ".txt") {
    return "text/plain";
  }
  if (extension === ".zip") {
    return "application/zip";
  }

  return undefined;
};

const normalizeVaultZipPath = (value: string) => value.split(path.sep).join("/");

const zipVaultDirectory = async (
  directoryPath: string,
): Promise<{ bytes: Buffer; fileName: string }> => {
  const zip = new JSZip();

  const addDirectory = async (currentPath: string, relativePath: string) => {
    const entries = await readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absoluteChildPath = path.join(currentPath, entry.name);
      const relativeChildPath = relativePath ? path.join(relativePath, entry.name) : entry.name;

      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        await addDirectory(absoluteChildPath, relativeChildPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      zip.file(normalizeVaultZipPath(relativeChildPath), await readFile(absoluteChildPath));
    }
  };

  await addDirectory(directoryPath, "");

  return {
    bytes: await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    }),
    fileName: `${path.basename(directoryPath)}.zip`,
  };
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
  if (typeof options.tab === "string") {
    url.searchParams.set("tab", options.tab);
  }
  if (typeof options["workspace-scope"] === "string") {
    url.searchParams.set("workspaceScope", options["workspace-scope"]);
  }
  if (typeof options["workspace-slug"] === "string") {
    url.searchParams.set("workspaceSlug", options["workspace-slug"]);
  }

  const result = (await authorizedFetch(ctx, url.toString())) as DocumentGetPayload;
  renderText(ctx, formatDocumentGetText(result), result);
};

const documentsImport = async (
  ctx: CommandContext,
  args: string[],
  options: Record<string, OptionValue>,
) => {
  const sourcePath = args.join(" ").trim();
  if (!sourcePath) {
    usageError("File or directory path is required.", "documents import");
  }

  const resolvedPath = path.resolve(sourcePath);
  const sourceStats = await stat(resolvedPath);
  const title = getStringOption(options, "title");

  let fileBytes: Uint8Array;
  let fileName: string;
  let mimeType: string | undefined;

  if (sourceStats.isDirectory()) {
    if (title) {
      usageError(
        "Title overrides are not supported for Obsidian vault imports.",
        "documents import",
      );
    }

    const zippedVault = await zipVaultDirectory(resolvedPath);
    fileBytes = zippedVault.bytes;
    fileName = zippedVault.fileName;
    mimeType = "application/zip";
  } else {
    fileBytes = await readFile(resolvedPath);
    fileName = path.basename(resolvedPath);
    mimeType = getImportMimeType(fileName);
    if (mimeType === "application/zip" && title) {
      usageError(
        "Title overrides are not supported for Obsidian vault imports.",
        "documents import",
      );
    }
  }

  const formData = new FormData();
  formData.append(
    "file",
    new Blob([Buffer.from(fileBytes)], {
      ...(mimeType ? { type: mimeType } : {}),
    }),
    fileName,
  );

  if (title) {
    formData.append("title", title);
  }

  const result = (await authorizedFetch(ctx, `${ctx.apiBaseUrl}/api/public/v1/documents/import`, {
    method: "POST",
    body: formData,
  })) as DocumentImportPayload;

  renderText(ctx, formatDocumentImportText(result), result);
};

const commentsList = async (
  ctx: CommandContext,
  _args: string[],
  options: Record<string, OptionValue>,
) => {
  const documentRef = getStringOption(options, "document");
  if (!documentRef) {
    usageError("Document ID or URL is required.", "comments list");
  }

  const documentId = resolveDocumentRef(
    documentRef ?? usageError("Document ID or URL is required.", "comments list"),
  );
  const url = new URL(`${ctx.apiBaseUrl}/api/public/v1/documents/${documentId}/comments`);
  const result = (await authorizedFetch(ctx, url.toString())) as DocumentCommentsPayload;
  renderText(ctx, formatCommentsListText(result), result);
};

const commentsCreate = async (
  ctx: CommandContext,
  _args: string[],
  options: Record<string, OptionValue>,
) => {
  const documentRef = getStringOption(options, "document");
  if (!documentRef) {
    usageError("Document ID or URL is required.", "comments create");
  }

  if (options.stdin === true && typeof options.text === "string") {
    usageError("Use either `--text` or `--stdin`, not both.", "comments create");
  }

  const stdinText = options.stdin === true ? await readStdin() : undefined;
  const text = stdinText ?? getStringOption(options, "text");
  if (!text) {
    usageError("Comment text is required. Pass `--text` or `--stdin`.", "comments create");
  }

  const payload = {
    document: resolveDocumentRef(
      documentRef ?? usageError("Document ID or URL is required.", "comments create"),
    ),
    text:
      text ??
      usageError("Comment text is required. Pass `--text` or `--stdin`.", "comments create"),
    authorMode: parseAuthorMode(getStringOption(options, "author-mode")),
    ...(typeof options["author-label"] === "string"
      ? { authorLabel: options["author-label"] }
      : {}),
  };

  const result = (await authorizedFetch(ctx, `${ctx.apiBaseUrl}/api/public/v1/comments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  })) as CommentMutationPayload;

  renderText(ctx, formatCommentMutationText(result), result);
};

const commentsReply = async (
  ctx: CommandContext,
  _args: string[],
  options: Record<string, OptionValue>,
) => {
  const commentId = getStringOption(options, "comment");
  if (!commentId) {
    usageError("Parent comment id is required.", "comments reply");
  }

  if (options.stdin === true && typeof options.text === "string") {
    usageError("Use either `--text` or `--stdin`, not both.", "comments reply");
  }

  const stdinText = options.stdin === true ? await readStdin() : undefined;
  const text = stdinText ?? getStringOption(options, "text");
  if (!text) {
    usageError("Reply text is required. Pass `--text` or `--stdin`.", "comments reply");
  }

  const payload = {
    commentId: commentId ?? usageError("Parent comment id is required.", "comments reply"),
    text:
      text ?? usageError("Reply text is required. Pass `--text` or `--stdin`.", "comments reply"),
    authorMode: parseAuthorMode(getStringOption(options, "author-mode")),
    ...(typeof options["author-label"] === "string"
      ? { authorLabel: options["author-label"] }
      : {}),
  };

  const result = (await authorizedFetch(ctx, `${ctx.apiBaseUrl}/api/public/v1/comments/reply`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  })) as CommentMutationPayload;

  renderText(ctx, formatCommentMutationText(result), result);
};

const commentsResolve = async (
  ctx: CommandContext,
  _args: string[],
  options: Record<string, OptionValue>,
) => {
  const threadId = getStringOption(options, "thread");
  if (!threadId) {
    usageError("Thread id is required.", "comments resolve");
  }

  const payload = {
    threadId: threadId ?? usageError("Thread id is required.", "comments resolve"),
    resolved: options.open !== true,
  };

  const result = (await authorizedFetch(ctx, `${ctx.apiBaseUrl}/api/public/v1/comments/resolve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  })) as CommentMutationPayload;

  renderText(ctx, formatCommentMutationText(result), result);
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
    const unknownOptionMatch = message.match(/Unknown option '--([^']+)'/);
    if (unknownOptionMatch?.[1]) {
      throw new Error(buildUnknownOptionError(argv, unknownOptionMatch[1]));
    }

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
      throw new Error(
        buildUnknownCommandError(command === "help" ? positionals.slice(1) : positionals),
      );
    }

    render(ctx, formatHelp(helpKey));
    return;
  }

  if (!helpKey) {
    throw new Error(buildUnknownCommandError(positionals));
  }

  validateAllowedOptions(helpKey, options);

  if (
    helpKey === "auth" ||
    helpKey === "workspaces" ||
    helpKey === "documents" ||
    helpKey === "comments"
  ) {
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

  if (command === "documents" && subcommand === "import") {
    await documentsImport(ctx, rest, options);
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

  if (command === "comments" && subcommand === "list") {
    await commentsList(ctx, rest, options);
    return;
  }

  if (command === "comments" && subcommand === "create") {
    await commentsCreate(ctx, rest, options);
    return;
  }

  if (command === "comments" && subcommand === "reply") {
    await commentsReply(ctx, rest, options);
    return;
  }

  if (command === "comments" && subcommand === "resolve") {
    await commentsResolve(ctx, rest, options);
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

  throw new Error(buildUnknownCommandError(positionals));
};

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
