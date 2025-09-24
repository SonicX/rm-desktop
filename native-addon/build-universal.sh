#!/bin/bash

# ========================================
# АВТОМАТИЧЕСКОЕ ОПРЕДЕЛЕНИЕ ВЕРСИИ ELECTRON
# ========================================

echo "🔍 Detecting Electron version..."

# Находим package.json (может быть в текущей директории или на уровень выше)
if [ -f "../package.json" ]; then
    PACKAGE_JSON="../package.json"
elif [ -f "../../package.json" ]; then
    PACKAGE_JSON="../../package.json"
elif [ -f "package.json" ]; then
    PACKAGE_JSON="package.json"
else
    echo "❌ package.json not found"
    exit 1
fi

# Извлекаем версию Electron
# ========================================
# НАДЁЖНОЕ ОПРЕДЕЛЕНИЕ НАТИВНОГО БИНАРНИКА ELECTRON
# ========================================

echo "🔍 Detecting REAL Electron binary..."

# Приоритет: нативный бинарник из dist/
if [ -f "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ]; then
    ELECTRON_BIN="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
elif [ -f "../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ]; then
    ELECTRON_BIN="../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
elif [ -f "../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ]; then
    ELECTRON_BIN="../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
else
    echo "❌ Native Electron binary not found in node_modules. Trying to reinstall..."
    # Устанавливаем Electron 37.3.1 (исправление!)
    npm install electron@37.3.1 --no-save --ignore-scripts && \
    (cd node_modules/electron && node install.js) || {
        echo "❌ Failed to reinstall Electron binary"
        exit 1
    }
    # Проверяем снова
    if [ -f "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ]; then
        ELECTRON_BIN="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
    elif [ -f "../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ]; then
        ELECTRON_BIN="../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
    else
        echo "❌ Still no native Electron binary found. Aborting."
        exit 1
    fi
fi

echo "🔍 Using REAL Electron binary: $ELECTRON_BIN"
ELECTRON_VERSION=$("$ELECTRON_BIN" --version | sed 's/^v//')
ELECTRON_ABI=$("$ELECTRON_BIN" --abi)

if [ -z "$ELECTRON_VERSION" ] || [ -z "$ELECTRON_ABI" ]; then
    echo "❌ Failed to get version or ABI from native binary"
    exit 1
fi

echo "✅ Detected Electron ${ELECTRON_VERSION} (ABI ${ELECTRON_ABI})"

# 🔒 КРИТИЧЕСКАЯ ПРОВЕРКА: Electron 37.x должен иметь ABI 136
if [[ "$ELECTRON_VERSION" == 37* ]] && [ "$ELECTRON_ABI" != "136" ]; then
    echo "❌ CRITICAL: ABI mismatch for Electron 37.x"
    echo "   Expected ABI: 136"
    echo "   Actual ABI: $ELECTRON_ABI"
    echo "   Your Electron binary may be corrupted or from wrong version."
    echo "   Reinstalling Electron 37.3.1 from GitHub..."
    
    # Переходим в папку electron
    ELECTRON_DIR=$(dirname "$ELECTRON_BIN")
    cd "$ELECTRON_DIR/../../.."  # Это node_modules/electron
    
    # Удаляем старый dist
    rm -rf dist
    mkdir -p dist
    cd dist
    
    # Определяем архитектуру
    ARCH=$(uname -m)
    if [ "$ARCH" = "x86_64" ]; then
        ZIP_URL="https://github.com/electron/electron/releases/download/v37.3.1/electron-v37.3.1-darwin-x64.zip"
    else
        ZIP_URL="https://github.com/electron/electron/releases/download/v37.3.1/electron-v37.3.1-darwin-arm64.zip"
    fi
    
    echo "📥 Downloading official Electron 37.3.1 from GitHub: $ZIP_URL"
    if curl -L# "$ZIP_URL" -o electron.zip && unzip -o electron.zip && rm -f electron.zip; then
        echo "✅ Official Electron binary installed"
        # Обновляем путь
        ELECTRON_BIN="Electron.app/Contents/MacOS/Electron"
        ELECTRON_VERSION=$("$ELECTRON_BIN" --version | sed 's/^v//')
        ELECTRON_ABI=$("$ELECTRON_BIN" --abi)
        echo "✅ Re-checked: Electron ${ELECTRON_VERSION} (ABI ${ELECTRON_ABI})"
        
        if [ "$ELECTRON_ABI" != "136" ]; then
            echo "❌ Even official binary has wrong ABI. Aborting."
            exit 1
        fi
    else
        echo "❌ Failed to download or extract official binary. Aborting."
        exit 1
    fi
fi

# Скачиваем Electron headers если нужно
ELECTRON_HEADERS_DIR="$HOME/.electron-gyp/${ELECTRON_VERSION}"
if [ ! -d "$ELECTRON_HEADERS_DIR/include/node" ]; then
    echo "📥 Downloading Electron headers for v${ELECTRON_VERSION}..."
    mkdir -p "$ELECTRON_HEADERS_DIR"
    
    # Скачиваем headers
    HEADERS_URL="https://electronjs.org/headers/v${ELECTRON_VERSION}/node-v${ELECTRON_VERSION}-headers.tar.gz"
    if command -v curl &> /dev/null; then
        curl -L "$HEADERS_URL" | tar -xz -C "$ELECTRON_HEADERS_DIR" --strip-components=1
    else
        wget -qO- "$HEADERS_URL" | tar -xz -C "$ELECTRON_HEADERS_DIR" --strip-components=1
    fi
    
    if [ ! -d "$ELECTRON_HEADERS_DIR/include/node" ]; then
        echo "❌ Failed to download Electron headers"
        exit 1
    fi
    
    if [ ! -f "$ELECTRON_HEADERS_DIR/include/node/node.h" ]; then
        echo "❌ Electron headers are incomplete or corrupted"
        exit 1
    fi
    echo "✅ Electron headers downloaded"
else
    echo "✅ Using cached Electron headers"
fi

echo ""
echo "🚀 Building Universal Binary for Electron ${ELECTRON_VERSION}"
echo "📱 Current system: $(uname -m)"

# Очистка
echo "🧹 Cleaning previous builds..."
rm -rf build/
rm -f addon.node
rm -f *.o
rm -f addon-*.node

# Создаем директории
mkdir -p build

# Находим исходники
SWIFT_FILE=""
CPP_FILE=""

if [ -f "src/ScreenCaptureManager.swift" ]; then
    SWIFT_FILE="src/ScreenCaptureManager.swift"
elif [ -f "ScreenCaptureManager.swift" ]; then
    SWIFT_FILE="ScreenCaptureManager.swift"
fi

if [ -f "src/webrtc_wrapper.mm" ]; then
    CPP_FILE="src/webrtc_wrapper.mm"
elif [ -f "webrtc_wrapper.mm" ]; then
    CPP_FILE="webrtc_wrapper.mm"
fi

if [ -z "$SWIFT_FILE" ] || [ -z "$CPP_FILE" ]; then
    echo "❌ Source files not found"
    exit 1
fi

echo "📋 Found sources:"
echo "  Swift: $SWIFT_FILE"
echo "  C++: $CPP_FILE"

# Находим Node headers
NODE_MODULES_PATH="node_modules"
if [ ! -d "$NODE_MODULES_PATH" ]; then
    NODE_MODULES_PATH="../node_modules"
fi

NODE_ADDON_API="$NODE_MODULES_PATH/node-addon-api"
if [ ! -d "$NODE_ADDON_API" ]; then
    echo "❌ node-addon-api not found. Run: npm install"
    exit 1
fi

# Функция для компиляции Swift для конкретной архитектуры
compile_swift_for_arch() {
    local arch=$1
    echo "🔨 Compiling Swift for $arch..."
    
    swiftc -emit-object \
        -module-name CaptureModule \
        -emit-module \
        -emit-module-path . \
        -emit-objc-header \
        -emit-objc-header-path CaptureModule-Swift.h \
        -target $arch-apple-macos13.0 \
        -o CaptureModule-$arch.o \
        "$SWIFT_FILE" 2>&1 | grep -v "warning: value 'filter' was defined but never used"
    
    if [ ! -f "CaptureModule-$arch.o" ]; then
        echo "❌ Swift compilation failed for $arch"
        return 1
    fi
    echo "✅ Swift compiled for $arch"
    return 0
}

# Функция для компиляции C++ для конкретной архитектуры
compile_cpp_for_arch() {
    local arch=$1
    echo "🔨 Compiling C++ for $arch..."
    
    local clang_arch=$arch
    if [ "$arch" = "x86_64" ]; then
        clang_arch="x86_64"
    elif [ "$arch" = "arm64" ]; then
        clang_arch="arm64"
    fi
    
    clang++ -c \
        -arch $clang_arch \
        -std=c++20 \
        -stdlib=libc++ \
        -mmacosx-version-min=13.0 \
        -fPIC \
        -fobjc-arc \
        -O3 \
        -I"$NODE_ADDON_API" \
        -I"$ELECTRON_HEADERS_DIR/include/node" \
        -I"$ELECTRON_HEADERS_DIR/src" \
        -I"$NODE_ADDON_API" \
        -DNAPI_DISABLE_CPP_EXCEPTIONS \
        -o webrtc_wrapper-$arch.o \
        "$CPP_FILE"
    
    if [ ! -f "webrtc_wrapper-$arch.o" ]; then
        echo "❌ C++ compilation failed for $arch"
        return 1
    fi
    echo "✅ C++ compiled for $arch"
    return 0
}

# Функция для линковки для конкретной архитектуры
link_for_arch() {
    local arch=$1
    echo "🔗 Linking for $arch..."
    
    local clang_arch=$arch
    if [ "$arch" = "x86_64" ]; then
        clang_arch="x86_64"
    elif [ "$arch" = "arm64" ]; then
        clang_arch="arm64"
    fi
    
    clang++ \
        -arch $clang_arch \
        -bundle \
        -undefined dynamic_lookup \
        -mmacosx-version-min=13.0 \
        -stdlib=libc++ \
        -o addon-$arch.node \
        webrtc_wrapper-$arch.o \
        CaptureModule-$arch.o \
        -framework Foundation \
        -framework CoreMedia \
        -framework AVFoundation \
        -framework ScreenCaptureKit \
        -framework CoreVideo \
        -framework AppKit
    
    if [ ! -f "addon-$arch.node" ]; then
        echo "❌ Linking failed for $arch"
        return 1
    fi
    echo "✅ Linked for $arch"
    return 0
}

# Компилируем для x86_64 (Intel)
echo ""
echo "🖥️  Building for Intel (x86_64)..."
if compile_swift_for_arch "x86_64" && compile_cpp_for_arch "x86_64" && link_for_arch "x86_64"; then
    echo "✅ Intel build complete"
    HAVE_X86=true
else
    echo "⚠️ Intel build failed"
    HAVE_X86=false
fi

# Компилируем для arm64 (Apple Silicon)
echo ""
echo "🖥️  Building for Apple Silicon (arm64)..."
if compile_swift_for_arch "arm64" && compile_cpp_for_arch "arm64" && link_for_arch "arm64"; then
    echo "✅ Apple Silicon build complete"
    HAVE_ARM64=true
else
    echo "⚠️ Apple Silicon build failed"
    HAVE_ARM64=false
fi

# Создаем Universal Binary если обе архитектуры собраны
echo ""
if [ "$HAVE_X86" = true ] && [ "$HAVE_ARM64" = true ]; then
    echo "🎯 Creating Universal Binary..."
    lipo -create addon-x86_64.node addon-arm64.node -output addon.node
    
    if [ -f "addon.node" ]; then
        echo "✅ Universal Binary created successfully!"
        echo ""
        echo "📋 Universal Binary info:"
        lipo -info addon.node
        echo ""
        echo "📊 File details:"
        file addon.node
        ls -lh addon.node
        
        # Проверяем символы
        echo ""
        echo "🔍 Checking exported symbols:"
        nm -gU addon.node | grep -E "(Init|_napi_register_module)" | head -3
    else
        echo "❌ Failed to create Universal Binary"
    fi
elif [ "$HAVE_X86" = true ]; then
    echo "⚠️ Only Intel version available, using it as addon.node"
    cp addon-x86_64.node addon.node
elif [ "$HAVE_ARM64" = true ]; then
    echo "⚠️ Only Apple Silicon version available, using it as addon.node"
    cp addon-arm64.node addon.node
else
    echo "❌ No successful builds"
    exit 1
fi

# Очистка временных файлов
echo ""
echo "🧹 Cleaning temporary files..."
rm -f *.o
rm -f addon-*.node
rm -f *.swiftmodule *.swiftdoc *.swiftsourceinfo

echo ""
echo "✨ Build complete!"

# Финальная проверка
if [ -f "addon.node" ]; then
    echo ""
    echo "🎉 SUCCESS! Your addon.node is ready:"
    if lipo -info addon.node 2>/dev/null | grep -q "x86_64 arm64"; then
        echo "   ✅ Universal Binary (Intel + Apple Silicon)"
    elif lipo -info addon.node 2>/dev/null | grep -q "x86_64"; then
        echo "   ⚠️ Intel only (x86_64)"
    elif lipo -info addon.node 2>/dev/null | grep -q "arm64"; then
        echo "   ⚠️ Apple Silicon only (arm64)"
    else
        echo "   ℹ️ Single architecture"
    fi
else
    echo "❌ Build failed - addon.node not created"
    exit 1
fi


# ========================================
# 🧪 ФИНАЛЬНАЯ ПРОВЕРКА: ЗАГРУЗКА АДДОНА В ELECTRON (совместимо с Electron 37.x)
# ========================================

echo ""
echo "🧪 FINAL TEST: Loading addon in Electron runtime..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Убедимся, что бинарник можно запускать
if [ ! -x "$ELECTRON_BIN" ]; then
    echo "🔧 Fixing permissions for Electron binary..."
    chmod +x "$ELECTRON_BIN" || {
        echo "❌ Cannot make Electron binary executable"
        exit 1
    }
fi

if [ -f "addon.node" ]; then
    echo "📁 Testing in: $(pwd)"
    echo "🔍 Electron: $ELECTRON_BIN (v$ELECTRON_VERSION, ABI $ELECTRON_ABI)"

    # Создаём временный скрипт для теста
    TEST_SCRIPT="test-addon.js"
    cat > "$TEST_SCRIPT" << 'EOF'
require('./addon.node');
console.log('✅ SUCCESS: Addon loaded correctly in Electron ' + process.versions.electron + ' (ABI ' + process.versions.modules + ')');
process.exit(0);
EOF

    # Запускаем Electron с этим скриптом
    if "$ELECTRON_BIN" "$TEST_SCRIPT" 2>&1; then
        echo "🎉 CONGRATS! Your native addon is ready for Electron ${ELECTRON_VERSION}."
        rm -f "$TEST_SCRIPT"  # Удаляем временный файл
    else
        echo "❌ FAILURE: Addon could not be loaded. Check errors above."
        rm -f "$TEST_SCRIPT"
        exit 1
    fi
else
    echo "❌ addon.node not found. Build failed or incomplete."
    exit 1
fi