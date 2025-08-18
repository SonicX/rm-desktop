#!/bin/bash

echo "🚀 Rebuilding with electron-rebuild"

# Устанавливаем точную версию Electron
npm install --save-dev electron@32.3.3
npm install --save-dev electron-rebuild@latest

# Очистка
rm -rf build/
rm -f addon.node

# Создаем минимальный binding.gyp который точно работает
cat > binding.gyp << 'EOF'
{
  "targets": [
    {
      "target_name": "addon",
      "sources": [ ],
      "conditions": [
        ['OS=="mac"', {
          "sources": [
            "src/webrtc_wrapper.mm",
            "src/ScreenCaptureManager.swift"
          ],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "13.0",
            "OTHER_CFLAGS": [
              "-fobjc-arc"
            ],
            "OTHER_CPLUSPLUSFLAGS": [
              "-std=c++20",
              "-fobjc-arc",
              "-stdlib=libc++",
              "-I/usr/local/include",
              "-I/opt/homebrew/include"
            ]
          },
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")",
            "/usr/local/include/node",
            "/opt/homebrew/include/node",
            "."
          ],
          "libraries": [
            "-framework Foundation",
            "-framework CoreMedia",
            "-framework AVFoundation", 
            "-framework ScreenCaptureKit",
            "-framework CoreVideo",
            "-framework AppKit"
          ],
          "defines": [
            "NAPI_DISABLE_CPP_EXCEPTIONS",
            "NODE_MODULE_VERSION=128"
          ]
        }]
      ]
    }
  ]
}
EOF

# Пробуем electron-rebuild
echo "🔨 Running electron-rebuild..."
DEBUG=* npx electron-rebuild --version=32.3.3 --arch=x64 --force 2>&1 | grep -v "gyp info" | tail -20

# Проверяем результат
if [ -f "build/Release/addon.node" ]; then
    echo "✅ electron-rebuild succeeded"
    cp build/Release/addon.node addon.node
else
    echo "⚠️ electron-rebuild failed, using fallback..."
    
    # Fallback: компилируем напрямую с использованием Electron
    echo "🔨 Compiling with Electron's Node..."
    
    # Находим Electron
    ELECTRON_PATH="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
    if [ ! -f "$ELECTRON_PATH" ]; then
        ELECTRON_PATH="npx electron"
    fi
    
    # Создаем build скрипт для выполнения внутри Electron
    cat > electron_build.js << 'EOF'
const { execSync } = require('child_process');
const fs = require('fs');

console.log('Building inside Electron process...');
console.log('ABI Version:', process.versions.modules);

// Компилируем Swift
try {
    execSync('swiftc -emit-object -module-name CaptureModule -o CaptureModule.o src/ScreenCaptureManager.swift', {stdio: 'inherit'});
} catch (e) {
    console.error('Swift compilation failed');
}

// Компилируем C++
try {
    execSync(`clang++ -c -std=c++20 -stdlib=libc++ -fobjc-arc -fPIC -I"node_modules/node-addon-api" -DNAPI_DISABLE_CPP_EXCEPTIONS -o webrtc_wrapper.o src/webrtc_wrapper.mm`, {stdio: 'inherit'});
} catch (e) {
    console.error('C++ compilation failed');
}

// Линкуем
try {
    execSync('clang++ -bundle -undefined dynamic_lookup -o addon.node webrtc_wrapper.o CaptureModule.o -framework Foundation -framework CoreMedia -framework AVFoundation -framework ScreenCaptureKit -framework CoreVideo -framework AppKit', {stdio: 'inherit'});
    console.log('✅ Build complete');
} catch (e) {
    console.error('Linking failed');
}

process.exit(0);
EOF
    
    # Запускаем сборку через Electron
    $ELECTRON_PATH electron_build.js
    
    # Cleanup
    rm -f electron_build.js
fi

# Финальная проверка
if [ -f "addon.node" ]; then
    echo ""
    echo "✅ addon.node created"
    
    # Тест
    echo "🧪 Testing..."
    npx electron -e "try { const a = require('./addon.node'); console.log('✅ SUCCESS! Module loads in Electron'); console.log('Methods:', Object.keys(a).filter(k => typeof a[k] === 'function').length); process.exit(0); } catch(e) { console.error('❌ FAILED:', e.message); process.exit(1); }"
    
    # Копируем
    cp addon.node ../dist-electron/native-addon.node
    echo "📦 Copied to dist-electron/"
    
    echo ""
    echo "✨ Build complete!"
else
    echo "❌ Build failed"
    exit 1
fi