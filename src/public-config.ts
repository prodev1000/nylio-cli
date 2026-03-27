const normalizeBaseUrl = (value: string | undefined): string | null => {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
};

export const DEFAULT_API_BASE_URL = "https://api.nylio.app";

export const CLI_CLIENT_ID = "nylio-cli";

export const PUBLIC_SCOPE = {
  workspaceRead: "workspace:read",
  documentRead: "document:read",
  documentWrite: "document:write",
  searchRead: "search:read",
} as const;

export const buildPublicApiConfig = (baseUrl: string) => {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  if (!normalizedBaseUrl) {
    throw new Error(`Invalid API base URL: ${baseUrl}`);
  }

  return {
    apiBaseUrl: normalizedBaseUrl,
    issuer: `${normalizedBaseUrl}/api/auth`,
    publicApiAudience: `${normalizedBaseUrl}/api/public/v1`,
  };
};
