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
ELECTRON_VERSION=$(node -p "
    const pkg = require('$PACKAGE_JSON');
    const version = pkg.devDependencies?.electron || pkg.dependencies?.electron || '';
    version.replace(/[\^~]/, '')
")

if [ -z "$ELECTRON_VERSION" ]; then
    echo "❌ Electron version not found in package.json"
    exit 1
fi

# Определяем ABI версию для этой версии Electron
# ВАЖНО: Используем точное соответствие минорной версии!
get_electron_abi() {
    local version=$1
    local major=$(echo $version | cut -d. -f1)
    local minor=$(echo $version | cut -d. -f2)
    
    # Точное соответствие версий Electron -> ABI
    if [ "$major" = "32" ]; then
        if [ "$minor" = "3" ]; then
            echo "125"  # Electron 32.3.x использует ABI 125
        else
            echo "125"  # Все версии Electron 32.x используют ABI 125
        fi
    else
        case $major in
            29) echo "121" ;;
            30) echo "121" ;;
            31) echo "124" ;;
            33) echo "127" ;;
            34) echo "128" ;;
            *)
                # Если версия не в таблице, пытаемся получить через API
                echo "$(curl -s https://releases.electronjs.org/releases.json | \
                    node -p "JSON.parse(require('fs').readFileSync(0)).find(r => r.version === 'v${version}')?.modules || '125'")"
                ;;
        esac
    fi
}

ELECTRON_ABI=$(get_electron_abi $ELECTRON_VERSION)

echo "✅ Detected Electron ${ELECTRON_VERSION} (ABI ${ELECTRON_ABI})"
echo "📦 Using package.json from: $PACKAGE_JSON"

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
    echo "🔨 Compiling C++ for $arch (Electron ${ELECTRON_VERSION}, ABI ${ELECTRON_ABI})..."
    
    local clang_arch=$arch
    if [ "$arch" = "x86_64" ]; then
        clang_arch="x86_64"
    elif [ "$arch" = "arm64" ]; then
        clang_arch="arm64"
    fi
    
    # КРИТИЧЕСКОЕ ИЗМЕНЕНИЕ: используем Electron headers вместо системных!
    # НЕ передаем NODE_MODULE_VERSION через -D, так как он уже в headers
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
        -DNAPI_DISABLE_CPP_EXCEPTIONS \
        -DBUILDING_NODE_EXTENSION \
        -o webrtc_wrapper-$arch.o \
        "$CPP_FILE"
    
    if [ ! -f "webrtc_wrapper-$arch.o" ]; then
        echo "❌ C++ compilation failed for $arch"
        echo "   Check that Electron headers are properly downloaded"
        return 1
    fi
    echo "✅ C++ compiled for $arch with Electron ABI ${ELECTRON_ABI}"
    return 0
}

# Функция для линковки для конкретной архитектуры
link_for_arch() {
    local arch=$1
    echo "🔗 Linking for $arch (Electron ${ELECTRON_VERSION})..."
    
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
    echo "✅ Linked for $arch (Electron ABI ${ELECTRON_ABI})"
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
        echo "📊 Build details:"
        echo "   Electron version: ${ELECTRON_VERSION}"
        echo "   Node ABI version: ${ELECTRON_ABI}"
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
echo "✨ Build complete for Electron ${ELECTRON_VERSION} (ABI ${ELECTRON_ABI})!"

# Финальная проверка
if [ -f "addon.node" ]; then
    echo ""
    echo "🎉 SUCCESS! Your addon.node is ready for Electron ${ELECTRON_VERSION}:"
    if lipo -info addon.node 2>/dev/null | grep -q "x86_64 arm64"; then
        echo "   ✅ Universal Binary (Intel + Apple Silicon)"
        echo "   📊 Electron version: ${ELECTRON_VERSION}"
        echo "   📊 Node ABI version: ${ELECTRON_ABI}"
    elif lipo -info addon.node 2>/dev/null | grep -q "x86_64"; then
        echo "   ⚠️ Intel only (x86_64)"
        echo "   📊 Electron version: ${ELECTRON_VERSION}"
        echo "   📊 Node ABI version: ${ELECTRON_ABI}"
    elif lipo -info addon.node 2>/dev/null | grep -q "arm64"; then
        echo "   ⚠️ Apple Silicon only (arm64)"
        echo "   📊 Electron version: ${ELECTRON_VERSION}"
        echo "   📊 Node ABI version: ${ELECTRON_ABI}"
    else
        echo "   ℹ️ Single architecture"
    fi
    
    echo ""
    echo "📝 To verify this addon works with your Electron:"
    echo "   cd .. && npm start"
else
    echo "❌ Build failed - addon.node not created"
    exit 1
fi