"use strict";

const fs = require("node:fs");
const path = require("node:path");

const test = require("tape");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("windows native addon keeps quality API and clamps", (t) => {
  const source = read("native-addon/win/src/main.cpp");

  t.ok(
    source.includes(
      'napi_has_named_property(env, argv[0], "width", &hasWidth);',
    ),
    "object quality payload support remains",
  );
  t.ok(
    source.includes("width = (std::max)(320, (std::min)(3840, width));"),
    "width is clamped to release-safe range",
  );
  t.ok(
    source.includes("height = (std::max)(240, (std::min)(2160, height));"),
    "height is clamped to release-safe range",
  );
  t.ok(
    source.includes("fps = (std::max)(30, (std::min)(60, fps));"),
    "fps is clamped to 30..60",
  );
  t.ok(
    source.includes("g_screenCapture->SetQuality(width, height, fps);"),
    "quality update is pushed to active DXGI capture",
  );

  t.end();
});

test("windows native addon exports capture quality entry points", (t) => {
  const source = read("native-addon/win/src/main.cpp");

  t.ok(
    source.includes("NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)"),
    "module init macro remains",
  );
  t.ok(
    source.includes('{"setCaptureQuality", nullptr, SetCaptureQuality,'),
    "setCaptureQuality export remains",
  );
  t.ok(
    source.includes('{"startCapture", nullptr, StartCapture,'),
    "startCapture export remains",
  );
  t.ok(
    source.includes('{"stopCapture", nullptr, StopCapture,'),
    "stopCapture export remains",
  );

  t.end();
});
