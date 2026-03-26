# Letter to OSSign (info@ossign.org)

**Subject:** Application for Free Open Source Code Signing — RMConnect (Связь РМ)

---

Dear OSSign Team,

I am writing to apply for free code signing for our open source project **RMConnect** (marketed as "Связь РМ") — a cross-platform desktop communication application built on Electron.

## Project Overview

- **Name:** RMConnect / Связь РМ
- **Description:** A cross-platform desktop communication and collaboration app (messaging, voice/video calls, screen sharing with loopback audio capture). Built on Electron + TypeScript.
- **License:** Apache-2.0
- **Repository:** https://github.com/SonicX/rm-desktop (GitHub mirror)
- **Primary Repository:** https://gitverse.ru/tsifrovye_tekhnologii_rm/rm-desktop
- **Current Version:** 5.27.5
- **Platforms:** Windows (NSIS installer), macOS (MAS)

## Project History & Activity

- **Project age:** Since 2016 (based on a fork of Zulip Desktop, extensively modified)
- **Total commits:** 2,282
- **Contributors:** 70+
- **Releases:** 15 tagged releases (v5.20.0 through v5.27.5)
- **Status:** Actively maintained with regular commits and releases
- **Tech stack:** Electron, TypeScript, Vite, native C++ addon for Windows audio capture

## Why We Need Code Signing

We currently distribute Windows builds (.exe/.msi) to our users. Without a trusted code signing certificate, Windows SmartScreen displays "Unknown Publisher" warnings, which erodes user trust and creates friction during installation. We previously used a purchased certificate, but it has expired, and as a small open source team we are looking for a sustainable free solution.

## What We Need Signed

- Windows NSIS installer (.exe)
- Native addon (.node / .dll) files
- Potentially .msi packages in the future

## Build Process

Our build pipeline uses:
- `vite build` for the Electron app
- `electron-builder` with NSIS target for Windows
- Custom `scripts/sign.js` + `scripts/sign.bat` for signtool integration
- We can adapt our CI/CD to integrate with your signing workflow

## Contact Information

- **Maintainer:** Yuriy Tereshchenko
- **Email:** yuriy.tereschenko@yandex.ru
- **Organization:** Цифровые технологии РМ (Digital Technologies RM)

I understand that applications are currently suspended due to high workload. I would be grateful if you could add us to the queue, or let us know when applications reopen.

Thank you for supporting open source developers!

Best regards,
Yuriy Tereshchenko
