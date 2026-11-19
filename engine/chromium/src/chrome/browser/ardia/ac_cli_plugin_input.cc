// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_plugin_input.h"

#include <algorithm>
#include <cctype>
#include <set>
#include <string>
#include <string_view>

#include "chrome/browser/ardia/ac_cli_plugin_clipboard_keys.h"

namespace ardia {
namespace {

struct NamedKey {
  std::string_view key;
  int windows_key_code;
  std::string_view code;
  std::string_view other_code;
};

constexpr NamedKey kNamedKeys[] = {
    {"Backspace", 8, "Backspace", ""},
    {"Tab", 9, "Tab", ""},
    {"Enter", 13, "Enter", "NumpadEnter"},
    {"Escape", 27, "Escape", ""},
    {" ", 32, "Space", ""},
    {"PageUp", 33, "PageUp", ""},
    {"PageDown", 34, "PageDown", ""},
    {"End", 35, "End", ""},
    {"Home", 36, "Home", ""},
    {"ArrowLeft", 37, "ArrowLeft", ""},
    {"ArrowUp", 38, "ArrowUp", ""},
    {"ArrowRight", 39, "ArrowRight", ""},
    {"ArrowDown", 40, "ArrowDown", ""},
    {"Insert", 45, "Insert", ""},
    {"Delete", 46, "Delete", ""},
};

constexpr std::string_view kModifierKeys[] = {
    "Shift", "Control", "Alt", "Meta", "CapsLock",
};

constexpr int kModifierKeyCodes[] = {16, 17, 18, 20, 91, 92, 93,
                                     160, 161, 162, 163, 164, 165};

constexpr std::string_view kNavigationKeys[] = {
    "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown",
    "Home",      "End",     "PageUp",     "PageDown",
};

constexpr std::string_view kEditingCommands[] = {
    "deletebackward",
    "deleteforward",
    "deletewordbackward",
    "deletewordforward",
    "insertnewline",
    "inserttab",
    "movedown",
    "movedownandmodifyselection",
    "moveleft",
    "moveleftandmodifyselection",
    "moveright",
    "moverightandmodifyselection",
    "movetobeginningofdocument",
    "movetobeginningofdocumentandmodifyselection",
    "movetobeginningofline",
    "movetobeginningoflineandmodifyselection",
    "movetoendofdocument",
    "movetoendofdocumentandmodifyselection",
    "movetoendofline",
    "movetoendoflineandmodifyselection",
    "moveup",
    "moveupandmodifyselection",
    "movewordleft",
    "movewordleftandmodifyselection",
    "movewordright",
    "movewordrightandmodifyselection",
    "selectall",
};

const NamedKey* FindNamedKey(const std::string& key) {
  for (const NamedKey& named : kNamedKeys) {
    if (named.key == key) {
      return &named;
    }
  }
  return nullptr;
}

bool Contains(const std::string_view* begin,
              const std::string_view* end,
              std::string_view value) {
  return std::find(begin, end, value) != end;
}

std::string Lower(std::string text) {
  for (char& c : text) {
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  }
  return text;
}

bool IsLetterOrDigit(const std::string& key) {
  return key.size() == 1 &&
         std::isalnum(static_cast<unsigned char>(key[0])) != 0;
}

bool IsModifierKey(const std::string& key) {
  return Contains(std::begin(kModifierKeys), std::end(kModifierKeys), key);
}

std::string AgreementRefusal(const PluginKeyEvent& event, int code) {
  const std::string& key = *event.key;
  if (IsModifierKey(key)) {
    if (event.windows_key_code &&
        std::find(std::begin(kModifierKeyCodes), std::end(kModifierKeyCodes),
                  code) == std::end(kModifierKeyCodes)) {
      return "with a key code that doesn't match its key";
    }
    return std::string();
  }
  if (const NamedKey* named = FindNamedKey(key)) {
    if (event.windows_key_code && code != named->windows_key_code) {
      return "with a key code that doesn't match its key";
    }
    if (event.code && *event.code != named->code &&
        (named->other_code.empty() || *event.code != named->other_code)) {
      return "with a code that doesn't match its key";
    }
    return std::string();
  }
  if (IsLetterOrDigit(key)) {
    const char upper = static_cast<char>(
        std::toupper(static_cast<unsigned char>(key[0])));
    const bool digit = std::isdigit(static_cast<unsigned char>(key[0])) != 0;
    const int expected = upper;
    const int keypad = digit ? 96 + (upper - '0') : -1;
    if (event.windows_key_code && code != expected && code != keypad) {
      return "with a key code that doesn't match its key";
    }
    const std::string expected_code =
        std::string(digit ? "Digit" : "Key") + upper;
    const std::string keypad_code = std::string("Numpad") + upper;
    if (event.code && *event.code != expected_code &&
        (!digit || *event.code != keypad_code)) {
      return "with a code that doesn't match its key";
    }
    return std::string();
  }
  if (event.windows_key_code &&
      (code == 45 || code == 46 || (code >= 'A' && code <= 'Z') ||
       (code >= '0' && code <= '9') || (code >= 8 && code <= 46))) {
    return "with a key code that doesn't match its key";
  }
  return std::string();
}

std::string ModifierRefusal(const std::string& key, int modifiers) {
  const bool shift = modifiers & kCdpShift;
  const int others = modifiers & (kCdpAlt | kCdpCtrl | kCdpMeta);
  if (IsModifierKey(key)) {
    return std::string();
  }
  if (!others) {
    if (shift && (key == "Insert" || key == "Delete")) {
      return "with Shift on Insert or Delete";
    }
    return std::string();
  }
  if (Contains(std::begin(kNavigationKeys), std::end(kNavigationKeys), key)) {
    return std::string();
  }
  if ((key == "a" || key == "A") && !shift && !(others & kCdpAlt)) {
    return std::string();
  }
  if ((key == "Backspace" || key == "Delete") && !shift) {
    return std::string();
  }
  return "with a modifier that isn't for moving, selecting or deleting";
}

bool IsClipboardKey(int code, int modifiers, const std::string& key) {
  for (const PluginClipboardKey& entry : kPluginClipboardKeys) {
    if (entry.modifiers != modifiers) {
      continue;
    }
    if (entry.dom_key[0] ? key == entry.dom_key
                         : code == entry.windows_key_code) {
      return true;
    }
  }
  return false;
}

}

std::string PluginKeyRefusal(const PluginKeyEvent& event) {
  if (event.has_native_key_code || event.has_system_key) {
    return "with a native key code or a system key";
  }
  const int modifiers = event.modifiers.value_or(0);
  if (modifiers & ~(kCdpAlt | kCdpCtrl | kCdpMeta | kCdpShift)) {
    return "with unknown modifier bits";
  }
  const int code = event.windows_key_code.value_or(0);
  if (code < 0 || code > 255) {
    return "with a key code outside 0-255";
  }
  if (!event.key) {
    return code ? "with a key code but no key" : std::string();
  }
  const std::string& key = *event.key;
  if (key == "Copy" || key == "Cut" || key == "Paste") {
    return "with a key that cuts, copies or pastes";
  }
  if (!event.commands_valid) {
    return "with those editing commands";
  }
  for (const std::string& command : event.commands) {
    if (!Contains(std::begin(kEditingCommands), std::end(kEditingCommands),
                  Lower(command))) {
      return "with that editing command";
    }
  }
  std::string refusal = AgreementRefusal(event, code);
  if (refusal.empty()) {
    refusal = ModifierRefusal(key, modifiers);
  }
  if (refusal.empty() && IsClipboardKey(code, modifiers, key)) {
    refusal = "with a key that cuts, copies or pastes";
  }
  return refusal;
}

std::string PluginMouseRefusal(const std::optional<std::string>& button,
                               std::optional<int> buttons) {
  if (button && *button == "middle") {
    return "with the middle button";
  }
  if (buttons && (*buttons & kCdpMiddleButton)) {
    return "with the middle button held";
  }
  return std::string();
}

}
