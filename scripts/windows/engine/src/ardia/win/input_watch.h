#ifndef ARDIA_WIN_INPUT_WATCH_H_
#define ARDIA_WIN_INPUT_WATCH_H_

#include <windows.h>

namespace ardia_win {

void WatchInputOf(HWND app_window);
bool TakeRecentInput(HWND app_window);
void NoteInputForTest(HWND app_window);

}

#endif
