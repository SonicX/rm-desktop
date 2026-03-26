# Reply to SignPath (Phillip Deng)

**Subject:** Re: Application for Free SignPath.io Subscription — RMConnect (Open Source, Apache-2.0)

---

Hi Phillip,

Thank you for the quick and detailed response! Great news that GitHub Actions is supported — we have our project mirrored on GitHub and have prepared everything according to SignPath Foundation requirements.

## GitHub Repository

**https://github.com/SonicX/rm-desktop**

## What we've set up

1. **GitHub Actions CI workflow** for the full Windows build:
   - Native C++ addon build (node-gyp + WASAPI)
   - Electron app build (Vite + TypeScript)
   - Packaging with electron-builder (NSIS installer)
   - Workflow: `.github/workflows/build-and-package-win.yml`

2. **Code Signing Policy** in README.md — includes team roles, signing process description, and verification instructions as per SignPath Foundation requirements.

3. **Privacy Policy** (PRIVACY.md) — RMConnect does not collect or transmit any user data. It connects only to the server URL configured by the user.

4. **Branch protection** on `main` — requires pull request review before merge.

5. **Team roles defined:**
   - Committers & Reviewers: [SonicX](https://github.com/SonicX)
   - Release Approvers: [SonicX](https://github.com/SonicX)

## Project summary

- **Project:** RMConnect (Связь РМ) — desktop communication client
- **License:** Apache-2.0
- **Age:** Since 2016, 2,282 commits, 70+ contributors, 15 releases
- **Tech:** Electron + TypeScript + Vite, native C++ addon (WASAPI audio capture)
- **Platforms:** Windows (NSIS), macOS (MAS)
- **Files to sign:** .exe (NSIS installer), .node/.dll (native addon)

## Regarding the application form

Unfortunately, the OSSRequestForm-v4.xlsx link on signpath.org returned a server error (HTTP 500) when I tried to download it. Could you please attach it directly? I will fill it out and send it back right away.

Looking forward to proceeding!

Best regards,
Yuriy Tereshchenko
yuriy.tereschenko@yandex.ru
