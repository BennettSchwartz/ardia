// Copyright 2026 Ardia. Apache-2.0.

#include <cstdio>
#include <optional>
#include <string>
#include <vector>

#include "chrome/browser/ardia/ac_cli_plugin_clipboard_keys.h"
#include "chrome/browser/ardia/ac_cli_plugin_input.h"

namespace {

int failures = 0;

void Expect(bool ok, const std::string& name, const std::string& detail) {
  if (!ok) {
    ++failures;
    std::printf("FAIL  %s  (%s)\n", name.c_str(), detail.c_str());
  }
}

ardia::PluginKeyEvent Key(std::optional<std::string> key,
                          std::optional<int> code,
                          int modifiers,
                          std::optional<std::string> dom_code = std::nullopt) {
  ardia::PluginKeyEvent event;
  event.type = "rawKeyDown";
  event.key = std::move(key);
  event.windows_key_code = code;
  event.modifiers = modifiers;
  event.code = std::move(dom_code);
  return event;
}

void Allowed(const ardia::PluginKeyEvent& event, const std::string& name) {
  const std::string refusal = ardia::PluginKeyRefusal(event);
  Expect(refusal.empty(), "allowed: " + name, refusal);
}

void Refused(const ardia::PluginKeyEvent& event, const std::string& name) {
  Expect(!ardia::PluginKeyRefusal(event).empty(), "refused: " + name,
         "no refusal");
}

const char* KeyForCode(int code) {
  switch (code) {
    case 45:
      return "Insert";
    case 46:
      return "Delete";
    case 67:
      return "c";
    case 86:
      return "v";
    case 88:
      return "x";
  }
  return "?";
}

}

int main() {
  using ardia::kCdpAlt;
  using ardia::kCdpCtrl;
  using ardia::kCdpMeta;
  using ardia::kCdpShift;

  Refused(Key("Insert", (2 << 16) | 45, 0), "a key code above 0xFFFF that forges Ctrl");
  Refused(Key("a", 256, 0), "a key code of 256");
  Refused(Key("a", -1, 0), "a negative key code");
  Refused(Key("a", 86, 0), "key a with the key code of v");
  Refused(Key("a", 65, 0, "KeyV"), "key a with the code KeyV");
  Refused(Key("ArrowLeft", 45, kCdpCtrl), "ArrowLeft with the key code of Insert");
  Refused(Key(";", 45, kCdpShift), "punctuation with the key code of Insert");
  Refused(Key(std::nullopt, 45, kCdpShift), "a key code with no key");
  ardia::PluginKeyEvent keyless_paste = Key(std::nullopt, 0, 0);
  keyless_paste.commands = {"paste"};
  Refused(keyless_paste, "no key, code 0, with commands paste");
  ardia::PluginKeyEvent keyless_copy = Key(std::nullopt, 0, 0);
  keyless_copy.commands = {"copy"};
  Refused(keyless_copy, "no key, code 0, with commands copy");
  ardia::PluginKeyEvent keyless_select = Key(std::nullopt, 0, 0);
  keyless_select.commands = {"selectAll"};
  Allowed(keyless_select, "no key with an allowed command");
  ardia::PluginKeyEvent key_up_command = Key("a", 65, kCdpMeta, "KeyA");
  key_up_command.type = "keyUp";
  key_up_command.commands = {"selectAll"};
  Refused(key_up_command, "commands on a keyUp");
  ardia::PluginKeyEvent char_command = Key("a", 0, 0);
  char_command.type = "char";
  char_command.commands = {"selectAll"};
  Refused(char_command, "commands on a char event");
  Allowed(Key("!", 49, kCdpShift, "Digit1"), "a shifted digit with its ordinary key code");
  Allowed(Key("\"", 222, kCdpShift, "Quote"), "a shifted quote");
  Refused(Key("a", 49, 0, "Digit1"), "key a with the code Digit1");
  Refused(Key("Shift", 17, kCdpShift, "ShiftLeft"), "Shift with Control's key code");
  Refused(Key("Shift", 16, kCdpShift, "KeyA"), "Shift with the code KeyA");
  Allowed(Key("Shift", 16, kCdpShift, "ShiftRight"), "Shift on the right with the generic key code");
  Allowed(Key("Meta", 93, kCdpMeta, "MetaRight"), "Meta on the right");
  Allowed(Key("\xc3\xa9", 0, 0), "a character the US layout doesn't have, with no key code");
  Refused(Key("\xc3\xa9", 69, 0), "a character the US layout doesn't have, with a key code");

  const int navigation_modifiers[] = {kCdpAlt, kCdpCtrl, kCdpMeta};
  const struct {
    const char* key;
    int code;
    const char* dom_code;
  } navigation[] = {
      {"ArrowLeft", 37, "ArrowLeft"}, {"ArrowUp", 38, "ArrowUp"},
      {"ArrowRight", 39, "ArrowRight"}, {"ArrowDown", 40, "ArrowDown"},
      {"Home", 36, "Home"}, {"End", 35, "End"},
      {"PageUp", 33, "PageUp"}, {"PageDown", 34, "PageDown"},
  };
  for (const auto& nav : navigation) {
    for (int modifier : navigation_modifiers) {
      for (int shift : {0, kCdpShift}) {
        Allowed(Key(nav.key, nav.code, modifier | shift, nav.dom_code),
                std::string(nav.key) + " with modifiers " +
                    std::to_string(modifier | shift));
      }
    }
  }
  Allowed(Key("a", 65, kCdpCtrl, "KeyA"), "Ctrl+A");
  Allowed(Key("a", 65, kCdpMeta, "KeyA"), "Meta+A");
  for (int modifier : {kCdpCtrl, kCdpMeta}) {
    Allowed(Key("Backspace", 8, modifier, "Backspace"),
            "Backspace with modifier " + std::to_string(modifier));
  }
  for (int modifier : navigation_modifiers) {
    Allowed(Key("Delete", 46, modifier, "Delete"),
            "Delete with modifier " + std::to_string(modifier));
  }
#if !defined(_WIN32)
  Allowed(Key("Backspace", 8, kCdpAlt, "Backspace"), "macOS word deletion with Alt+Backspace");
#else
  Refused(Key("Backspace", 8, kCdpAlt, "Backspace"), "Alt+Backspace, which undoes on Windows");
#endif
  Allowed(Key("Enter", 13, kCdpShift, "Enter"), "Shift+Enter");
  Allowed(Key("Tab", 9, kCdpShift, "Tab"), "Shift+Tab");
  Allowed(Key("h", 72, 0, "KeyH"), "plain typing");
  Allowed(Key("H", 72, kCdpShift, "KeyH"), "Shift+letter");
  Allowed(Key("7", 55, 0, "Digit7"), "a digit");
  Allowed(Key("Control", 17, kCdpCtrl, "ControlLeft"), "pressing Control");
  Allowed(Key("Shift", 16, kCdpShift, "ShiftLeft"), "pressing Shift");
  ardia::PluginKeyEvent select_all = Key("a", 65, kCdpMeta, "KeyA");
  select_all.commands = {"selectAll"};
  Allowed(select_all, "Meta+A with selectAll");

  Refused(Key("a", 65, kCdpAlt, "KeyA"), "Alt+A");
  Refused(Key("c", 67, kCdpMeta, "KeyC"), "Meta+C");
  Refused(Key("v", 86, kCdpMeta, "KeyV"), "Meta+V");
  Refused(Key("Insert", 45, kCdpCtrl, "Insert"), "Ctrl+Insert");
  Refused(Key("Insert", 45, kCdpShift, "Insert"), "Shift+Insert");
  Refused(Key("Delete", 46, kCdpShift, "Delete"), "Shift+Delete");
  Refused(Key("Delete", 46, kCdpCtrl | kCdpShift, "Delete"), "Ctrl+Shift+Delete");
  Refused(Key("Copy", 0, 0), "the Copy key");
  Refused(Key("Cut", 0, 0), "the Cut key");
  Refused(Key("Paste", 0, 0), "the Paste key");
  Refused(Key("a", 65, 16, "KeyA"), "an unknown modifier bit");
  ardia::PluginKeyEvent native = Key("a", 65, 0, "KeyA");
  native.has_native_key_code = true;
  Refused(native, "a native key code");
  ardia::PluginKeyEvent system = Key("a", 65, 0, "KeyA");
  system.has_system_key = true;
  Refused(system, "a system key");
  ardia::PluginKeyEvent paste = Key("v", 86, 0, "KeyV");
  paste.commands = {"paste"};
  Refused(paste, "the paste command");

  for (const ardia::PluginClipboardKey& entry : ardia::kPluginClipboardKeys) {
    const std::string key =
        entry.dom_key[0] ? entry.dom_key : KeyForCode(entry.windows_key_code);
    Refused(Key(key, entry.dom_key[0] ? 0 : entry.windows_key_code,
                entry.modifiers),
            "clipboard table entry " + key + " with modifiers " +
                std::to_string(entry.modifiers));
  }

  const auto mouse = [](std::optional<std::string> type,
                        std::optional<std::string> button,
                        std::optional<int> buttons) {
    return ardia::PluginMouseRefusal(type, button, buttons);
  };
  Expect(mouse(std::string("mouseMoved"), std::nullopt, std::nullopt).empty(),
         "allowed: a move with no button", "");
  Expect(mouse(std::string("mouseMoved"), std::string("none"), 0).empty(),
         "allowed: a move with button none and buttons 0", "");
  Expect(mouse(std::string("mouseWheel"), std::nullopt, 0).empty(),
         "allowed: a wheel event", "");
  Expect(!mouse(std::string("mousePressed"), std::string("left"), 1).empty(),
         "refused: mousePressed", "");
  Expect(!mouse(std::string("mouseReleased"), std::string("left"), 0).empty(),
         "refused: mouseReleased", "");
  Expect(!mouse(std::string("mouseMoved"), std::nullopt, 1).empty(),
         "refused: a move with the left button held", "");
  Expect(!mouse(std::string("mouseMoved"), std::string("left"), 0).empty(),
         "refused: a move naming a button", "");
  Expect(!mouse(std::string("mouseWheel"), std::nullopt, 4).empty(),
         "refused: a wheel event with the middle button held", "");
  Expect(!mouse(std::nullopt, std::nullopt, std::nullopt).empty(),
         "refused: no event type", "");
  Expect(ardia::PluginClickRefusal(std::nullopt, std::nullopt, std::nullopt)
             .empty(),
         "allowed: a plain click", "");
  Expect(ardia::PluginClickRefusal(std::string("right"), 2, 8).empty(),
         "allowed: a right double click with Shift", "");
  Expect(!ardia::PluginClickRefusal(std::string("middle"), 1, 0).empty(),
         "refused: a middle click", "");
  Expect(!ardia::PluginClickRefusal(std::string("left"), 4, 0).empty(),
         "refused: four clicks", "");
  Expect(!ardia::PluginClickRefusal(std::string("left"), 0, 0).empty(),
         "refused: zero clicks", "");
  Expect(!ardia::PluginClickRefusal(std::string("left"), 1, 16).empty(),
         "refused: unknown modifier bits", "");

  std::printf("%s\n", failures ? "FAILED" : "OK");
  return failures ? 1 : 0;
}
