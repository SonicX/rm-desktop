// Scripts/sign-mac-key-server.js
const {execSync} = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const MAC_KEY_SERVER_PATH = "native/mac/MacKeyServer";
const ENTITLEMENTS_PATH = "build/entitlements.mac.plist";
const CERTIFICATE_NAME =
  "3rd Party Mac Developer Application: Yuriy Tereshchenko (U95EM6ZJRW)"; // ← Замени!

function signBinary(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`❌ Файл не найден: ${filePath}`);
    process.exit(1);
  }

  console.log(`📝 Подписываю: ${filePath}`);
  try {
    execSync(
      `codesign --sign "${CERTIFICATE_NAME}" \
       --entitlements "${ENTITLEMENTS_PATH}" \
       --options runtime \
       --force \
       "${filePath}"`,
      {stdio: "inherit"},
    );
    console.log(`✅ Успешно подписан: ${filePath}`);
  } catch (error) {
    console.error(`❌ Ошибка при подписи ${filePath}:`, error.message);
    process.exit(1);
  }
}

// Подписываем файлы
signBinary(MAC_KEY_SERVER_PATH);
