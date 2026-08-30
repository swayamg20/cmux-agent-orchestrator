import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PLUGIN_ID = /^[a-z]+(?:-[a-z]+)*$/;
const DISPLAY_NAME = /^[A-Za-z0-9 +()-]+$/;

async function readJson(root, relativePath, errors) {
  try {
    const source = await readFile(path.join(root, relativePath), "utf8");
    return JSON.parse(source);
  } catch (error) {
    errors.push(`${relativePath} could not be read as JSON: ${readableError(error)}`);
    return null;
  }
}

async function requireNonEmptyFile(root, relativePath, errors) {
  try {
    await access(path.join(root, relativePath));
    const details = await stat(path.join(root, relativePath));
    if (!details.isFile() || details.size === 0) errors.push(`${relativePath} must be a non-empty file.`);
  } catch {
    errors.push(`${relativePath} is required.`);
  }
}

function requireString(record, field, location, errors) {
  const value = record?.[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${location}.${field} must be a non-empty string.`);
    return "";
  }
  return value;
}

function readableError(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function validateRelease(root, expectedTag = null) {
  const errors = [];
  const [manifest, packageJson, versions] = await Promise.all([
    readJson(root, "manifest.json", errors),
    readJson(root, "package.json", errors),
    readJson(root, "versions.json", errors)
  ]);

  await Promise.all(
    ["README.md", "LICENSE", "manifest.json", "main.js", "styles.css"].map((file) =>
      requireNonEmptyFile(root, file, errors)
    )
  );

  if (manifest !== null) {
    const id = requireString(manifest, "id", "manifest", errors);
    const name = requireString(manifest, "name", "manifest", errors);
    const version = requireString(manifest, "version", "manifest", errors);
    const minAppVersion = requireString(manifest, "minAppVersion", "manifest", errors);
    const description = requireString(manifest, "description", "manifest", errors);
    requireString(manifest, "author", "manifest", errors);

    if (!PLUGIN_ID.test(id) || id.endsWith("-plugin") || id.includes("obsidian")) {
      errors.push("manifest.id must use lowercase letters and hyphens, must not contain obsidian, and must not end in plugin.");
    }
    if (!DISPLAY_NAME.test(name) || /obsidian|plugin/i.test(name)) {
      errors.push("manifest.name must use basic Latin letters, numbers, spaces, +, -, or parentheses and must not contain Obsidian or Plugin.");
    }
    if (!SEMVER.test(version)) errors.push("manifest.version must use x.y.z semantic versioning.");
    if (!SEMVER.test(minAppVersion)) errors.push("manifest.minAppVersion must use x.y.z semantic versioning.");
    if (description.length > 250 || !description.endsWith(".")) {
      errors.push("manifest.description must be at most 250 characters and end with a period.");
    }
    if (/\bobsidian\b/i.test(description)) {
      errors.push("manifest.description must not contain the redundant word Obsidian.");
    }
    if (manifest.isDesktopOnly !== true) {
      errors.push("manifest.isDesktopOnly must be true because the plugin uses Node.js APIs.");
    }
    if (expectedTag !== null && expectedTag !== version) {
      errors.push(`Release tag ${expectedTag} must exactly match manifest.version ${version}.`);
    }
    if (packageJson !== null && packageJson.version !== version) {
      errors.push("package.json and manifest.json versions must match.");
    }
    if (versions !== null && versions[version] !== minAppVersion) {
      errors.push("versions.json must map the release version to manifest.minAppVersion.");
    }
  }

  if (packageJson !== null) {
    requireString(packageJson, "name", "package", errors);
    requireString(packageJson, "version", "package", errors);
    requireString(packageJson, "license", "package", errors);
    requireString(packageJson, "author", "package", errors);
    if (packageJson.private !== true) errors.push("package.json must remain private to prevent accidental npm publication.");
    const repositoryUrl = packageJson.repository?.url;
    if (typeof repositoryUrl !== "string" || !repositoryUrl.startsWith("https://github.com/")) {
      errors.push("package.json.repository.url must point to the public GitHub repository.");
    }
  }

  return errors;
}

function parseExpectedTag(argv) {
  const index = argv.indexOf("--tag");
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value) throw new Error("--tag requires a value.");
  return value;
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedFile === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const expectedTag = parseExpectedTag(process.argv.slice(2));
  const errors = await validateRelease(root, expectedTag);
  if (errors.length > 0) {
    console.error("Release validation failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log("Release metadata and assets are valid.");
  }
}
