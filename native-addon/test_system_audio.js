// Test_audio_diagnostic.js
// Тестовый файл для полной диагностики звукового потока от нативного плагина
// Исключает любые неоднозначные выводы о пустых буферах

const fs = require("node:fs");
const path = require("node:path");

const nativeCapture = require("../dist-electron/native-addon.node");

console.log(
  "================================================================================",
);
console.log("ПОЛНАЯ ДИАГНОСТИКА АУДИО ПОТОКА ОТ НАТИВНОГО ПЛАГИНА");
console.log(
  "================================================================================\n",
);

// Проверяем модуль
try {
  const testResult = nativeCapture.testMethod();
  console.log("✓ Модуль загружен:", testResult);
} catch (error) {
  console.error("✗ Ошибка загрузки модуля:", error);
  process.exit(1);
}

// Глобальные счетчики и статистика
const stats = {
  totalFrames: 0,
  nonZeroFrames: 0,
  zeroFrames: 0,
  totalSamples: 0,
  totalBytes: 0,
  maxAmplitude: 0,
  minAmplitude: 0,
  avgAmplitude: 0,
  startTime: Date.now(),
  lastReportTime: Date.now(),

  // Детальная статистика по амплитудам
  amplitudeRanges: {
    zero: 0, // == 0
    tiny: 0, // 0 < x < 0.0001
    quiet: 0, // 0.0001 <= x < 0.01
    normal: 0, // 0.01 <= x < 0.1
    loud: 0, // 0.1 <= x < 0.5
    veryLoud: 0, // >= 0.5
  },

  // Буфер для записи RAW данных для анализа
  rawDataSamples: [],
  maxRawSamples: 1000, // Сохраняем первые 1000 сэмплов для анализа
};

// Функция для анализа аудио буфера
function analyzeAudioBuffer(data, sampleRate, channels, numberSamples) {
  if (!data || !data.byteLength) {
    return {
      isValid: false,
      reason: "No data or zero byteLength",
      byteLength: 0,
    };
  }

  const float32Array = new Float32Array(data);
  const expectedSamples = numberSamples * channels;

  // Базовая проверка
  const analysis = {
    isValid: true,
    byteLength: data.byteLength,
    expectedBytes: expectedSamples * 4,
    actualSamples: float32Array.length,
    expectedSamples,
    matches: float32Array.length === expectedSamples,

    // Статистика амплитуд
    maxAmplitude: 0,
    minAmplitude: 0,
    avgAmplitude: 0,
    nonZeroCount: 0,
    zeroCount: 0,

    // Первые и последние сэмплы для диагностики
    firstSamples: [],
    lastSamples: [],

    // Проверка на паттерны
    hasPattern: false,
    patternType: "none",
  };

  // Анализируем каждый сэмпл
  let sum = 0;
  for (let i = 0; i < float32Array.length; i++) {
    const sample = float32Array[i];
    const absSample = Math.abs(sample);

    // Обновляем статистику
    if (absSample > analysis.maxAmplitude) analysis.maxAmplitude = absSample;
    if (i === 0 || absSample < analysis.minAmplitude)
      analysis.minAmplitude = absSample;
    sum += absSample;

    // Считаем нули
    if (absSample === 0) {
      analysis.zeroCount++;
    } else if (absSample > 0.000_01) {
      analysis.nonZeroCount++;
    }

    // Сохраняем первые 10 сэмплов
    if (i < 10) {
      analysis.firstSamples.push(sample);
    }

    // Сохраняем последние 10 сэмплов
    if (i >= float32Array.length - 10) {
      analysis.lastSamples.push(sample);
    }

    // Сохраняем для глобального анализа
    if (stats.rawDataSamples.length < stats.maxRawSamples) {
      stats.rawDataSamples.push(sample);
    }

    // Обновляем распределение амплитуд
    if (absSample === 0) {
      stats.amplitudeRanges.zero++;
    } else if (absSample < 0.0001) {
      stats.amplitudeRanges.tiny++;
    } else if (absSample < 0.01) {
      stats.amplitudeRanges.quiet++;
    } else if (absSample < 0.1) {
      stats.amplitudeRanges.normal++;
    } else if (absSample < 0.5) {
      stats.amplitudeRanges.loud++;
    } else {
      stats.amplitudeRanges.veryLoud++;
    }
  }

  analysis.avgAmplitude =
    float32Array.length > 0 ? sum / float32Array.length : 0;

  // Проверяем на известные паттерны
  if (analysis.zeroCount === float32Array.length) {
    analysis.patternType = "all_zeros";
  } else if (analysis.nonZeroCount === float32Array.length) {
    analysis.patternType = "all_non_zero";
    analysis.hasPattern = true;
  } else if (analysis.nonZeroCount > 0) {
    analysis.patternType = "mixed";
    analysis.hasPattern = true;
  }

  // Проверяем на синусоиду (тестовый сигнал)
  const isSine = checkForSineWave(float32Array);
  if (isSine) {
    analysis.patternType = "sine_wave_test_signal";
    analysis.hasPattern = true;
  }

  return analysis;
}

// Проверка на синусоидальный паттерн
function checkForSineWave(samples) {
  if (samples.length < 100) return false;

  let zeroCrossings = 0;
  let lastSign = Math.sign(samples[0]);

  for (let i = 1; i < Math.min(samples.length, 1000); i++) {
    const currentSign = Math.sign(samples[i]);
    if (currentSign !== lastSign && currentSign !== 0) {
      zeroCrossings++;
      lastSign = currentSign;
    }
  }

  // Если есть регулярные пересечения нуля - возможно синусоида
  return zeroCrossings > 10 && zeroCrossings < 100;
}

// Функция для вывода детального отчета
function printDetailedReport() {
  const elapsed = (Date.now() - stats.startTime) / 1000;

  console.log(
    "\n================================================================================",
  );
  console.log("ДЕТАЛЬНЫЙ ОТЧЕТ (время: " + elapsed.toFixed(1) + " сек)");
  console.log(
    "================================================================================",
  );

  console.log("\n📊 ОСНОВНАЯ СТАТИСТИКА:");
  console.log(`  • Всего фреймов: ${stats.totalFrames}`);
  console.log(
    `  • Фреймов с данными: ${stats.nonZeroFrames} (${((stats.nonZeroFrames / stats.totalFrames) * 100).toFixed(1)}%)`,
  );
  console.log(
    `  • Пустых фреймов: ${stats.zeroFrames} (${((stats.zeroFrames / stats.totalFrames) * 100).toFixed(1)}%)`,
  );
  console.log(`  • Всего сэмплов: ${stats.totalSamples}`);
  console.log(`  • Всего байт: ${stats.totalBytes}`);

  console.log("\n📈 АМПЛИТУДЫ:");
  console.log(`  • Максимальная: ${stats.maxAmplitude.toFixed(6)}`);
  console.log(`  • Средняя: ${stats.avgAmplitude.toFixed(6)}`);
  console.log(`  • Минимальная: ${stats.minAmplitude.toFixed(6)}`);

  console.log("\n📊 РАСПРЕДЕЛЕНИЕ АМПЛИТУД:");
  const total = Object.values(stats.amplitudeRanges).reduce((a, b) => a + b, 0);
  if (total > 0) {
    console.log(
      `  • Нулевые (= 0): ${stats.amplitudeRanges.zero} (${((stats.amplitudeRanges.zero / total) * 100).toFixed(1)}%)`,
    );
    console.log(
      `  • Крайне тихие (< 0.0001): ${stats.amplitudeRanges.tiny} (${((stats.amplitudeRanges.tiny / total) * 100).toFixed(1)}%)`,
    );
    console.log(
      `  • Тихие (0.0001-0.01): ${stats.amplitudeRanges.quiet} (${((stats.amplitudeRanges.quiet / total) * 100).toFixed(1)}%)`,
    );
    console.log(
      `  • Нормальные (0.01-0.1): ${stats.amplitudeRanges.normal} (${((stats.amplitudeRanges.normal / total) * 100).toFixed(1)}%)`,
    );
    console.log(
      `  • Громкие (0.1-0.5): ${stats.amplitudeRanges.loud} (${((stats.amplitudeRanges.loud / total) * 100).toFixed(1)}%)`,
    );
    console.log(
      `  • Очень громкие (>= 0.5): ${stats.amplitudeRanges.veryLoud} (${((stats.amplitudeRanges.veryLoud / total) * 100).toFixed(1)}%)`,
    );
  }

  // Анализ первых сэмплов
  if (stats.rawDataSamples.length > 0) {
    console.log("\n🔍 АНАЛИЗ ПЕРВЫХ 20 СЭМПЛОВ:");
    const first20 = stats.rawDataSamples.slice(0, 20);
    console.log("  " + first20.map((s) => s.toFixed(4)).join(", "));

    // Проверяем на паттерны
    const allZeros = first20.every((s) => s === 0);
    const hasData = first20.some((s) => Math.abs(s) > 0.0001);

    if (allZeros) {
      console.log("  ⚠️ ВСЕ ПЕРВЫЕ СЭМПЛЫ НУЛЕВЫЕ!");
    } else if (hasData) {
      console.log("  ✓ Обнаружены ненулевые данные");
    }
  }

  console.log("\n💡 ДИАГНОЗ:");
  if (stats.totalFrames === 0) {
    console.log("  ❌ Не получено ни одного фрейма от плагина");
  } else if (stats.zeroFrames === stats.totalFrames) {
    console.log("  ❌ ВСЕ ФРЕЙМЫ ПУСТЫЕ - плагин отправляет нулевые буферы");
    console.log("  💡 Возможные причины:");
    console.log("     1. Приложение не воспроизводит звук");
    console.log("     2. Неверный ProcessID для целевого приложения");
    console.log("     3. Проблема с WASAPI loopback capture");
    console.log("     4. Приложение использует эксклюзивный режим аудио");
  } else if (stats.nonZeroFrames > 0) {
    console.log(
      "  ✅ ПЛАГИН РАБОТАЕТ - получены данные с ненулевой амплитудой",
    );
    console.log(
      `  📊 Качество сигнала: ${((stats.nonZeroFrames / stats.totalFrames) * 100).toFixed(1)}% фреймов содержат данные`,
    );
  } else {
    console.log(
      "  ⚠️ Неопределенное состояние - требуется дополнительная диагностика",
    );
  }
}

// ГЛАВНАЯ ФУНКЦИЯ ЗАПУСКА
function startDiagnostic() {
  console.log("\n🚀 ЗАПУСК ДИАГНОСТИКИ...\n");

  // ХАРДКОДИМ окно для теста
  const hardcodedWindow = {
    type: "window",
    id: "263016", // Можете заменить на ваш ID окна
    name: "Test Window (hardcoded)",
    width: 1920,
    height: 1080,
  };

  console.log("📌 Используем захардкоженное окно:", hardcodedWindow.name);
  console.log("   ID:", hardcodedWindow.id);

  // Устанавливаем источник
  nativeCapture.setCaptureSource(hardcodedWindow);

  // Устанавливаем качество
  nativeCapture.setCaptureQuality({
    width: 1920,
    height: 1080,
    fps: 30,
  });

  // Счетчик для периодических отчетов
  let frameCounter = 0;

  // Устанавливаем callback для аудио с максимальной диагностикой
  nativeCapture.setWebRTCAudioCallback((audioData) => {
    frameCounter++;
    stats.totalFrames++;

    // Полный анализ каждого фрейма
    const analysis = analyzeAudioBuffer(
      audioData.data,
      audioData.sampleRate,
      audioData.channels,
      audioData.numSamples,
    );

    // Обновляем глобальную статистику
    if (analysis.maxAmplitude > 0.0001) {
      stats.nonZeroFrames++;
    } else {
      stats.zeroFrames++;
    }

    stats.totalSamples += audioData.numSamples * audioData.channels;
    stats.totalBytes += audioData.dataSize || 0;

    if (analysis.maxAmplitude > stats.maxAmplitude) {
      stats.maxAmplitude = analysis.maxAmplitude;
    }

    // Обновляем среднюю амплитуду
    stats.avgAmplitude =
      (stats.avgAmplitude * (stats.totalFrames - 1) + analysis.avgAmplitude) /
      stats.totalFrames;

    // Выводим информацию о первых 5 фреймах детально
    if (frameCounter <= 5) {
      console.log(`\n━━━ ФРЕЙМ #${frameCounter} (ДЕТАЛЬНЫЙ АНАЛИЗ) ━━━`);
      console.log(
        `Источник: ${audioData.applicationName || audioData.source || "unknown"}`,
      );
      console.log(
        `Параметры: ${audioData.sampleRate}Hz, ${audioData.channels}ch, ${audioData.numSamples} samples`,
      );
      console.log(
        `Размер данных: ${analysis.byteLength} байт (ожидалось: ${analysis.expectedBytes})`,
      );
      console.log(
        `Амплитуды: max=${analysis.maxAmplitude.toFixed(6)}, avg=${analysis.avgAmplitude.toFixed(6)}`,
      );
      console.log(
        `Ненулевых сэмплов: ${analysis.nonZeroCount}/${analysis.actualSamples}`,
      );
      console.log(`Паттерн: ${analysis.patternType}`);

      if (analysis.firstSamples.length > 0) {
        console.log(
          `Первые сэмплы: [${analysis.firstSamples
            .slice(0, 5)
            .map((s) => s.toFixed(4))
            .join(", ")}...]`,
        );
      }

      if (analysis.maxAmplitude === 0) {
        console.log("⚠️ ВНИМАНИЕ: Фрейм полностью пустой (все нули)!");
      } else if (analysis.maxAmplitude < 0.0001) {
        console.log("⚠️ ВНИМАНИЕ: Крайне низкая амплитуда!");
      } else {
        console.log("✓ Фрейм содержит валидные аудио данные");
      }
    }

    // Каждые 100 фреймов выводим сводку
    if (frameCounter % 100 === 0) {
      console.log(`\n📊 Промежуточный отчет (${frameCounter} фреймов):`);
      console.log(
        `   • С данными: ${stats.nonZeroFrames} (${((stats.nonZeroFrames / stats.totalFrames) * 100).toFixed(1)}%)`,
      );
      console.log(
        `   • Пустых: ${stats.zeroFrames} (${((stats.zeroFrames / stats.totalFrames) * 100).toFixed(1)}%)`,
      );
      console.log(`   • Макс. амплитуда: ${stats.maxAmplitude.toFixed(6)}`);
      console.log(`   • Средняя амплитуда: ${stats.avgAmplitude.toFixed(6)}`);
    }
  });

  // Запускаем захват
  console.log("\n🎬 Запуск захвата...");
  const result = nativeCapture.startCapture();

  if (result.success) {
    console.log("✅ Захват запущен успешно");
    console.log(`   Сообщение: ${result.message}`);

    console.log(
      "\n================================================================================",
    );
    console.log("ДИАГНОСТИКА АКТИВНА");
    console.log(
      "--------------------------------------------------------------------------------",
    );
    console.log("• Детальный анализ первых 5 фреймов");
    console.log("• Промежуточные отчеты каждые 100 фреймов");
    console.log("• Полный отчет при завершении");
    console.log("");
    console.log("⚠️ ВАЖНО: Убедитесь что в целевом окне воспроизводится звук!");
    console.log("");
    console.log("Нажмите Ctrl+C для остановки и получения полного отчета...");
    console.log(
      "================================================================================\n",
    );

    // Обработка выхода
    process.on("SIGINT", () => {
      console.log("\n\n🛑 Остановка диагностики...");
      nativeCapture.stopCapture();

      // Выводим полный отчет
      printDetailedReport();

      // Сохраняем сэмплы для анализа
      if (stats.rawDataSamples.length > 0) {
        const diagFile = `audio_diagnostic_${Date.now()}.json`;
        fs.writeFileSync(
          diagFile,
          JSON.stringify(
            {
              stats,
              samples: stats.rawDataSamples.slice(0, 1000),
            },
            null,
            2,
          ),
        );
        console.log(`\n💾 Диагностические данные сохранены в ${diagFile}`);
      }

      console.log("\n✅ Диагностика завершена\n");
      process.exit(0);
    });

    // Автоматический отчет через 30 секунд
    setTimeout(() => {
      console.log("\n⏰ Автоматический промежуточный отчет (30 сек):");
      printDetailedReport();
    }, 30_000);
  } else {
    console.log("❌ Не удалось запустить захват");
    console.log("   Ошибка:", result.message || "Unknown error");
    process.exit(1);
  }
}

// Запускаем диагностику
startDiagnostic();
