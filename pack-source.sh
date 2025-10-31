#!/bin/bash

# Имя выходного файла
OUTPUT="zulip-dart-sources.txt"

# Очищаем выходной файл
> "$OUTPUT"

echo "Начинаем сбор .dart-файлов... (исключаем build/, .git/, .dart_tool/ и др.)"

# Основная команда find
find . \
  # Исключаем тяжёлые папки
  -path "./build" -prune -o \
  -path "./.dart_tool" -prune -o \
  -path "./.git" -prune -o \
  -path "./ios/Pods" -prune -o \
  -path "./android/app/build" -prune -o \
  # Оставляем только .dart-файлы размером до 1 МБ
  -type f -name "*.dart" -size -1M \
  # Для каждого найденного файла:
  -print -exec sh -c '
    echo "=== FILE: $1 ===" >> "'$OUTPUT'";
    cat "$1" >> "'$OUTPUT'";
    echo "" >> "'$OUTPUT'"
  ' sh {} \;

echo "Готово! Все .dart-файлы собраны в: $OUTPUT"
echo "Размер файла: $(ls -lh "$OUTPUT" | awk "{print $5}")"
