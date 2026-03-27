import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, "..");
const srcDir = path.join(packageDir, "src");

const DISALLOWED_PREFIXES = ["@/", "~/", "server", "server/", "/"];
const ENV_ACCESS_PATTERN = /\bprocess\.env\b/g;

const IMPORT_PATTERN =
  /(?:import\s+(?:[^"']+?\s+from\s+)?|export\s+(?:[^"']+?\s+from\s+)?|import\s*\()\s*["']([^"']+)["']/g;

const readSourceFiles = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await readSourceFiles(absolutePath)));
      continue;
    }

    if (entry.isFile() && absolutePath.endsWith(".ts")) {
      files.push(absolutePath);
    }
  }

  return files;
};

const isDisallowedImport = (specifier) => {
  if (specifier.startsWith("node:")) {
    return false;
  }

  if (specifier.startsWith("../")) {
    return true;
  }

  return DISALLOWED_PREFIXES.some((prefix) => specifier.startsWith(prefix));
};

const main = async () => {
  const files = await readSourceFiles(srcDir);
  const violations = [];

  for (const filePath of files) {
    const source = await readFile(filePath, "utf8");
    const matches = source.matchAll(IMPORT_PATTERN);

    for (const match of matches) {
      const specifier = match[1];
      if (!specifier || !isDisallowedImport(specifier)) {
        continue;
      }

      violations.push({
        filePath,
        specifier,
      });
    }

    if (ENV_ACCESS_PATTERN.test(source)) {
      violations.push({
        filePath,
        specifier: "process.env",
      });
    }
  }

  if (violations.length === 0) {
    console.log("Publish safety check passed.");
    return;
  }

  console.error(
    "Refusing to publish nylio-cli because it uses environment variables or imports server-only/workspace-internal modules:",
  );

  for (const violation of violations) {
    console.error(`- ${path.relative(packageDir, violation.filePath)} -> ${violation.specifier}`);
  }

  process.exitCode = 1;
};

await main();
