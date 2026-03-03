/**
 * Verifies digital signatures on all release artifacts.
 * Run after dist-win to ensure everything is properly signed.
 *
 * Usage: node scripts/verify-signatures.js
 */

const {execSync} = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

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

function verifySignature(filePath) {
  try {
    const output = execSync(`signtool verify /pa /v "${filePath}"`, {
      stdio: "pipe",
      encoding: "utf-8",
    });
    const hasSignature = output.includes("Successfully verified");
    return {signed: hasSignature, error: null};
  } catch (error) {
    return {signed: false, error: error.stderr || error.message};
  }
}

const projectRoot = path.resolve(__dirname, "..");
const releaseDir = path.join(projectRoot, "release");

console.log("========== SIGNATURE VERIFICATION ==========\n");

const results = {signed: [], unsigned: [], missing: []};

// 1. Check release directory (installers)
if (fs.existsSync(releaseDir)) {
  const installers = findFiles(releaseDir, [".exe", ".msi"]);
  console.log(`Found ${installers.length} installer(s) in release/\n`);

  for (const file of installers) {
    const rel = path.relative(projectRoot, file);
    const {signed} = verifySignature(file);
    if (signed) {
      console.log(`  [OK]   ${rel}`);
      results.signed.push(rel);
    } else {
      console.log(`  [FAIL] ${rel}`);
      results.unsigned.push(rel);
    }
  }
} else {
  console.log("No release/ directory found (run dist-win first)");
}

// 2. Check unpacked app binaries
const unpackedDirs = [];
if (fs.existsSync(path.join(releaseDir))) {
  const winUnpacked = findFiles(releaseDir, []).filter((f) =>
    f.includes("win-unpacked"),
  );
  if (winUnpacked.length === 0) {
    const dirEntries = fs.existsSync(releaseDir)
      ? fs.readdirSync(releaseDir)
      : [];
    for (const entry of dirEntries) {
      const full = path.join(releaseDir, entry);
      if (
        fs.statSync(full).isDirectory() &&
        entry.toLowerCase().includes("win")
      ) {
        unpackedDirs.push(full);
      }
    }
  }
}

for (const dir of unpackedDirs) {
  const binaries = findFiles(dir, [".exe", ".dll", ".node"]);
  console.log(
    `\nFound ${binaries.length} binary(ies) in ${path.relative(projectRoot, dir)}/\n`,
  );

  for (const file of binaries) {
    const rel = path.relative(projectRoot, file);
    const {signed} = verifySignature(file);
    if (signed) {
      console.log(`  [OK]   ${rel}`);
      results.signed.push(rel);
    } else {
      console.log(`  [FAIL] ${rel}`);
      results.unsigned.push(rel);
    }
  }
}

// 3. Check pre-build addon
const preBuiltPaths = [
  path.join(projectRoot, "dist-electron", "native-addon.node"),
  path.join(projectRoot, "native-addon", "win", "capture.node"),
];

console.log("\nPre-build addon files:\n");
for (const file of preBuiltPaths) {
  const rel = path.relative(projectRoot, file);
  if (!fs.existsSync(file)) {
    console.log(`  [SKIP] ${rel} (not found)`);
    results.missing.push(rel);
    continue;
  }

  const {signed} = verifySignature(file);
  if (signed) {
    console.log(`  [OK]   ${rel}`);
    results.signed.push(rel);
  } else {
    console.log(`  [FAIL] ${rel}`);
    results.unsigned.push(rel);
  }
}

// Summary
console.log("\n========== SUMMARY ==========");
console.log(`Signed:   ${results.signed.length}`);
console.log(`Unsigned: ${results.unsigned.length}`);
console.log(`Missing:  ${results.missing.length}`);
console.log("=============================\n");

if (results.unsigned.length > 0) {
  console.error("UNSIGNED files detected! Run: npm run sign-addon");
  process.exit(1);
}

console.log("All found artifacts are properly signed.");
process.exit(0);
