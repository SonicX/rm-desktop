const { execSync } = require('child_process');
const path = require('path');

module.exports = async function (arg1, arg2) {
  let filePath = 'unknown';
  let options = {};

  try {
    // Отладочная информация: выводим аргументы
    console.log('arg1:', arg1);
    console.log('arg2:', arg2);

    // Проверяем, передан ли путь к файлу как первый аргумент (новый формат)
    if (typeof arg1 === 'string') {
      filePath = arg1;
      options = arg2 || {};
    }
    // Старый формат: путь к файлу в options.file
    else if (arg1 && typeof arg1 === 'object' && arg1.file) {
      filePath = arg1.file;
      options = arg1;
    }
    // Проверяем другие возможные поля
    else if (arg1 && typeof arg1 === 'object' && arg1.filePath) {
      filePath = arg1.filePath;
      options = arg1;
    }
    // Проверяем, если путь передан через options.path
    else if (arg1 && typeof arg1 === 'object' && arg1.path) {
      filePath = arg1.path;
      options = arg1;
    } else {
      throw new Error(`File path not provided. arg1: ${JSON.stringify(arg1)}, arg2: ${JSON.stringify(arg2)}`);
    }

    if (filePath.includes('__uninstaller-nsis')) {
      console.log(`Skipping signing of uninstaller: ${filePath}`);
      return;
    }

    // Вызываем sign.bat, передавая путь к файлу
    const signBatPath = path.resolve(__dirname, 'sign.bat');
    const command = `"${signBatPath}" "${filePath}"`;
    console.log(`Executing command: ${command}`);
    execSync(command, { stdio: 'inherit' });
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
