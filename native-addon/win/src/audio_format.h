#pragma once

#include <windows.h>
#include <mmreg.h>
#include <ks.h>
#include <ksmedia.h>

// DWMWA_CLOAKED для Windows 10+
#ifndef DWMWA_CLOAKED
#define DWMWA_CLOAKED 14
#endif

// Проверяем доступность KSDATAFORMAT
#ifndef KSDATAFORMAT_SUBTYPE_IEEE_FLOAT

// IEEE Float формат
const GUID KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = 
    {0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};

// PCM формат  
const GUID KSDATAFORMAT_SUBTYPE_PCM = 
    {0x00000001, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};

#endif

// Вспомогательная функция для сравнения GUID
inline bool CompareGUIDs(const GUID& guid1, const GUID& guid2) {
    return memcmp(&guid1, &guid2, sizeof(GUID)) == 0;
}

#ifndef WAVE_FORMAT_IEEE_FLOAT
#define WAVE_FORMAT_IEEE_FLOAT 0x0003
#endif

#ifndef WAVE_FORMAT_EXTENSIBLE
#define WAVE_FORMAT_EXTENSIBLE 0xFFFE
#endif

#ifndef WAVE_FORMAT_PCM
#define WAVE_FORMAT_PCM 0x0001
#endif

// Флаги для AUDCLNT
#ifndef AUDCLNT_STREAMFLAGS_LOOPBACK
#define AUDCLNT_STREAMFLAGS_LOOPBACK 0x00020000
#endif

#ifndef AUDCLNT_BUFFERFLAGS_SILENT
#define AUDCLNT_BUFFERFLAGS_SILENT 0x00000002
#endif