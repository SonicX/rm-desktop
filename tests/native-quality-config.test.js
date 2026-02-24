"use strict";

const fs = require("node:fs");
const path = require("node:path");

const test = require("tape");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("capture presets stay in 30-60 fps range", (t) => {
  const source = read("app/main/native-capture.ts");

  const presetKeys = [
    "ULTRALOW",
    "LOW",
    "MEDIUM",
    "HIGH",
    "ULTRAHIGH",
    "PRESENTATION",
    "SCREENSHARE",
  ];

  for (const key of presetKeys) {
    t.ok(source.includes(`${key}: {`), `preset '${key}' exists`);
  }

  const fpsMatches = [...source.matchAll(/fps:\s*(\d+)/g)].map((m) =>
    Number.parseInt(m[1], 10),
  );
  t.ok(fpsMatches.length >= presetKeys.length, "found fps values in presets");
  for (const fps of fpsMatches) {
    t.ok(fps >= 30 && fps <= 60, `fps ${fps} is in 30..60`);
  }

  t.equal(
    source.includes(
      "private currentQuality: CaptureQuality = CAPTURE_PRESETS.MEDIUM.quality",
    ),
    true,
    "default preset is MEDIUM",
  );

  t.end();
});

test("windows addon has no volume controller and keeps fps clamp 30-60", (t) => {
  const source = read("native-addon/win/src/main.cpp");

  t.equal(
    source.includes("class VolumeController"),
    false,
    "VolumeController removed",
  );
  t.equal(
    source.includes("setParticipantsVolume"),
    false,
    "setParticipantsVolume export removed",
  );
  t.equal(
    source.includes("getParticipantsVolume"),
    false,
    "getParticipantsVolume export removed",
  );
  t.equal(
    source.includes("fps = (std::max)(30, (std::min)(60, fps));"),
    true,
    "setCaptureQuality clamps fps to 30..60",
  );
  t.equal(
    source.includes("targetFps = (std::max)(30, (std::min)(60, fps));"),
    true,
    "DXGI SetQuality clamps fps to 30..60",
  );

  t.end();
});

test("mac addon keeps isolation path and clamps fps to 30-60", (t) => {
  const source = read("native-addon/src/ScreenCaptureManager.swift");

  t.equal(
    source.includes("requestedFPS = max(30, min(60, fps))"),
    true,
    "mac setCaptureQuality clamps fps to 30..60",
  );
  t.equal(
    source.includes("streamConfig.capturesAudio = true"),
    true,
    "system audio capture stays enabled",
  );
  t.equal(
    source.includes("streamConfig.excludesCurrentProcessAudio = true"),
    true,
    "audio isolation flag stays enabled",
  );

  t.end();
});

test("addon quality setter supports mac and windows call styles", (t) => {
  const source = read("app/main/native-capture.ts");

  t.equal(
    source.includes("this.state.addon.setCaptureQuality({"),
    true,
    "object payload call remains for Windows addon",
  );
  t.equal(
    source.includes("this.state.addon.setCaptureQuality("),
    true,
    "positional args call exists for mac addon",
  );
  t.equal(
    source.includes("// macOS addon wrapper expects positional numeric args."),
    true,
    "compatibility fallback documented",
  );

  t.end();
});

test("jitsi sdk manager exposes native quality controls", (t) => {
  const source = read("app/main/jitsi-sdk-manager.ts");

  t.equal(
    source.includes('"jitsi:change-native-quality"'),
    true,
    "SDK manager exposes jitsi:change-native-quality",
  );
  t.equal(
    source.includes('"jitsi:set-native-custom-quality"'),
    true,
    "SDK manager exposes jitsi:set-native-custom-quality",
  );
  t.equal(
    source.includes('"jitsi:change-video-quality"'),
    true,
    "SDK manager keeps compatibility alias jitsi:change-video-quality",
  );
  t.equal(
    source.includes("await this.injectQualityControls();"),
    true,
    "SDK manager injects quality controls in conference window",
  );
  t.equal(
    source.includes("const PANEL_ID = 'electron-quality-controls';"),
    true,
    "SDK quality controls panel is injected",
  );
  t.equal(
    source.includes("triggerButton.textContent = '⚙️';"),
    true,
    "SDK quality gear button exists",
  );
  t.equal(
    source.includes("closeButton.textContent = '✕';"),
    true,
    "SDK quality panel close button exists",
  );
  t.equal(
    source.includes("applyButton.textContent = 'Сохранить';"),
    true,
    "SDK quality panel has save button",
  );
  t.equal(
    source.includes("panel.style.cssText = 'display:none;"),
    true,
    "SDK quality panel is hidden by default",
  );

  t.end();
});
