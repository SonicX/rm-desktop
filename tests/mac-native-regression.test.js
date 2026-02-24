"use strict";

const fs = require("node:fs");
const path = require("node:path");

const test = require("tape");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("mac swift addon keeps release-safe quality and audio isolation", (t) => {
  const source = read("native-addon/src/ScreenCaptureManager.swift");

  t.ok(
    source.includes("requestedFPS = max(30, min(60, fps))"),
    "fps clamp stays in 30..60",
  );
  t.ok(
    source.includes("streamConfig.capturesAudio = true"),
    "system audio capture remains enabled",
  );
  t.ok(
    source.includes("streamConfig.excludesCurrentProcessAudio = true"),
    "current process audio isolation remains enabled",
  );
  t.ok(
    source.includes("startCapture called with mode:"),
    "capture start path is present",
  );
  t.ok(
    source.includes("captureMode == .audioAndVideo"),
    "audio+video mode handling remains present",
  );

  t.end();
});

test("native capture manager keeps mac quality application path", (t) => {
  const source = read("app/main/native-capture.ts");

  t.ok(
    source.includes(
      "private async applyCaptureQualityToAddon(): Promise<void>",
    ),
    "quality apply helper exists",
  );
  t.ok(
    source.includes("this.state.addon.setCaptureQuality({"),
    "object-style quality call remains (cross-platform path)",
  );
  t.ok(
    source.includes("this.state.addon.setCaptureQuality("),
    "positional quality call remains for mac addon wrapper",
  );
  t.ok(
    source.includes("[NATIVE-CAPTURE] Applied native quality:"),
    "applied-quality log marker remains",
  );
  t.ok(
    source.includes("fps: Math.max(30, Math.min(60, quality.fps))"),
    "ts-level quality normalization keeps 30..60 fps",
  );

  t.end();
});

test("jitsi sdk manager keeps native audio bridge hooks", (t) => {
  const source = read("app/main/jitsi-sdk-manager.ts");

  t.ok(
    source.includes("[NATIVE-AUDIO] Initializing native audio bridge"),
    "native audio bridge initialization log exists",
  );
  t.ok(
    source.includes("[NATIVE-AUDIO] getDisplayMedia overridden"),
    "getDisplayMedia interception remains",
  );
  t.ok(
    source.includes("[NATIVE-AUDIO] JitsiMeetJS.createLocalTracks overridden"),
    "createLocalTracks interception remains",
  );
  t.ok(
    source.includes(
      "[NATIVE-AUDIO] Found desktop video track, injecting native audio...",
    ),
    "desktop video + native audio injection path remains",
  );
  t.ok(
    source.includes("[NATIVE-AUDIO] Now returning"),
    "hybrid track return marker remains",
  );

  t.end();
});
