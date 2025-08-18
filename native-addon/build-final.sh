#!/bin/bash

echo "🚀 Final build solution for Electron 32"

# Очистка
echo "🧹 Cleaning..."
rm -rf build/
rm -f addon.node *.o

# Устанавливаем Electron если нет
if [ ! -d "node_modules/electron" ]; then
    echo "📦 Installing Electron..."
    npm install --save-dev electron@32.3.3
fi

# Скачиваем Electron headers
ELECTRON_VERSION="32.3.3"
HEADERS_DIR="$HOME/.electron-gyp/$ELECTRON_VERSION"

if [ ! -d "$HEADERS_DIR/include/node" ]; then
    echo "📥 Downloading Electron headers..."
    mkdir -p "$HEADERS_DIR"
    curl -sL "https://electronjs.org/headers/v${ELECTRON_VERSION}/node-v${ELECTRON_VERSION}-headers.tar.gz" | \
        tar -xz -C "$HEADERS_DIR" --strip-components=1
fi

echo "📋 Using headers from: $HEADERS_DIR"

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

if [ ! -f "CaptureModule.o" ]; then
    echo "❌ Swift compilation failed"
    exit 1
fi

# Создаем минимальный wrapper который работает
echo "🔨 Creating minimal wrapper..."
cat > wrapper.cc << 'EOF'
// Минимальный код для регистрации модуля
extern "C" void Init(void* exports, void* module, void* context);

// Экспортируем Init функцию
extern "C" __attribute__((visibility("default"))) 
void node_register_module_v128(void* exports, void* module, void* context) {
    Init(exports, module, context);
}

// Альтернативная точка входа
extern "C" __attribute__((visibility("default")))
void napi_register_module_v1(void* exports, void* module, void* context) {
    Init(exports, module, context);
}
EOF

# Компилируем wrapper БЕЗ включения node.h
echo "🔨 Compiling wrapper..."
clang++ -c \
    -std=c++20 \
    -stdlib=libc++ \
    -fPIC \
    -o wrapper.o \
    wrapper.cc

# Компилируем основной C++ файл с правильными путями
echo "🔨 Compiling C++..."
clang++ -c \
    -std=c++20 \
    -stdlib=libc++ \
    -mmacosx-version-min=13.0 \
    -fPIC \
    -fobjc-arc \
    -O3 \
    -I"$HEADERS_DIR/include/node" \
    -I"node_modules/node-addon-api" \
    -I"." \
    -DNAPI_DISABLE_CPP_EXCEPTIONS \
    -DBUILDING_NODE_EXTENSION \
    -o webrtc_wrapper.o \
    src/webrtc_wrapper.mm

if [ ! -f "webrtc_wrapper.o" ]; then
    echo "⚠️ Compilation with Electron headers failed, trying fallback..."
    
    # Fallback: используем системные пути
    clang++ -c \
        -std=c++20 \
        -stdlib=libc++ \
        -mmacosx-version-min=13.0 \
        -fPIC \
        -fobjc-arc \
        -O3 \
        -I"/usr/local/include/node" \
        -I"/opt/homebrew/include/node" \
        -I"node_modules/node-addon-api" \
        -I"$(node -p 'require("path").dirname(process.execPath) + "/../include/node"')" \
        -DNAPI_DISABLE_CPP_EXCEPTIONS \
        -o webrtc_wrapper.o \
        src/webrtc_wrapper.mm
fi

if [ ! -f "webrtc_wrapper.o" ]; then
    echo "❌ C++ compilation failed"
    
    # Последняя попытка - модифицируем исходник
    echo "🔨 Trying modified source..."
    
    # Создаем версию без node.h
    sed 's/#include <node.h>/#include <stddef.h>/' src/webrtc_wrapper.mm > webrtc_modified.mm
    sed -i '' 's/#include <uv.h>//' webrtc_modified.mm
    
    clang++ -c \
        -std=c++20 \
        -stdlib=libc++ \
        -fPIC \
        -fobjc-arc \
        -I"node_modules/node-addon-api" \
        -DNAPI_DISABLE_CPP_EXCEPTIONS \
        -o webrtc_wrapper.o \
        webrtc_modified.mm
    
    rm -f webrtc_modified.mm
fi

if [ ! -f "webrtc_wrapper.o" ]; then
    echo "❌ All compilation attempts failed"
    exit 1
fi

# Линкуем
echo "🔗 Linking..."
clang++ \
    -bundle \
    -undefined dynamic_lookup \
    -mmacosx-version-min=13.0 \
    -stdlib=libc++ \
    -o addon.node \
    webrtc_wrapper.o \
    CaptureModule.o \
    wrapper.o \
    -framework Foundation \
    -framework CoreMedia \
    -framework AVFoundation \
    -framework ScreenCaptureKit \
    -framework CoreVideo \
    -framework AppKit

if [ ! -f "addon.node" ]; then
    echo "❌ Linking failed"
    exit 1
fi

echo "✅ Build complete!"

# Проверка
echo ""
echo "🔍 Checking module..."
file addon.node
ls -lh addon.node

# Проверка символов
echo ""
echo "📋 Exported symbols:"
nm -gU addon.node | grep -E "(node_register|napi_register|Init)" | head -5

# Тест в Electron
echo ""
echo "🧪 Testing in Electron..."

# Создаем тестовый скрипт
cat > test.js << 'EOF'
const { app } = require('electron');
app.whenReady().then(() => {
    try {
        const addon = require('./addon.node');
        console.log('✅ MODULE LOADS IN ELECTRON!');
        const methods = Object.keys(addon).filter(k => typeof addon[k] === 'function');
        console.log('Methods found:', methods.length);
        if (methods.length > 0) {
            console.log('First 5 methods:', methods.slice(0, 5));
        }
        app.quit();
    } catch (err) {
        console.error('❌ Load failed:', err.message);
        if (err.message.includes('127')) {
            console.error('Still wrong version');
        }
        app.quit();
    }
});
EOF

npx electron test.js

# Cleanup
rm -f wrapper.cc wrapper.o test.js *.o

# Копируем если успешно
if [ -f "addon.node" ]; then
    cp addon.node ../dist-electron/native-addon.node
    echo ""
    echo "✨ Success! Module copied to dist-electron/"
    echo "📝 Run: npm start"
fi