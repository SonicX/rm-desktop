const {execSync} = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

console.log("🔍 Checking addon architecture...");

const addonPath = path.join(__dirname, "..", "addon.node");

if (!fs.existsSync(addonPath)) {
  console.log("⚠️ addon.node not found, will be built during installation");
  process.exit(0);
}

try {
  const result = execSync(`lipo -info ${addonPath}`, {encoding: "utf8"});
  console.log("📋 Architecture info:", result.trim());

  if (result.includes("x86_64") && result.includes("arm64")) {
    console.log("✅ Universal Binary detected (Intel + Apple Silicon)");
  } else if (result.includes("x86_64")) {
    console.log("⚠️ Intel-only binary detected");
    console.log('💡 Run "npm run build:universal" to create Universal Binary');
  } else if (result.includes("arm64")) {
    console.log("⚠️ Apple Silicon-only binary detected");
    console.log('💡 Run "npm run build:universal" to create Universal Binary');
  }

  // Проверяем текущую архитектуру системы
  const {arch} = process;
  const {platform} = process;
  console.log(`🖥️ Current system: ${platform} ${arch}`);

  // Проверяем совместимость
  if (platform === "darwin") {
    if (arch === "x64" && !result.includes("x86_64")) {
      console.log("❌ Warning: Binary not compatible with Intel Mac");
      process.exit(1);
    } else if (arch === "arm64" && !result.includes("arm64")) {
      console.log("❌ Warning: Binary not compatible with Apple Silicon Mac");
      process.exit(1);
    }
  }
} catch (error) {
  console.error("❌ Error checking architecture:", error.message);
}
