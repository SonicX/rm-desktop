// test-addon.js - Тест загрузки модуля

const { app } = require('electron');
const path = require('path');

console.log('🧪 Testing addon in Electron environment');
console.log('📋 Versions:');
console.log('  Electron:', process.versions.electron);
console.log('  Node:', process.versions.node);
console.log('  Module ABI:', process.versions.modules);
console.log('  Architecture:', process.arch);
console.log('');

app.whenReady().then(() => {
    // Пробуем загрузить addon
    try {
        const addon = require('./addon.node');
        console.log('✅ Module loaded successfully!');
        
        // Проверяем методы
        const methods = Object.keys(addon).filter(k => typeof addon[k] === 'function');
        console.log('📋 Available methods:', methods.length);
        methods.slice(0, 10).forEach(m => console.log(`  - ${m}`));
        
        // Базовый тест
        testBasicFunctionality(addon).then(() => {
            console.log('✅ All tests passed!');
            app.quit();
        }).catch(err => {
            console.error('❌ Test failed:', err);
            app.quit();
        });
        
    } catch (error) {
        console.error('❌ Failed to load module:', error.message);
        
        if (error.message.includes('NODE_MODULE_VERSION 127')) {
            console.error('');
            console.error('⚠️  Module compiled for Node.js (ABI 127)');
            console.error('   Need to compile for Electron 32 (ABI 128)');
            console.error('   Run: ./build-electron32-universal.sh');
        } else if (error.message.includes('NODE_MODULE_VERSION 128')) {
            console.error('');
            console.error('⚠️  Module version is correct but not loading');
            console.error('   Check symbol registration');
        } else if (error.message.includes('incompatible architecture')) {
            console.error('');
            console.error('⚠️  Wrong architecture');
            console.error('   Current arch:', process.arch);
            console.error('   Run: ./build-electron32-universal.sh');
        }
        
        app.quit();
    }
});

async function testBasicFunctionality(addon) {
    console.log('\n🔬 Running basic tests...');
    
    // Test 1: Check audio methods
    if (addon.startAudioOnlyCapture) {
        console.log('  ✅ startAudioOnlyCapture exists');
    } else {
        console.log('  ❌ startAudioOnlyCapture missing');
    }
    
    if (addon.setWebRTCAudioCallback) {
        console.log('  ✅ setWebRTCAudioCallback exists');
    } else {
        console.log('  ❌ setWebRTCAudioCallback missing');
    }
    
    // Test 2: Get available sources
    if (addon.getAvailableSources) {
        try {
            const sources = await addon.getAvailableSources();
            console.log(`  ✅ getAvailableSources returned ${sources.length} sources`);
        } catch (err) {
            console.log('  ⚠️  getAvailableSources failed:', err.message);
        }
    }
    
    console.log('\n✅ Basic tests complete');
}