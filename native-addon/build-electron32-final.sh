#!/bin/bash

echo "🚀 Building for Electron 32 (ABI 128) - FINAL FIX"

# Определяем пути
PROJECT_ROOT="/Users/sg12/zulip-desktop"
ADDON_DIR="$PROJECT_ROOT/native-addon"

cd "$ADDON_DIR"

# Очистка
echo "🧹 Complete cleanup..."
rm -rf build/
rm -rf node_modules/
rm -f addon.node
rm -f package-lock.json
rm -rf ~/.electron-gyp/
rm -rf ~/.npm/electron-cache/

# Переустанавливаем зависимости
echo "📦 Installing dependencies..."
npm install

# Устанавливаем точную версию Electron
echo "📦 Installing Electron 32.3.3..."
npm install --save-dev electron@32.3.3

# Проверяем версию
ELECTRON_PATH="$ADDON_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [ ! -f "$ELECTRON_PATH" ]; then
    ELECTRON_PATH="$ADDON_DIR/node_modules/electron/cli.js"
fi

echo "📋 Electron info:"
npx electron --version

# Метод 1: Используем electron-rebuild с правильными параметрами
echo "🔨 Method 1: Using electron-rebuild..."
npm install --save-dev electron-rebuild@latest

# Устанавливаем переменные окружения для Electron 32
export npm_config_runtime=electron
export npm_config_target=32.3.3
export npm_config_arch=x64
export npm_config_target_arch=x64
export npm_config_disturl=https://electronjs.org/headers
export npm_config_build_from_source=true
export npm_config_node_gyp=$(npm root -g)/npm/node_modules/node-gyp/bin/node-gyp.js

# Пробуем electron-rebuild
npx electron-rebuild --version=32.3.3 --arch=x64 --force --module-dir=.

# Проверяем результат
if [ -f "build/Release/screen_capture_webrtc.node" ]; then
    echo "✅ electron-rebuild succeeded"
    cp build/Release/screen_capture_webrtc.node addon.node
else
    echo "⚠️ electron-rebuild failed, trying Method 2..."
    
    # Метод 2: Прямая компиляция с Electron headers
    echo "🔨 Method 2: Direct compilation with Electron headers..."
    
    # Скачиваем Electron headers
    ELECTRON_VERSION="32.3.3"
    HEADERS_URL="https://electronjs.org/headers/v${ELECTRON_VERSION}/node-v${ELECTRON_VERSION}-headers.tar.gz"
    HEADERS_DIR="$HOME/.electron-gyp/${ELECTRON_VERSION}"
    
    echo "📥 Downloading Electron headers..."
    mkdir -p "$HEADERS_DIR"
    curl -L "$HEADERS_URL" | tar -xz -C "$HEADERS_DIR" --strip-components=1
    
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
    
    # Компилируем C++ с Electron headers
    echo "🔨 Compiling C++ with Electron headers..."
    clang++ -c \
        -std=c++17 \
        -stdlib=libc++ \
        -mmacosx-version-min=13.0 \
        -fPIC \
        -fobjc-arc \
        -O3 \
        -I"$HEADERS_DIR/include/node" \
        -I"node_modules/node-addon-api" \
        -DBUILDING_NODE_EXTENSION \
        -DNODE_GYP_MODULE_NAME=screen_capture_webrtc \
        -DNODE_MODULE_VERSION=128 \
        -DNAPI_VERSION=9 \
        -DNAPI_DISABLE_CPP_EXCEPTIONS \
        -o webrtc_wrapper.o \
        src/webrtc_wrapper.mm
    
    if [ ! -f "webrtc_wrapper.o" ]; then
        echo "❌ C++ compilation failed"
        exit 1
    fi
    
    # Создаем wrapper для правильной регистрации модуля
    echo "🔨 Creating module wrapper..."
    cat > module_wrapper.cc << 'EOF'
#include <node.h>
#include <v8.h>

extern "C" void Init(v8::Local<v8::Object> exports, v8::Local<v8::Value> module, void* context);

NODE_MODULE_CONTEXT_AWARE(NODE_GYP_MODULE_NAME, Init)
NODE_MODULE_VERSION(128)
EOF
    
    # Компилируем wrapper
    clang++ -c \
        -std=c++17 \
        -stdlib=libc++ \
        -mmacosx-version-min=13.0 \
        -fPIC \
        -I"$HEADERS_DIR/include/node" \
        -DBUILDING_NODE_EXTENSION \
        -DNODE_GYP_MODULE_NAME=screen_capture_webrtc \
        -DNODE_MODULE_VERSION=128 \
        -o module_wrapper.o \
        module_wrapper.cc
    
    # Линкуем с правильными флагами
    echo "🔗 Linking with Electron ABI 128..."
    clang++ \
        -bundle \
        -undefined dynamic_lookup \
        -mmacosx-version-min=13.0 \
        -stdlib=libc++ \
        -Wl,-no_pie \
        -Wl,-search_paths_first \
        -o addon.node \
        webrtc_wrapper.o \
        CaptureModule.o \
        module_wrapper.o \
        -framework Foundation \
        -framework CoreMedia \
        -framework AVFoundation \
        -framework ScreenCaptureKit \
        -framework CoreVideo \
        -framework AppKit
fi

# Проверяем результат
if [ -f "addon.node" ]; then
    echo "✅ Build successful!"
    
    # Проверяем символы
    echo "🔍 Checking module registration..."
    nm -gU addon.node | grep -E "(napi_register_module|NODE_MODULE|Init)" || true
    
    # Копируем в dist-electron
    echo "📦 Copying to dist-electron..."
    cp addon.node "$PROJECT_ROOT/dist-electron/native-addon.node"
    
    echo "✨ Done! Module built for Electron 32 (ABI 128)"
else
    echo "❌ Build failed"
    
    # Метод 3: Последняя попытка - используем prebuild
    echo "🔨 Method 3: Using prebuild-install..."
    npm install --save-dev prebuild-install prebuild
    
    # Создаем prebuild
    npx prebuild --runtime=electron --target=32.3.3 --arch=x64 --strip
    
    if [ -f "prebuilds/darwin-x64/electron-128.node" ]; then
        cp "prebuilds/darwin-x64/electron-128.node" addon.node
        cp addon.node "$PROJECT_ROOT/dist-electron/native-addon.node"
        echo "✅ Prebuild successful!"
    else
        echo "❌ All methods failed"
        exit 1
    fi
fi

# Финальная проверка
echo ""
echo "📋 Final check:"
file addon.node
ls -lh addon.node

# Тестируем загрузку
echo ""
echo "🧪 Testing module load..."
cat > test-load.js << 'EOF'
try {
    const addon = require('./addon.node');
    console.log('✅ Module loaded successfully!');
    console.log('Available methods:', Object.keys(addon).filter(k => typeof addon[k] === 'function'));
} catch (err) {
    console.error('❌ Failed to load:', err.message);
    if (err.message.includes('NODE_MODULE_VERSION')) {
        console.error('Version mismatch - module not built correctly for Electron 32');
    }
}
EOF

npx electron test-load.js

# Cleanup
rm -f test-load.js module_wrapper.cc *.o

echo ""
echo "🎉 Build process complete!"
echo "Now run: npm start"