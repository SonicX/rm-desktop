const {execSync} = require("node:child_process");
const path = require("node:path");

module.exports = async function (argument1, argument2) {
  let filePath = "unknown";
  let options = {};

  try {
    // Отладочная информация: выводим аргументы
    console.log("arg1:", argument1);
    console.log("arg2:", argument2);

    // Проверяем, передан ли путь к файлу как первый аргумент (новый формат)
    if (typeof argument1 === "string") {
      filePath = argument1;
      options = argument2 || {};
    }
    // Старый формат: путь к файлу в options.file
    else if (argument1 && typeof argument1 === "object" && argument1.file) {
      filePath = argument1.file;
      options = argument1;
    }
    // Проверяем другие возможные поля
    else if (argument1 && typeof argument1 === "object" && argument1.filePath) {
      filePath = argument1.filePath;
      options = argument1;
    }
    // Проверяем, если путь передан через options.path
    else if (argument1 && typeof argument1 === "object" && argument1.path) {
      filePath = argument1.path;
      options = argument1;
    } else {
      throw new Error(
        `File path not provided. arg1: ${JSON.stringify(argument1)}, arg2: ${JSON.stringify(argument2)}`,
      );
    }

    if (filePath.includes("__uninstaller-nsis")) {
      console.log(`Skipping signing of uninstaller: ${filePath}`);
      return;
    }

    // Вызываем sign.bat, передавая путь к файлу
    const signBatPath = path.resolve(__dirname, "sign.bat");
    const command = `"${signBatPath}" "${filePath}"`;
    console.log(`Executing command: ${command}`);
    execSync(command, {stdio: "inherit"});
    console.log(`Successfully signed: ${filePath}`);

    // Дополнительно можно использовать options
    if (options.platform) {
      console.log(`Platform: ${options.platform}`);
    }

    if (options.arch) {
      console.log(`Architecture: ${options.arch}`);
    }
  } catch (error) {
    console.error(`Failed to sign ${filePath}: ${error.message}`);
    throw error;
  }
};
