// test_app_audio.js
const nativeCapture = require('../dist-electron/native-addon.node');
const fs = require('fs');
const path = require('path');

console.log('Windows Application Audio Capture Test');
console.log('=======================================\n');

// Проверяем модуль
try {
    const testResult = nativeCapture.testMethod();
    console.log('Module loaded:', testResult);
} catch (err) {
    console.error('Failed to load module:', err);
    process.exit(1);
}

// Получаем список доступных источников
console.log('\nAvailable sources:');
const sources = nativeCapture.getAvailableSources();

// Фильтруем только окна приложений
const windows = sources.filter(s => s.type === 'window');
const screens = sources.filter(s => s.type === 'screen');

console.log(`\nFound ${windows.length} windows and ${screens.length} screens\n`);

// Выводим окна с индексами
windows.forEach((window, index) => {
    console.log(`[${index}] ${window.name}`);
    console.log(`    ID: ${window.id}, Size: ${window.width}x${window.height}`);
});

// Интерактивный выбор окна
const readline = require('readline');
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

console.log('\n========================================');
console.log('ТЕСТ ЗАХВАТА ЗВУКА ОТ ПРИЛОЖЕНИЯ');
console.log('========================================');
console.log('Эта версия поддерживает захват звука от конкретного окна!');
console.log('Выберите окно из списка выше для захвата его звука.\n');

rl.question('Введите номер окна (или "s" для системного звука): ', (answer) => {
    let selectedSource = null;
    
    if (answer.toLowerCase() === 's') {
        // Выбираем первый экран для системного звука
        selectedSource = screens[0] || sources[0];
        console.log('\nВыбран системный звук');
    } else {
        const index = parseInt(answer);
        if (index >= 0 && index < windows.length) {
            selectedSource = windows[index];
            console.log(`\nВыбрано окно: ${selectedSource.name}`);
            console.log('Попытка захвата звука только от этого приложения...');
        } else {
            console.log('Неверный выбор');
            rl.close();
            process.exit(1);
        }
    }
    
    // Устанавливаем источник
    nativeCapture.setCaptureSource(selectedSource);
    
    // Устанавливаем качество
    nativeCapture.setCaptureQuality({
        width: 1920,
        height: 1080,
        fps: 30
    });
    
    // Счетчики для статистики
    let audioFrameCount = 0;
    let videoFrameCount = 0;
    let lastAudioTime = Date.now();
    let audioDataSize = 0;
    
    // Буфер для записи аудио (опционально)
    const audioBuffers = [];
    const RECORD_AUDIO = false; // Установите true для записи WAV файла
    
    // Устанавливаем callback для аудио
    nativeCapture.setWebRTCAudioCallback((audioData) => {
        audioFrameCount++;
        audioDataSize += audioData.dataSize || 0;
        
        // Показываем информацию о источнике
        const source = audioData.applicationName || 
                       (audioData.isSystemAudio ? 'System' : 'Application');
        
        // Каждую секунду выводим статистику
        if (Date.now() - lastAudioTime > 1000) {
            const dataRate = (audioDataSize / 1024).toFixed(2);
            console.log(`Audio: ${audioFrameCount} frames | ` +
                       `${audioData.sampleRate}Hz | ` +
                       `${audioData.channels}ch | ` +
                       `Source: ${source} | ` +
                       `Data: ${dataRate} KB/s`);
            
            audioFrameCount = 0;
            audioDataSize = 0;
            lastAudioTime = Date.now();
        }
        
        // Опционально: сохраняем аудио для записи
        if (RECORD_AUDIO && audioData.data) {
            const buffer = Buffer.from(audioData.data);
            audioBuffers.push({
                buffer,
                samples: audioData.numSamples,
                channels: audioData.channels,
                sampleRate: audioData.sampleRate
            });
        }
    });
    
    // Устанавливаем callback для видео (опционально)
    nativeCapture.setWebRTCVideoCallback((videoData) => {
        videoFrameCount++;
        // Можно добавить обработку видео если нужно
    });
    
    // Запускаем захват
    console.log('\nЗапуск захвата...');
    const result = nativeCapture.startCapture();
    
    if (result.success) {
        console.log('✓ Захват запущен успешно');
        console.log(`  Сообщение: ${result.message}`);
        if (result.audioType) {
            console.log(`  Тип аудио: ${result.audioType}`);
        }
        
        console.log('\n========================================');
        console.log('Захват активен. Статистика обновляется каждую секунду.');
        if (selectedSource.type === 'window') {
            console.log('ВАЖНО: Воспроизведите звук в выбранном приложении');
            console.log('для проверки захвата звука от конкретного окна.');
        }
        console.log('Нажмите Ctrl+C для остановки...');
        console.log('========================================\n');
        
        // Обработка выхода
        process.on('SIGINT', () => {
            console.log('\n\nОстановка захвата...');
            nativeCapture.stopCapture();
            
            // Сохраняем аудио если записывали
            if (RECORD_AUDIO && audioBuffers.length > 0) {
                console.log('Сохранение аудио...');
                saveWAV(audioBuffers, 'captured_audio.wav');
            }
            
            console.log('✓ Захват остановлен');
            rl.close();
            process.exit(0);
        });
        
    } else {
        console.log('✗ Не удалось запустить захват');
        rl.close();
        process.exit(1);
    }
});

// Функция для сохранения WAV файла
function saveWAV(audioBuffers, filename) {
    if (audioBuffers.length === 0) return;
    
    const first = audioBuffers[0];
    const sampleRate = first.sampleRate;
    const channels = first.channels;
    const bitsPerSample = 32; // float32
    
    // Объединяем все буферы
    const totalSize = audioBuffers.reduce((sum, item) => 
        sum + item.buffer.length, 0);
    
    const buffer = Buffer.alloc(44 + totalSize);
    let offset = 0;
    
    // WAV заголовок
    buffer.write('RIFF', offset); offset += 4;
    buffer.writeUInt32LE(36 + totalSize, offset); offset += 4;
    buffer.write('WAVE', offset); offset += 4;
    buffer.write('fmt ', offset); offset += 4;
    buffer.writeUInt32LE(16, offset); offset += 4;
    buffer.writeUInt16LE(3, offset); offset += 2; // IEEE float
    buffer.writeUInt16LE(channels, offset); offset += 2;
    buffer.writeUInt32LE(sampleRate, offset); offset += 4;
    buffer.writeUInt32LE(sampleRate * channels * 4, offset); offset += 4;
    buffer.writeUInt16LE(channels * 4, offset); offset += 2;
    buffer.writeUInt16LE(bitsPerSample, offset); offset += 2;
    buffer.write('data', offset); offset += 4;
    buffer.writeUInt32LE(totalSize, offset); offset += 4;
    
    // Копируем аудио данные
    audioBuffers.forEach(item => {
        item.buffer.copy(buffer, offset);
        offset += item.buffer.length;
    });
    
    fs.writeFileSync(filename, buffer);
    console.log(`Аудио сохранено в ${filename}`);
}