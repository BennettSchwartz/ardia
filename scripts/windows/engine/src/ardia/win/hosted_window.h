#ifndef ARDIA_WIN_HOSTED_WINDOW_H_
#define ARDIA_WIN_HOSTED_WINDOW_H_

#include <windows.h>

#include "base/values.h"

namespace ardia_win {

bool NeitherMovesNorSizes(const WINDOWPOS& change);
void MakeBare(HWND window);
void SetOwner(HWND window, HWND owner);
int Scaled(double value, double scale);
void ShapeWindow(HWND window,
                 int x,
                 int y,
                 int width,
                 int height,
                 int radius,
                 const base::ListValue* holes,
                 double scale);
void HoldAsPage(HWND window);
bool HeldAsPage(HWND window);

}

#endif
