// scripts/sign-mac-key-server.js
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const MAC_KEY_SERVER_PATH = 'native/mac/MacKeyServer';
const ENTITLEMENTS_PATH = 'build/entitlements.mac.plist';
const CERTIFICATE_NAME = '3rd Party Mac Developer Application: Yuriy Tereshchenko (U95EM6ZJRW)'; // ← Замени!

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
      { stdio: 'inherit' }
    );
    console.log(`✅ Успешно подписан: ${filePath}`);
  } catch (error) {
    console.error(`❌ Ошибка при подписи ${filePath}:`, error.message);
    process.exit(1);
  }
}

// Подписываем файлы
signBinary(MAC_KEY_SERVER_PATH);