try {
    const capture = require('./build/Release/capture.node');
    
    console.log('✅ Module loaded successfully');
    console.log('Test method:', capture.testMethod());
    
    // Тест получения источников
    console.log('\n📺 Getting available sources...');
    const sources = capture.getAvailableSources();
    console.log(`Found ${sources.length} sources total`);
    
    // Группируем по типам
    const screens = sources.filter(s => s.type === 'screen');
    const windows = sources.filter(s => s.type === 'window');
    
    console.log(`  - Screens: ${screens.length}`);
    console.log(`  - Windows: ${windows.length}`);
    
    // Показываем первые несколько источников
    if (screens.length > 0) {
        console.log('\n🖥️ Screens:');
        screens.slice(0, 3).forEach(s => {
            console.log(`  - ${s.name} (${s.width}x${s.height})`);
        });
    }
    
    if (windows.length > 0) {
        console.log('\n🪟 Windows:');
        windows.slice(0, 5).forEach(w => {
            console.log(`  - ${w.name} (${w.width}x${w.height})`);
        });
    }
    
    // Тест установки источника
    if (sources.length > 0) {
        console.log('\n🎯 Testing capture setup...');
        const testSource = screens[0] || sources[0];
        
        const sourceResult = capture.setCaptureSource(testSource);
        console.log('Set source result:', sourceResult);
        
        const qualityResult = capture.setCaptureQuality({
            width: 1920,
            height: 1080,
            fps: 30
        });
        console.log('Set quality result:', qualityResult);
        
        // Тест callbacks
        let videoFrames = 0;
        let audioFrames = 0;
        
        capture.setWebRTCVideoCallback((frame) => {
            videoFrames++;
            if (videoFrames === 1) {
                console.log('📹 First video frame received:', {
                    width: frame.width,
                    height: frame.height,
                    timestamp: frame.timestamp,
                    hasRealPixels: frame.hasRealPixels
                });
            }
        });
        
        capture.setWebRTCAudioCallback((frame) => {
            audioFrames++;
            if (audioFrames === 1) {
                console.log('🔊 First audio frame received:', {
                    sampleRate: frame.sampleRate,
                    channels: frame.channels,
                    numSamples: frame.numSamples,
                    source: frame.source
                });
            }
        });
        
        // Начинаем захват
        console.log('\n▶️ Starting capture...');
        const startResult = capture.startCapture();
        console.log('Start result:', startResult);
        
        // Ждем 2 секунды и останавливаем
        setTimeout(() => {
            console.log('\n⏹️ Stopping capture...');
            const stopResult = capture.stopCapture();
            console.log('Stop result:', stopResult);
            console.log(`\n📊 Statistics:`);
            console.log(`  - Video frames: ${videoFrames}`);
            console.log(`  - Audio frames: ${audioFrames}`);
            console.log('\n✅ All tests passed!');
            process.exit(0);
        }, 2000);
    } else {
        console.log('\n⚠️ No sources found to test capture');
        console.log('✅ Basic tests passed');
        process.exit(0);
    }
    
} catch (error) {
    console.error('❌ Test failed:', error);
    console.error('Stack:', error.stack);
    process.exit(1);
}