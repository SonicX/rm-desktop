"use strict";

const test = require("tape");

const {
  getPressedKeyNameFromEvent,
  normalizeHotkeyString,
  normalizeKeyNameForMatch,
} = require("../app/main/hotkey-utils.js");

test("hotkey aliases normalize to side mouse names", (t) => {
  t.equal(normalizeHotkeyString("Mouse4"), "mouse x1");
  t.equal(normalizeHotkeyString("mouse 5"), "mouse x2");
  t.equal(normalizeHotkeyString("XButton1"), "mouse x1");
  t.equal(normalizeHotkeyString("xbutton2"), "mouse x2");
  t.equal(normalizeHotkeyString("BrowserBack"), "mouse x1");
  t.equal(normalizeHotkeyString("Browser_Forward"), "mouse x2");
  t.end();
});

test("pressed key name prefers listener standard name", (t) => {
  const event = {name: "MOUSE X1", vKey: 0};
  const name = getPressedKeyNameFromEvent(event, "win32", {
    mac: {},
    win: {},
  });
  t.equal(name, "MOUSE X1");
  t.end();
});

test("pressed key name falls back to vKey maps", (t) => {
  const winEvent = {vKey: 166};
  const macEvent = {vKey: 4};

  const winName = getPressedKeyNameFromEvent(winEvent, "win32", {
    mac: {},
    win: {166: "BROWSER BACK"},
  });
  const macName = getPressedKeyNameFromEvent(macEvent, "darwin", {
    mac: {4: "MOUSE X2"},
    win: {},
  });

  t.equal(winName, "BROWSER BACK");
  t.equal(macName, "MOUSE X2");
  t.end();
});

test("integration: configured alias matches emitted mouse event", (t) => {
  const configuredHotkey = normalizeHotkeyString("BrowserBack");
  const emittedEventName = getPressedKeyNameFromEvent(
    {name: "MOUSE X1", vKey: 5},
    "win32",
    {mac: {}, win: {}},
  );

  const normalizedMainKey = normalizeKeyNameForMatch(configuredHotkey);
  const normalizedPressed = normalizeKeyNameForMatch(
    emittedEventName.toLowerCase(),
  );

  t.equal(normalizedMainKey, "mouse x1");
  t.equal(normalizedPressed, "mouse x1");
  t.equal(normalizedMainKey, normalizedPressed);
  t.end();
});
