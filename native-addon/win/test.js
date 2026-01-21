const path = require("node:path");

console.log("Testing Windows Native Capture Module...");

try {
  // Пытаемся загрузить модуль
  const nativeModule = require("./build/Release/capture.node");

  // Тестируем базовый метод
  const result = nativeModule.testMethod();
  console.log("✓ Module loaded successfully");
  console.log("✓ Test method returned:", result);

  // Тестируем получение источников
  const sources = nativeModule.getAvailableSources();
  console.log(`✓ Found ${sources.length} capture sources`);

  // Проверяем наличие всех методов
  const methods = [
    "testMethod",
    "getAvailableSources",
    "startCapture",
    "stopCapture",
    "setCaptureQuality",
    "setCaptureSource",
    "setWebRTCVideoCallback",
    "setWebRTCAudioCallback",
  ];

  let allMethodsPresent = true;
  for (const method of methods) {
    if (typeof nativeModule[method] === "function") {
      console.log(`✓ Method '${method}' exists`);
    } else {
      console.log(`✗ Method '${method}' missing`);
      allMethodsPresent = false;
    }
  }

  if (allMethodsPresent) {
    console.log("\n✓ All tests passed!");
    process.exit(0);
  } else {
    console.log("\n✗ Some tests failed!");
    process.exit(1);
  }
} catch (error) {
  console.error("✗ Failed to load module:", error.message);
  console.error("Error details:", error);
  process.exit(1);
}
