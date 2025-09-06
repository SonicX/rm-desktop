// test-electron.js
const { app } = require('electron');

console.log('Electron version:', process.versions.electron);
console.log('Node ABI:', process.versions.modules);

app.whenReady().then(() => {
    try {
        const addon = require('./addon.node');
        console.log('✅ SUCCESS! Addon loaded in Electron');
        console.log('Available functions:', Object.keys(addon));
    } catch (e) {
        console.error('❌ FAILED:', e.message);
    }
    app.quit();
});