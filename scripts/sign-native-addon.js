/**
 * Signs native addon and related binaries for Windows.
 *
 * Uses the same certificate (thumbprint c105f51700d0e43bfad22a72682f2fa1974131fd)
 * as the main application and installer.
 *
 * Usage:
 *   node scripts/sign-native-addon.js                    # sign default paths
 *   node scripts/sign-native-addon.js path/to/file.node  # sign specific file
 */

const {execSync} = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CERT_THUMBPRINT = "c105f51700d0e43bfad22a72682f2fa1974131fd";
const TIMESTAMP_URL = "http://timestamp.digicert.com";
const DESCRIPTION = "Связь РМ";

function signFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`[SIGN] File not found: ${filePath}`);
    return false;
  }

  const stats = fs.statSync(filePath);
  console.log(
    `[SIGN] Signing: ${filePath} (${(stats.size / 1024).toFixed(1)} KB)`,
  );

  try {
    execSync(
      `signtool sign /sha1 ${CERT_THUMBPRINT} /fd SHA256 /t ${TIMESTAMP_URL} /d "${DESCRIPTION}" "${filePath}"`,
      {stdio: "inherit"},
    );
    console.log(`[SIGN] OK: ${path.basename(filePath)}`);
    return true;
  } catch {
    console.error(`[SIGN] FAILED: ${filePath}`);
    return false;
  }
}

function verifySignature(filePath) {
  try {
    execSync(`signtool verify /pa "${filePath}"`, {stdio: "pipe"});
    return true;
  } catch {
    return false;
  }
}

function findFiles(dir, extensions) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFiles(full, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }

  return results;
}

const projectRoot = path.resolve(__dirname, "..");
const args = process.argv.slice(2);

if (args.length > 0) {
  let allOk = true;
  for (const arg of args) {
    const resolved = path.resolve(arg);
    if (!signFile(resolved)) allOk = false;
  }

  process.exit(allOk ? 0 : 1);
}

console.log("[SIGN] Signing all native binaries in the project...\n");

const targets = [
  // Native addon in dist-electron
  path.join(projectRoot, "dist-electron", "native-addon.node"),
  path.join(projectRoot, "dist-electron", "native-addon-v3.node"),
  path.join(projectRoot, "dist-electron", "native-addon-v2.node"),
  // Source capture.node
  path.join(projectRoot, "native-addon", "win", "capture.node"),
  path.join(
    projectRoot,
    "native-addon",
    "win",
    "build",
    "Release",
    "capture.node",
  ),
  // WinKeyServer.exe
  path.join(
    projectRoot,
    "node_modules",
    "node-global-key-listener",
    "bin",
    "WinKeyServer.exe",
  ),
];

const signed = [];
const failed = [];
const skipped = [];

for (const target of targets) {
  if (!fs.existsSync(target)) {
    skipped.push(target);
    continue;
  }

  if (signFile(target)) {
    signed.push(target);
  } else {
    failed.push(target);
  }
}

// Also find any .node files inside the release output if it exists
const releaseDir = path.join(projectRoot, "release");
if (fs.existsSync(releaseDir)) {
  const releaseFiles = findFiles(releaseDir, [".node", ".exe"]);
  for (const f of releaseFiles) {
    if (signFile(f)) {
      signed.push(f);
    } else {
      failed.push(f);
    }
  }
}

console.log("\n========== SIGNING SUMMARY ==========");
console.log(`Signed:  ${signed.length}`);
console.log(`Failed:  ${failed.length}`);
console.log(`Skipped: ${skipped.length} (not found)`);

if (signed.length > 0) {
  console.log("\nSigned files:");
  for (const f of signed) {
    const verified = verifySignature(f) ? "VERIFIED" : "UNVERIFIED";
    console.log(`  [${verified}] ${path.relative(projectRoot, f)}`);
  }
}

if (failed.length > 0) {
  console.log("\nFailed files:");
  for (const f of failed) console.log(`  ${path.relative(projectRoot, f)}`);
}

if (skipped.length > 0) {
  console.log("\nSkipped (not found):");
  for (const f of skipped)
    console.log(`  ${path.relative(projectRoot, f)}`);
}

console.log("======================================\n");
process.exit(failed.length > 0 ? 1 : 0);
