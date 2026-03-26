# Letter to SignPath Foundation (oss-support@signpath.org)

**Subject:** Application for Free SignPath.io Subscription — RMConnect (Open Source, Apache-2.0)

---

Dear SignPath Foundation Team,

I would like to apply for a free SignPath.io subscription for our open source project **RMConnect**.

I was unable to download the OSSRequestForm-v4.xlsx from your website (it returned a server error), so I am providing all the required information in this email. If you could send me the form directly, I will be happy to fill it out as well.

---

## Section 1: Basic Information

- **Project Name:** RMConnect (Связь РМ)
- **Project Short Name:** rm-desktop
- **Project Homepage:** https://gitverse.ru/tsifrovye_tekhnologii_rm/rm-desktop
- **License:** Apache-2.0
- **License URL:** https://gitverse.ru/tsifrovye_tekhnologii_rm/rm-desktop/blob/main/LICENSE
- **Programming Languages:** TypeScript, JavaScript, C++ (native addon)

**Project Description (Brief):**
RMConnect is a cross-platform open source desktop communication application built on Electron. It provides messaging, voice/video calls, and screen sharing with native audio capture for Windows.

**Project Description (Detailed):**
RMConnect (marketed as "Связь РМ") is an Electron-based desktop client for team communication and collaboration. Originally forked from Zulip Desktop and extensively modified, it has evolved into an independent product with unique features including:

- Real-time messaging and notifications
- Jitsi-based voice and video conferencing integration
- Screen sharing with Windows Process Loopback audio capture (native C++ addon)
- Bidirectional voice chat during streaming
- Cross-platform support (Windows via NSIS installer, macOS via MAS)
- Global keyboard shortcuts via native key listener
- Auto-update functionality

All source code is publicly available under the Apache-2.0 license.

---

## Section 2: Repository Information

- **Repository Type:** Git (GitHub + Gitverse mirror)
- **GitHub Repository URL:** https://github.com/SonicX/rm-desktop
- **Primary Repository URL:** https://gitverse.ru/tsifrovye_tekhnologii_rm/rm-desktop
- **Number of Contributors:** 70+
- **Number of Commits:** 2,282
- **Project Age:** Since June 2016 (~10 years)
- **Development Status:** Active — regular commits and releases

---

## Section 3: Distribution & Downloads

- **Download/Releases Page:** https://gitverse.ru/tsifrovye_tekhnologii_rm/rm-desktop/releases
- **Package Formats:** Windows NSIS installer (.exe), macOS (.app via MAS)
- **Distribution Method:** Direct download from Gitverse releases
- **Release Tags:** 15 tagged releases (v5.20.0 through current v5.27.5)

---

## Section 4: Privacy

- **Does the software collect user data?** No. RMConnect connects to a user-configured server. No telemetry, analytics, or data is sent to the developers or any third party.
- **What data is transmitted?** Only communication data (messages, calls) to the user's own configured server instance. No external services are contacted.

---

## Section 5: What Will Be Signed

- **File Types:** .exe (NSIS Windows installer), .node/.dll (native addon)
- **Signing Frequency:** Per release, approximately 1-2 releases per month
- **Build Process:** `vite build` → `electron-builder --windows --config.win.target=nsis`
- **Current Signing:** We use `signtool.exe` via custom `scripts/sign.js` and `scripts/sign.bat`. Integration with SignPath CI/CD would require minimal changes.

---

## Section 6: Verification & Trust Evidence

**Repository Metrics:**
- 2,282 commits across 10 years of development
- 70+ contributors
- 15 tagged releases
- Active issue tracking and maintenance
- Multi-platform builds (Windows + macOS)

**Code Quality:**
- TypeScript with strict configuration
- ESLint + Stylelint for code quality
- Electron-builder for reproducible builds
- Native C++ addon with proper signing verification

**Open Source Confirmation:**
- ✅ Licensed under Apache-2.0 (OSI-approved)
- ✅ All source code is publicly available
- ✅ No commercial dual-licensing
- ✅ No proprietary components (uses only open source dependencies)
- ✅ Actively maintained with regular releases
- ✅ No malware or hacking tools

---

## Section 7: Contact Information

- **Primary Contact:** Yuriy Tereshchenko
- **Email:** yuriy.tereschenko@yandex.ru
- **Organization:** Цифровые технологии РМ (Digital Technologies RM)
- **Repository:** https://gitverse.ru/tsifrovye_tekhnologii_rm/rm-desktop

---

I confirm that I have read and agree to the SignPath Foundation Terms of Use and Code of Conduct. I commit to using the certificate exclusively for signing our open source project's releases.

Thank you for supporting the open source community. I look forward to hearing from you.

Best regards,
Yuriy Tereshchenko
