#pragma once

#include <windows.h>
#include <guiddef.h>

// Проверяем и определяем GUID для аудио форматов
#ifndef GUID_DEFINED
#define GUID_DEFINED
typedef struct _GUID {
    unsigned long  Data1;
    unsigned short Data2;
    unsigned short Data3;
    unsigned char  Data4[8];
} GUID;
#endif

// Определения GUID для форматов
static const GUID KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = 
    {0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};

static const GUID KSDATAFORMAT_SUBTYPE_PCM = 
    {0x00000001, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};

// DWMWA_CLOAKED для Windows 10+
#ifndef DWMWA_CLOAKED
#define DWMWA_CLOAKED 14
#endif

// Функция сравнения GUID
inline bool IsEqualGUID(const GUID& guid1, const GUID& guid2) {
    return memcmp(&guid1, &guid2, sizeof(GUID)) == 0;
}

// Дополнительные определения для WAVEFORMATEXTENSIBLE
#ifndef WAVE_FORMAT_EXTENSIBLE
#define WAVE_FORMAT_EXTENSIBLE 0xFFFE
#endif

typedef struct {
    WAVEFORMATEX Format;
    union {
        WORD wValidBitsPerSample;
        WORD wSamplesPerBlock;
        WORD wReserved;
    } Samples;
    DWORD dwChannelMask;
    GUID SubFormat;
} WAVEFORMATEXTENSIBLE, *PWAVEFORMATEXTENSIBLE;