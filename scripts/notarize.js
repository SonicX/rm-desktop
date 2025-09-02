const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

exports.default = async function notarizeMac(context) {
  console.log('Запуск скрипта notarize.js');
  console.log('electronPlatformName:', context.electronPlatformName);
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin' && electronPlatformName !== 'mas') {
    console.log('Пропуск подписи: платформа не macOS или MAS');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  const teamId = 'U95EM6ZJRW';
  const certName = '3rd Party Mac Developer Application: Yuriy Tereshchenko (U95EM6ZJRW)';
  const inheritPlist = 'build/macEntitlements.plist'; // Изменено: используем inherit для helpers
  const entitlementsPlist = 'build/entitlements.mac.plist';

  // Подпись MacKeyServer в node-global-key-listener (inherit)
  const nodeKeyServerPath = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-global-key-listener', 'bin', 'MacKeyServer');
  if (fs.existsSync(nodeKeyServerPath)) {
    console.log(`🔁 Подписываю: node-global-key-listener MacKeyServer`);
    const result = spawnSync('codesign', [
      '--sign', certName,
      '--entitlements', inheritPlist, // Изменено: inherit для child
      '--options', 'runtime',
      '--timestamp',
      '--force',
      nodeKeyServerPath
    ], { stdio: 'inherit' });

    if (result.status !== 0) {
      throw new Error(`❌ Не удалось подписать node-global-key-listener MacKeyServer: ${result.stderr.toString()}`);
    }
    console.log(`✅ Успешно подписан: node-global-key-listener MacKeyServer`);
  } else {
    console.log(`⚠️ Не найден: ${nodeKeyServerPath}`);
  }

  // Подпись native-addon (inherit)
  const nodeNodePath = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'dist-electron', 'native-addon.node');
  if (fs.existsSync(nodeNodePath)) {
    console.log(`🔁 Подписываю: native-addon.node`);
    const result = spawnSync('codesign', [
      '--sign', certName,
      '--entitlements', inheritPlist,
      '--timestamp',
      '--force',
      '--deep',
      nodeNodePath
    ], { stdio: 'inherit' });

    if (result.status !== 0) {
      throw new Error(`❌ Не удалось подписать native-addon.node: ${result.stderr.toString()}`);
    }
    console.log(`✅ Успешно подписан: native-addon.node`);
  } else {
    console.log(`⚠️ Не найден: ${nodeNodePath}`);
  }

  // Подпись Helper-приложений (используем inherit)
  const helpers = [
    `${appName} Helper`,
    `${appName} Helper (GPU)`,
    `${appName} Helper (Plugin)`,
    `${appName} Helper (Renderer)`
  ];

  helpers.forEach(helperName => {
    const helperApp = path.join(appPath, 'Contents', 'Frameworks', `${helperName}.app`);
    if (fs.existsSync(helperApp)) {
      console.log(`🔁 Подписываю: ${helperName}`);
      const result = spawnSync('codesign', [
        '--sign', certName,
        '--entitlements', inheritPlist, // Изменено: inherit для helpers
        '--options', 'runtime',
        '--timestamp',
        '--force',
        '--deep',
        helperApp
      ], { stdio: 'inherit' });

      if (result.status !== 0) {
        throw new Error(`❌ Не удалось подписать ${helperName}: ${result.stderr.toString()}`);
      }
      console.log(`✅ Успешно подписан: ${helperName}`);
    } else {
      console.log(`⚠️ Не найден: ${helperApp}`);
    }
  });

  // Подпись Login Helper (inherit)
  const loginHelperPath = path.join(appPath, 'Contents', 'Library', 'LoginItems', `${appName} Login Helper.app`);
  if (fs.existsSync(loginHelperPath)) {
    console.log(`🔁 Подписываю: Связь РМ Login Helper`);
    const result = spawnSync('codesign', [
      '--sign', certName,
      '--entitlements', inheritPlist, // Изменено: inherit для helpers
      '--options', 'runtime',
      '--timestamp',
      '--force',
      '--deep',
      loginHelperPath
    ], { stdio: 'inherit' });

    if (result.status !== 0) {
      throw new Error(`❌ Не удалось подписать Связь РМ Login Helper: ${result.stderr.toString()}`);
    }
    console.log(`✅ Успешно подписан: Связь РМ Login Helper`);
  } else {
    console.log(`⚠️ Не найден: ${loginHelperPath}`);
  }

  // Подпись библиотек Electron Framework (используем основной entitlementsPlist)
  const libraries = [
    'libEGL.dylib',
    'libvk_swiftshader.dylib',
    'libGLESv2.dylib',
    'libffmpeg.dylib'
  ];

  libraries.forEach(lib => {
    const libPath = path.join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Libraries', lib);
    if (fs.existsSync(libPath)) {
      console.log(`🔁 Подписываю библиотеку: ${lib}`);
      const result = spawnSync('codesign', [
        '--sign', certName,
        '--entitlements', entitlementsPlist, // Основной для dylibs
        '--options', 'runtime',
        '--timestamp',
        '--force',
        libPath
      ], { stdio: 'inherit' });

      if (result.status !== 0) {
        throw new Error(`❌ Не удалось подписать библиотеку ${lib}: ${result.stderr.toString()}`);
      }
      console.log(`✅ Успешно подписана библиотека: ${lib}`);
    } else {
      console.log(`⚠️ Не найдена библиотека: ${libPath}`);
    }
  });

  // Подпись Electron Framework (основной)
  const electronFrameworkPath = path.join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework');
  if (fs.existsSync(electronFrameworkPath)) {
    console.log(`🔁 Подписываю: Electron Framework`);
    const result = spawnSync('codesign', [
      '--sign', certName,
      '--entitlements', entitlementsPlist, // Основной
      '--options', 'runtime',
      '--timestamp',
      '--force',
      '--deep',
      electronFrameworkPath
    ], { stdio: 'inherit' });

    if (result.status !== 0) {
      throw new Error(`❌ Не удалось подписать Electron Framework: ${result.stderr.toString()}`);
    }
    console.log(`✅ Успешно подписан: Electron Framework`);
  } else {
    console.log(`⚠️ Не найден: ${electronFrameworkPath}`);
  }

  // Подпись основного приложения (основной)
  console.log(`🔁 Подписываю основное приложение: ${appName}`);
  const mainAppSign = spawnSync('codesign', [
    '--sign', certName,
    '--entitlements', entitlementsPlist, // Основной
    '--options', 'runtime',
    '--timestamp',
    '--force',
    '--deep',
    appPath
  ], { stdio: 'inherit' });

  if (mainAppSign.status !== 0) {
    throw new Error(`❌ Не удалось подписать основное приложение: ${mainAppSign.stderr.toString()}`);
  }
  console.log(`✅ Успешно подписано основное приложение: ${appName}`);

  // Пропуск нотаризации для Mac App Store
  console.log('Пропуск нотаризации: сборка для Mac App Store');
};