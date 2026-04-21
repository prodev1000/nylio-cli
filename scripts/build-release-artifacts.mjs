#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageDir = path.resolve(__dirname, "..");
const packageJsonPath = path.join(packageDir, "package.json");
const releaseDir = path.join(packageDir, "dist", "release");
const stageDir = path.join(releaseDir, "stage");
const binaryName = "nylio";

const parseArgs = (argv) => {
  const values = {
    repo: process.env.GITHUB_REPOSITORY ?? "",
    tag: process.env.GITHUB_REF_NAME ?? "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") {
      values.repo = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--tag") {
      values.tag = argv[index + 1] ?? "";
      index += 1;
    }
  }

  return values;
};

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

const sha256File = async (filePath) => {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
};

const buildFormula = ({ repo, version, tag, arm64, x64 }) => `class Nylio < Formula
  desc "CLI for the Nylio public API"
  homepage "https://github.com/${repo}"
  version "${version}"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/${repo}/releases/download/${tag}/${arm64.assetName}"
      sha256 "${arm64.sha256}"
    else
      url "https://github.com/${repo}/releases/download/${tag}/${x64.assetName}"
      sha256 "${x64.sha256}"
    end
  end

  def install
    bin.install "${binaryName}"
  end

  test do
    output = shell_output("#{bin}/${binaryName} --help")
    assert_match "CLI for the Nylio public API.", output
  end
end
`;

const main = async () => {
  const { repo, tag } = parseArgs(process.argv.slice(2));
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const version = packageJson.version;
  const expectedTag = `v${version}`;

  if (!repo) {
    throw new Error("Missing --repo <owner/repo> or GITHUB_REPOSITORY.");
  }

  if (!tag) {
    throw new Error("Missing --tag <release-tag> or GITHUB_REF_NAME.");
  }

  if (tag !== expectedTag) {
    throw new Error(
      `Release tag ${tag} does not match package version ${version}. Expected ${expectedTag}.`,
    );
  }

  await rm(releaseDir, { force: true, recursive: true });
  await mkdir(stageDir, { recursive: true });

  const targets = [
    { bunTarget: "bun-darwin-arm64", suffix: "darwin-arm64" },
    { bunTarget: "bun-darwin-x64", suffix: "darwin-x64" },
  ];

  const artifacts = [];

  for (const target of targets) {
    const stageName = `nylio-cli-${version}-${target.suffix}`;
    const stagePath = path.join(stageDir, stageName);
    const outputPath = path.join(stagePath, binaryName);
    const archiveName = `${stageName}.tar.gz`;
    const archivePath = path.join(releaseDir, archiveName);

    await mkdir(stagePath, { recursive: true });

    run(
      "bun",
      [
        "build",
        "--compile",
        `--target=${target.bunTarget}`,
        `--outfile=${outputPath}`,
        "./src/index.ts",
      ],
      packageDir,
    );

    await chmod(outputPath, 0o755);

    run("tar", ["-czf", archivePath, "-C", stageDir, stageName], packageDir);

    artifacts.push({
      target: target.suffix,
      assetName: archiveName,
      assetPath: archivePath,
      sha256: await sha256File(archivePath),
    });
  }

  const checksums = artifacts
    .map((artifact) => `${artifact.sha256}  ${artifact.assetName}`)
    .join("\n");

  await writeFile(path.join(releaseDir, "SHA256SUMS"), `${checksums}\n`);

  const arm64 = artifacts.find((artifact) => artifact.target === "darwin-arm64");
  const x64 = artifacts.find((artifact) => artifact.target === "darwin-x64");

  if (!arm64 || !x64) {
    throw new Error("Missing macOS release artifacts.");
  }

  const formulaDir = path.join(releaseDir, "homebrew");
  await mkdir(formulaDir, { recursive: true });
  await writeFile(
    path.join(formulaDir, "nylio.rb"),
    buildFormula({ repo, version, tag, arm64, x64 }),
  );

  console.log(`Release artifacts written to ${releaseDir}`);
};

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
