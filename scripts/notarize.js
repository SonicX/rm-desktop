const {spawnSync} = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs").promises; // Используем промисы для асинхронного поиска

const glob = require("fast-glob"); // Для поиска файлов по паттерну

exports.default = async function notarizeMac(context) {
  console.log("Запуск скрипта notarize.js");
  console.log("electronPlatformName:", context.electronPlatformName);
  const {electronPlatformName, appOutDir} = context;

  // Пропускаем подпись для не-macOS платформ
  if (electronPlatformName !== "darwin" && electronPlatformName !== "mas") {
    console.log("Пропуск подписи: платформа не macOS или MAS");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  const teamId = "U95EM6ZJRW";
  const certName =
    "3rd Party Mac Developer Application: Yuriy Tereshchenko (U95EM6ZJRW)";
  const inheritPlist = "build/macEntitlements.plist"; // Для хелперов и нативных модулей
  const entitlementsPlist = "build/entitlements.mac.plist"; // Для основного приложения и библиотек

  // Функция для подписи файла
  const signFile = (filePath, entitlements, extraArguments = []) => {
    console.log(`🔁 Подписываю: ${filePath}`);
    const arguments_ = [
      "--sign",
      certName,
      "--entitlements",
      entitlements,
      "--options",
      "runtime",
      "--timestamp",
      "--force",
      ...extraArguments,
      filePath,
    ];
    const result = spawnSync("codesign", arguments_, {stdio: "inherit"});
    if (result.status !== 0) {
      throw new Error(
        `❌ Не удалось подписать ${filePath}: ${result.stderr.toString()}`,
      );
    }

    console.log(`✅ Успешно подписан: ${filePath}`);
  };

  // 1. Поиск и подпись всех .node файлов в распакованных директориях
  const nodeFiles = await glob("**/*.node", {
    cwd: path.join(appPath, "Contents", "Resources", "app.asar.unpacked"),
    absolute: true,
  });

  for (const nodeFile of nodeFiles) {
    if (
      await fs
        .access(nodeFile)
        .then(() => true)
        .catch(() => false)
    ) {
      signFile(nodeFile, inheritPlist, ["--deep"]);
    } else {
      console.log(`⚠️ Не найден: ${nodeFile}`);
    }
  }

  // 2. Подпись MacKeyServer в node-global-key-listener
  const nodeKeyServerPath = path.join(
    appPath,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "node-global-key-listener",
    "bin",
    "MacKeyServer",
  );
  if (
    await fs
      .access(nodeKeyServerPath)
      .then(() => true)
      .catch(() => false)
  ) {
    signFile(nodeKeyServerPath, inheritPlist);
  } else {
    console.log(`⚠️ Не найден: ${nodeKeyServerPath}`);
  }

  // 3. Подпись Helper-приложений
  const helpers = [
    `${appName} Helper`,
    `${appName} Helper (GPU)`,
    `${appName} Helper (Plugin)`,
    `${appName} Helper (Renderer)`,
  ];
  for (const helperName of helpers) {
    const helperApp = path.join(
      appPath,
      "Contents",
      "Frameworks",
      `${helperName}.app`,
    );
    if (
      await fs
        .access(helperApp)
        .then(() => true)
        .catch(() => false)
    ) {
      signFile(helperApp, inheritPlist, ["--deep"]);
    } else {
      console.log(`⚠️ Не найден: ${helperApp}`);
    }
  }

  // 4. Подпись Login Helper
  const loginHelperPath = path.join(
    appPath,
    "Contents",
    "Library",
    "LoginItems",
    `${appName} Login Helper.app`,
  );
  if (
    await fs
      .access(loginHelperPath)
      .then(() => true)
      .catch(() => false)
  ) {
    signFile(loginHelperPath, inheritPlist, ["--deep"]);
  } else {
    console.log(`⚠️ Не найден: ${loginHelperPath}`);
  }

  // 5. Подпись библиотек Electron Framework
  const libraries = [
    "libEGL.dylib",
    "libvk_swiftshader.dylib",
    "libGLESv2.dylib",
    "libffmpeg.dylib",
  ];
  for (const library of libraries) {
    const libraryPath = path.join(
      appPath,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Versions",
      "A",
      "Libraries",
      library,
    );
    if (
      await fs
        .access(libraryPath)
        .then(() => true)
        .catch(() => false)
    ) {
      signFile(libraryPath, entitlementsPlist);
    } else {
      console.log(`⚠️ Не найдена библиотека: ${libraryPath}`);
    }
  }

  // 6. Подпись Electron Framework
  const electronFrameworkPath = path.join(
    appPath,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
  );
  if (
    await fs
      .access(electronFrameworkPath)
      .then(() => true)
      .catch(() => false)
  ) {
    signFile(electronFrameworkPath, entitlementsPlist, ["--deep"]);
  } else {
    console.log(`⚠️ Не найден: ${electronFrameworkPath}`);
  }

  // 7. Подпись основного приложения
  console.log(`🔁 Подписываю основное приложение: ${appName}`);
  signFile(appPath, entitlementsPlist, ["--deep"]);

  // Пропуск нотаризации для Mac App Store
  console.log("Пропуск нотаризации: сборка для Mac App Store");
};
