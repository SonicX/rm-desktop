const { notarize } = require('electron-notarize');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

exports.default = async function notarizeMac(context) {
  console.log('Запуск скрипта notarize.js');
  console.log('electronPlatformName:', context.electronPlatformName);
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'mas') {
    console.log('Пропуск нотаризации: платформа не macOS или MAS');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  const teamId = 'U95EM6ZJRW';
  const certName = '3rd Party Mac Developer Application: Yuriy Tereshchenko (U95EM6ZJRW)';
  const inheritPlist = 'build/macEntitlements.plist';
  const entitlementsPlist = 'build/entitlements.mac.plist';

  // Подпись MacKeyServer
  const macKeyServerPath = path.join(appPath, 'Contents', 'Resources', 'bin', 'MacKeyServer');
  if (fs.existsSync(macKeyServerPath)) {
    console.log(`🔁 Подписываю: MacKeyServer`);
    const result = spawnSync('codesign', [
      '--sign', certName,
      '--entitlements', inheritPlist,
      '--options', 'runtime',
      '--timestamp',
      '--force',
      macKeyServerPath
    ], { stdio: 'inherit' });

    if (result.status !== 0) {
      throw new Error(`❌ Не удалось подписать MacKeyServer`);
    }
    console.log(`✅ Успешно подписан: MacKeyServer`);
  } else {
    console.log(`⚠️ Не найден: ${macKeyServerPath}`);
  }

  // Подпись Helper-приложений и Login Helper
  const helpers = [
    `${appName} Helper`,
    `${appName} Helper (GPU)`,
    `${appName} Helper (Plugin)`,
    `${appName} Helper (Renderer)`
  ];

  helpers.forEach(helperName => {
    const helperApp = path.join(appPath, 'Contents', 'Frameworks', `${helperName}.app`) ||
                      path.join(appPath, 'Contents', 'Library', 'LoginItems', `${helperName}.app`);
    if (fs.existsSync(helperApp)) {
      console.log(`🔁 Подписываю: ${helperName}`);
      const result = spawnSync('codesign', [
        '--sign', certName,
        '--entitlements', inheritPlist,
        '--options', 'runtime',
        '--timestamp',
        '--force',
        helperApp
      ], { stdio: 'inherit' });

      if (result.status !== 0) {
        throw new Error(`❌ Не удалось подписать ${helperName}`);
      }
      console.log(`✅ Успешно подписан: ${helperName}`);
    } else {
      console.log(`⚠️ Не найден: ${helperApp}`);
    }
  });

  const loginHelperPath = path.join(appPath, 'Contents', 'Library', 'LoginItems', `${appName} Login Helper.app`);
  if (fs.existsSync(loginHelperPath)) {
    console.log(`🔁 Подписываю: Связь РМ Login Helper`);
    const result = spawnSync('codesign', [
      '--sign', certName,
      '--entitlements', inheritPlist,
      '--options', 'runtime',
      '--timestamp',
      '--force',
      '--deep', // Добавьте --deep для рекурсивной подписи
      loginHelperPath
    ], { stdio: 'inherit' });

    if (result.status !== 0) {
      throw new Error(`❌ Не удалось подписать Связь РМ Login Helper`);
    }
    console.log(`✅ Успешно подписан: Связь РМ Login Helper`);
  } else {
    console.log(`⚠️ Не найден: ${loginHelperPath}`);
  }
// Подпись библиотек в Electron Framework
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
        '--entitlements', inheritPlist,
        '--options', 'runtime',
        '--timestamp',
        '--force',
        libPath
      ], { stdio: 'inherit' });

      if (result.status !== 0) {
        throw new Error(`❌ Не удалось подписать библиотеку ${lib}`);
      }
      console.log(`✅ Успешно подписана библиотека: ${lib}`);
    } else {
      console.log(`⚠️ Не найдена библиотека: ${libPath}`);
    }
  });

  // Подпись Electron Framework
  const electronFrameworkPath = path.join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework');
  if (fs.existsSync(electronFrameworkPath)) {
    console.log(`🔁 Подписываю: Electron Framework`);
    const result = spawnSync('codesign', [
      '--sign', certName,
      '--entitlements', inheritPlist,
      '--options', 'runtime',
      '--timestamp',
      '--force',
      '--deep',
      electronFrameworkPath
    ], { stdio: 'inherit' });

    if (result.status !== 0) {
      throw new Error(`❌ Не удалось подписать Electron Framework`);
    }
    console.log(`✅ Успешно подписан: Electron Framework`);
  } else {
    console.log(`⚠️ Не найден: ${electronFrameworkPath}`);
  }

  // Подпись основного приложения
  console.log(`🔁 Подписываю основное приложение: ${appName}`);
  const mainAppSign = spawnSync('codesign', [
    '--sign', certName,
    '--entitlements', entitlementsPlist,
    '--options', 'runtime',
    '--timestamp',
    '--force',
    '--deep',
    appPath
  ], { stdio: 'inherit' });

  if (mainAppSign.status !== 0) {
    throw new Error(`❌ Не удалось подписать основное приложение`);
  }
  console.log(`✅ Успешно подписано основное приложение: ${appName}`);

  // // Нотаризация
  // console.log('📤 Отправка на нотаризацию...');
  // try {
  //   await notarize({
  //     appBundleId: 'org.rm.rm-electron',
  //     appPath: appPath,
  //     appleId: 'suchoi34@ngs.ru',
  //     appleIdPassword: 'aqfh-ojme-wgqy-gsnk',
  //     teamId: teamId,
  //     tool: 'notarytool',
  //   });
  //   console.log('✅ Нотаризация успешна!');
  // } catch (error) {
  //   console.error('❌ Ошибка нотаризации:', error);
  //   throw error;
  // }
};