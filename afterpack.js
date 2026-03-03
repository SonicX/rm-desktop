const fs = require("node:fs");
const path = require("node:path");
const {execSync} = require("node:child_process");

function findFiles(dir, extensions, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findFiles(fullPath, extensions, results);
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(fullPath);
    }
  }

  return results;
}

function signWindowsFile(filePath) {
  const signBat = path.resolve(__dirname, "scripts", "sign.bat");
  if (!fs.existsSync(signBat)) {
    console.error(`[afterpack] sign.bat not found: ${signBat}`);
    return false;
  }

  try {
    console.log(`[afterpack] Signing: ${filePath}`);
    execSync(`"${signBat}" "${filePath}"`, {stdio: "inherit"});
    console.log(`[afterpack] OK: ${path.basename(filePath)}`);
    return true;
  } catch {
    console.error(`[afterpack] FAILED to sign: ${filePath}`);
    return false;
  }
}

exports.default = async function (context) {
  console.log("[afterpack] Running...");

  const {appOutDir} = context;
  const platform = context.packager.platform.name;

  if (platform !== "windows") {
    console.log(`[afterpack] Skipping non-Windows platform: ${platform}`);
    return;
  }

  const appDistElectron = path.join(
    appOutDir,
    "resources",
    "app",
    "dist-electron",
  );
  const unpackedDistElectron = path.join(
    appOutDir,
    "resources",
    "app.asar.unpacked",
    "dist-electron",
  );

  const sourcePath = path.join(__dirname, "dist-electron", "native-addon.node");
  const extraResourcePath = path.join(
    appOutDir,
    "resources",
    "native-addon.node",
  );

  // -- 1. Copy native-addon.node into the packaged app --
  for (const targetDir of [appDistElectron, unpackedDistElectron]) {
    const targetPath = path.join(targetDir, "native-addon.node");

    if (fs.existsSync(sourcePath)) {
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, {recursive: true});
      }

      fs.copyFileSync(sourcePath, targetPath);
      const stats = fs.statSync(targetPath);
      console.log(
        `[afterpack] Copied native-addon.node → ${targetDir} (${stats.size} bytes)`,
      );
    } else if (fs.existsSync(extraResourcePath)) {
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, {recursive: true});
      }

      fs.copyFileSync(extraResourcePath, targetPath);
      console.log(
        `[afterpack] Copied native-addon.node from resources → ${targetDir}`,
      );
    } else {
      console.error(`[afterpack] native-addon.node not found: ${sourcePath}`);
    }
  }

  if (fs.existsSync(extraResourcePath)) {
    fs.unlinkSync(extraResourcePath);
    console.log("[afterpack] Removed duplicate from resources root");
  }

  // -- 2. Sign ALL native binaries in the packaged app --
  console.log("[afterpack] Scanning for native binaries to sign...");

  const searchRoots = [
    path.join(appOutDir, "resources", "app.asar.unpacked"),
    appDistElectron,
  ];

  const signed = [];
  const failed = [];

  for (const root of searchRoots) {
    const nativeBinaries = findFiles(root, [".node", ".exe", ".dll"]);
    for (const binary of nativeBinaries) {
      if (signWindowsFile(binary)) {
        signed.push(binary);
      } else {
        failed.push(binary);
      }
    }
  }

  console.log(
    `[afterpack] Signing complete: ${signed.length} signed, ${failed.length} failed`,
  );
  if (failed.length > 0) {
    console.error("[afterpack] Failed files:");
    for (const f of failed) {
      console.error(`  - ${f}`);
    }
  }
};
