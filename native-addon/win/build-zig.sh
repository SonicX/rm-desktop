#!/bin/bash

echo "Building Windows native module with Zig..."

# Очистка
rm -rf build
mkdir -p build

# Компиляция с Zig CC
export CC="zig cc -target x86_64-windows"
export CXX="zig c++ -target x86_64-windows"
export AR="zig ar"

# Установка путей для Windows SDK (если есть через Wine)
export INCLUDE="/usr/share/mingw-w64/include"
export LIB="/usr/share/mingw-w64/lib"

# Компиляция
cd build

# Используем node-gyp с кросс-компиляцией
node-gyp configure --target=v18.0.0 --arch=x64 --dist-url=https://electronjs.org/headers
node-gyp build --target=v18.0.0 --arch=x64

echo "Build complete!"