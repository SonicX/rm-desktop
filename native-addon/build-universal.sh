#!/bin/bash

echo "🚀 Building TRUE Universal Binary (Intel + Apple Silicon)"
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
        -I/usr/local/include/node \
        -I"$(node -p 'require("path").dirname(process.execPath) + "/../include/node"')" \
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