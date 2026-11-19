// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_test_signals.h"

namespace ardia {
namespace {

bool g_private_pasteboard_active = false;

}

void NoteCliPrivatePasteboard(bool active) {
  g_private_pasteboard_active = active;
}

bool CliPrivatePasteboardActive() {
  return g_private_pasteboard_active;
}

}
