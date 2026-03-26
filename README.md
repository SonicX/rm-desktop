# RMConnect (Связь РМ)

Cross-platform open source desktop communication app built on Electron.

Чат Телеграмм — https://t.me/DMVoise
Страничка ВК — https://vk.com/only_my_link

## Download

See https://rusmanul.com/main

## Features

- Real-time messaging with desktop notifications and inline reply
- Jitsi-based voice and video conferencing
- Screen sharing with native Windows audio capture (Process Loopback)
- System tray / dock integration
- Multi-language spell checking
- Cross-platform: Windows, macOS

## Tech Stack

- Electron + TypeScript + Vite
- Native C++ addon for Windows audio capture (WASAPI)
- electron-builder (NSIS installer for Windows, MAS for macOS)

## Building from Source

```bash
npm install
npm run build-for-win        # Build for Windows
npm run dist-win              # Build + package NSIS installer
```

## Code Signing Policy

RMConnect releases are signed using a certificate provided by [SignPath Foundation](https://signpath.org/).

### Team Roles

- **Committers & Reviewers:** [SonicX](https://github.com/SonicX)
- **Release Approvers:** [SonicX](https://github.com/SonicX)

### Signing Process

All signed Windows release artifacts are built from source code in this public repository using GitHub Actions. Each release requires manual approval before signing. The build process is fully automated, reproducible, and publicly verifiable.

### Verification

Signed binaries can be verified by checking the digital signature in Windows file properties. The publisher will be listed as "SignPath Foundation".

## Privacy Policy

See [PRIVACY.md](./PRIVACY.md).

**Summary:** This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it. RMConnect connects only to the server URL configured by the user. No telemetry, analytics, or data is collected or sent to the developers or any third party.

## License

Released under the [Apache-2.0](./LICENSE) license.

---
