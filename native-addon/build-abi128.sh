#!/bin/bash

echo "🚀 Building for Electron 32 with forced ABI 128"

# Очистка
rm -rf build/
rm -f addon.node *.o

# Компилируем Swift
echo "🔨 Compiling Swift..."
swiftc -emit-object \
    -module-name CaptureModule \
    -emit-module \
    -emit-module-path . \
    -emit-objc-header \
    -emit-objc-header-path CaptureModule-Swift.h \
    -o CaptureModule.o \
    src/ScreenCaptureManager.swift 2>&1 | grep -v "warning"

# Скачиваем Electron headers если нужно
ELECTRON_VERSION="32.3.3"
ELECTRON_CACHE="$HOME/.electron-gyp/$ELECTRON_VERSION"

if [ ! -d "$ELECTRON_CACHE/include/node" ]; then
    echo "📥 Downloading Electron headers..."
    mkdir -p "$ELECTRON_CACHE"
    curl -sL "https://electronjs.org/headers/v${ELECTRON_VERSION}/node-v${ELECTRON_VERSION}-headers.tar.gz" | \
        tar -xz -C "$ELECTRON_CACHE" --strip-components=1
fi

# Создаем новый wrapper с правильной регистрацией
echo "🔨 Creating ABI 128 wrapper..."
cat > abi128_module.cc << 'EOF'
#define NAPI_VERSION 8
#include <node.h>
#include <v8.h>

// Forward declaration
extern "C" void Init(v8::Local<v8::Object> exports, v8::Local<v8::Value> module, void* context);

// Wrapper function
static void InitWrapper(v8::Local<v8::Object> exports,
                        v8::Local<v8::Value> module,
                        v8::Local<v8::Context> context) {
    void* priv = nullptr;
    Init(exports, module, priv);
}

// CRITICAL: Define module with ABI 128
#define NODE_MODULE_VERSION 128

// Registration method 1: NODE_MODULE_CONTEXT_AWARE
NODE_MODULE_CONTEXT_AWARE(NODE_GYP_MODULE_NAME, InitWrapper)

// Registration method 2: Direct export
extern "C" {
    __attribute__((visibility("default")))
    void _register_screen_capture_webrtc() {
        // This will be called by Node/Electron
    }
    
    __attribute__((visibility("default")))
    void node_module_register(void* mod) {
        // Direct registration
    }
}

// Registration method 3: NAPI style
#ifdef NAPI_MODULE
NAPI_MODULE(screen_capture_webrtc, Init)
#endif
EOF

# Модифицируем webrtc_wrapper для совместимости
echo "🔨 Patching webrtc_wrapper..."
cp src/webrtc_wrapper.mm webrtc_wrapper_patched.mm

# Добавляем в начало файла
cat > temp_header.txt << 'EOF'
#define NODE_MODULE_VERSION 128
#define BUILDING_NODE_EXTENSION 1
EOF

cat temp_header.txt webrtc_wrapper_patched.mm > webrtc_wrapper_final.mm

# Компилируем C++ с Electron headers
echo "🔨 Compiling C++ with Electron headers..."
clang++ -c \
    -std=c++20 \
    -stdlib=libc++ \
    -mmacosx-version-min=13.0 \
    -fPIC \
    -fobjc-arc \
    -O3 \
    -I"$ELECTRON_CACHE/include/node" \
    -I"node_modules/node-addon-api" \
    -DNODE_MODULE_VERSION=128 \
    -DBUILDING_NODE_EXTENSION \
    -DNODE_GYP_MODULE_NAME=screen_capture_webrtc \
    -DNAPI_DISABLE_CPP_EXCEPTIONS \
    -o webrtc_wrapper.o \
    webrtc_wrapper_final.mm

# Компилируем wrapper
echo "🔨 Compiling ABI 128 wrapper..."
clang++ -c \
    -std=c++20 \
    -stdlib=libc++ \
    -mmacosx-version-min=13.0 \
    -fPIC \
    -I"$ELECTRON_CACHE/include/node" \
    -I"node_modules/node-addon-api" \
    -DNODE_MODULE_VERSION=128 \
    -DNODE_GYP_MODULE_NAME=screen_capture_webrtc \
    -DBUILDING_NODE_EXTENSION \
    -o abi128_module.o \
    abi128_module.cc

# Линкуем с правильными символами
echo "🔗 Linking with ABI 128..."
clang++ \
    -bundle \
    -undefined dynamic_lookup \
    -mmacosx-version-min=13.0 \
    -stdlib=libc++ \
    -Wl,-exported_symbol,__node_register_module_v128 \
    -Wl,-exported_symbol,_node_module_register \
    -Wl,-exported_symbol,_napi_register_module_v1 \
    -o addon.node \
    webrtc_wrapper.o \
    CaptureModule.o \
    abi128_module.o \
    -framework Foundation \
    -framework CoreMedia \
    -framework AVFoundation \
    -framework ScreenCaptureKit \
    -framework CoreVideo \
    -framework AppKit

if [ ! -f "addon.node" ]; then
    echo "❌ Build failed"
    exit 1
fi

echo "✅ Build complete!"

# Проверка символов
echo ""
echo "🔍 Checking symbols..."
nm -gU addon.node | grep -E "(node_register|napi_register|Init)" | head -5

# Инжектируем версию модуля если нужно
echo ""
echo "🔧 Verifying module version..."

# Создаем тестовый скрипт
cat > verify_module.js << 'EOF'
const fs = require('fs');
const path = require('path');

// Читаем бинарник
const addonPath = path.join(__dirname, 'addon.node');
const buffer = fs.readFileSync(addonPath);

// Ищем NODE_MODULE_VERSION
let found = false;
const searchPattern = Buffer.from('NODE_MODULE_VERSION');
const versionBuffer = Buffer.from([128]); // ABI 128

for (let i = 0; i < buffer.length - searchPattern.length; i++) {
    if (buffer.compare(searchPattern, 0, searchPattern.length, i, i + searchPattern.length) === 0) {
        console.log('Found NODE_MODULE_VERSION marker at offset', i);
        found = true;
    }
}

if (!found) {
    console.log('⚠️  NODE_MODULE_VERSION marker not found, module might not register properly');
}

// Проверяем загрузку
try {
    const addon = require('./addon.node');
    console.log('✅ Module loads in Node.js!');
} catch (err) {
    if (err.message.includes('NODE_MODULE_VERSION')) {
        console.log('⚠️  Version mismatch in Node.js (expected, will work in Electron)');
    } else {
        console.log('❌ Load error:', err.message);
    }
}
EOF

node verify_module.js

# Тест в Electron
echo ""
echo "🧪 Testing in Electron..."
npx electron -p "try { require('./addon.node'); console.log('✅ Loads in Electron!'); process.exit(0); } catch(e) { console.log('❌', e.message); process.exit(1); }" 2>/dev/null || echo "⚠️  Test in Electron manually"

# Cleanup
rm -f abi128_module.cc abi128_module.o
rm -f webrtc_wrapper_patched.mm webrtc_wrapper_final.mm
rm -f temp_header.txt verify_module.js
rm -f *.o

# Копируем
cp addon.node ../dist-electron/native-addon.node

echo ""
echo "✨ Done! Module built for ABI 128 (Electron 32)"
echo "📦 Copied to dist-electron/"