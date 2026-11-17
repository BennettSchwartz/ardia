#include "ardia/win/hosted_window.h"

#include <commctrl.h>
#include <dwmapi.h>

#include <cmath>

#include "ardia/win/host.h"

namespace ardia_win {

namespace {

constexpr int kParkedAt = -32000;
constexpr UINT_PTR kPageSubclass = 0xA2D1B;

LRESULT CALLBACK PageProcedure(HWND window,
                               UINT message,
                               WPARAM w_param,
                               LPARAM l_param,
                               UINT_PTR id,
                               DWORD_PTR data) {
  if (message == WM_SYSCOMMAND &&
      Host::Get()->HandOverWindowCommand(window, w_param, l_param)) {
    return 0;
  }
  if (message == WM_WINDOWPOSCHANGING && l_param) {
    Host::Get()->HoldPagePlace(window,
                               *reinterpret_cast<WINDOWPOS*>(l_param));
  }
  if (message == WM_WINDOWPOSCHANGED && l_param) {
    Host::Get()->PageMoved(window,
                           *reinterpret_cast<const WINDOWPOS*>(l_param));
  }
  if (message == WM_NCDESTROY) {
    Host::Get()->PageDestroyed(window);
    ::RemoveWindowSubclass(window, &PageProcedure, id);
  }
  return ::DefSubclassProc(window, message, w_param, l_param);
}

}

bool NeitherMovesNorSizes(const WINDOWPOS& change) {
  return (change.flags & SWP_NOMOVE) && (change.flags & SWP_NOSIZE);
}

void MakeBare(HWND window) {
  LONG_PTR style = ::GetWindowLongPtrW(window, GWL_STYLE);
  style &= ~static_cast<LONG_PTR>(WS_CHILD | WS_CAPTION | WS_THICKFRAME |
                                  WS_SYSMENU | WS_MINIMIZEBOX |
                                  WS_MAXIMIZEBOX | WS_VISIBLE);
  style |= WS_POPUP | WS_CLIPCHILDREN | WS_CLIPSIBLINGS;
  ::SetWindowLongPtrW(window, GWL_STYLE, style);
  LONG_PTR extended = ::GetWindowLongPtrW(window, GWL_EXSTYLE);
  extended &= ~static_cast<LONG_PTR>(WS_EX_APPWINDOW | WS_EX_WINDOWEDGE |
                                     WS_EX_DLGMODALFRAME | WS_EX_CLIENTEDGE |
                                     WS_EX_STATICEDGE);
  ::SetWindowLongPtrW(window, GWL_EXSTYLE, extended);
  const DWORD square = DWMWCP_DONOTROUND;
  ::DwmSetWindowAttribute(window, DWMWA_WINDOW_CORNER_PREFERENCE, &square,
                          sizeof(square));
  const BOOL no_transitions = TRUE;
  ::DwmSetWindowAttribute(window, DWMWA_TRANSITIONS_FORCEDISABLED,
                          &no_transitions, sizeof(no_transitions));
  const DWM_SYSTEMBACKDROP_TYPE no_backdrop = DWMSBT_NONE;
  ::DwmSetWindowAttribute(window, DWMWA_SYSTEMBACKDROP_TYPE, &no_backdrop,
                          sizeof(no_backdrop));
  ::SetWindowPos(window, nullptr, kParkedAt, kParkedAt, 0, 0,
                 SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE |
                     SWP_FRAMECHANGED);
}

void SetOwner(HWND window, HWND owner) {
  ::SetWindowLongPtrW(window, GWLP_HWNDPARENT,
                      reinterpret_cast<LONG_PTR>(owner));
}

int Scaled(double value, double scale) {
  return static_cast<int>(std::lround(value * scale));
}

void ShapeWindow(HWND window,
           int x,
           int y,
           int width,
           int height,
           int radius,
           const base::ListValue* holes,
           double scale) {
  if (radius <= 0 && (!holes || holes->empty())) {
    ::SetWindowRgn(window, nullptr, TRUE);
    return;
  }
  HRGN region = radius > 0
                    ? ::CreateRoundRectRgn(0, 0, width + 1, height + 1,
                                           radius * 2, radius * 2)
                    : ::CreateRectRgn(0, 0, width, height);
  if (holes) {
    for (const base::Value& entry : *holes) {
      const base::ListValue* hole = entry.GetIfList();
      if (!hole || hole->size() < 4) {
        continue;
      }
      double left = (*hole)[0].GetIfDouble().value_or(0);
      double top = (*hole)[1].GetIfDouble().value_or(0);
      double wide = (*hole)[2].GetIfDouble().value_or(0);
      double high = (*hole)[3].GetIfDouble().value_or(0);
      const int round =
          hole->size() > 4
              ? Scaled((*hole)[4].GetIfDouble().value_or(0), scale)
              : 0;
      const int cut_left = Scaled(left, scale) - x;
      const int cut_top = Scaled(top, scale) - y;
      const int cut_right = Scaled(left + wide, scale) - x;
      const int cut_bottom = Scaled(top + high, scale) - y;
      HRGN cut = round > 0
                     ? ::CreateRoundRectRgn(cut_left, cut_top, cut_right + 1,
                                            cut_bottom + 1, round * 2,
                                            round * 2)
                     : ::CreateRectRgn(cut_left, cut_top, cut_right,
                                       cut_bottom);
      ::CombineRgn(region, region, cut, RGN_DIFF);
      ::DeleteObject(cut);
    }
  }
  ::SetWindowRgn(window, region, TRUE);
}

void HoldAsPage(HWND window) {
  ::SetWindowSubclass(window, &PageProcedure, kPageSubclass, 0);
}

bool HeldAsPage(HWND window) {
  DWORD_PTR data = 0;
  return ::GetWindowSubclass(window, &PageProcedure, kPageSubclass, &data) !=
         FALSE;
}

}
