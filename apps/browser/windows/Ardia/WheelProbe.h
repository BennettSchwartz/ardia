#pragma once

#include <string>

#include <winrt/Microsoft.UI.Content.h>
#include <winrt/Microsoft.UI.Input.h>

#include "LaunchConfig.h"
#include "LaunchLog.h"

namespace Ardia::WheelProbe {

inline bool On() noexcept {
  static const bool on = AppLaunch::TestFlag("wheelProbe");
  return on;
}

inline std::wstring ClassOf(HWND hwnd) noexcept {
  wchar_t name[96]{};
  if (!hwnd || !GetClassNameW(hwnd, name, 96)) return L"none";
  return name;
}

inline const wchar_t *NameOf(UINT message) noexcept {
  switch (message) {
    case WM_MOUSEWHEEL: return L"WM_MOUSEWHEEL";
    case WM_MOUSEHWHEEL: return L"WM_MOUSEHWHEEL";
    case 0x024E: return L"WM_POINTERWHEEL";
    case 0x024F: return L"WM_POINTERHWHEEL";
    default: return nullptr;
  }
}

inline LRESULT CALLBACK MouseHook(int code, WPARAM wParam, LPARAM lParam) noexcept {
  static unsigned calls = 0;
  if (code == HC_ACTION) {
    ++calls;
    const wchar_t *name = NameOf(static_cast<UINT>(wParam));
    if (name) {
      auto *info = reinterpret_cast<MOUSEHOOKSTRUCTEX *>(lParam);
      short delta = static_cast<short>(HIWORD(info->mouseData));
      LaunchLog::Write(L"probe", std::wstring(L"wheel probe: WH_MOUSE saw ").append(name).append(L" delta ").append(std::to_wstring(delta)).append(L" at ").append(std::to_wstring(info->pt.x)).append(L",").append(std::to_wstring(info->pt.y)).append(L" for ").append(ClassOf(info->hwnd)).append(L" (call ").append(std::to_wstring(calls)).append(L")"));
    } else if (calls <= 3 || calls % 200 == 0) {
      LaunchLog::Write(L"probe", std::wstring(L"wheel probe: WH_MOUSE call ").append(std::to_wstring(calls)).append(L" message ").append(std::to_wstring(static_cast<unsigned>(wParam))));
    }
  }
  return CallNextHookEx(nullptr, code, wParam, lParam);
}

inline LRESULT CALLBACK MessageHook(int code, WPARAM wParam, LPARAM lParam) noexcept {
  if (code == HC_ACTION) {
    auto *message = reinterpret_cast<MSG *>(lParam);
    if (const wchar_t *name = NameOf(message->message)) {
      short delta = static_cast<short>(HIWORD(message->wParam));
      POINT at{static_cast<short>(LOWORD(message->lParam)), static_cast<short>(HIWORD(message->lParam))};
      LaunchLog::Write(L"probe", std::wstring(L"wheel probe: WH_GETMESSAGE saw ").append(name).append(L" delta ").append(std::to_wstring(delta)).append(L" at ").append(std::to_wstring(at.x)).append(L",").append(std::to_wstring(at.y)).append(L" for ").append(ClassOf(message->hwnd)).append(wParam == PM_REMOVE ? L" (removed)" : L" (peeked)"));
    }
  }
  return CallNextHookEx(nullptr, code, wParam, lParam);
}

inline void InstallThreadHooks() noexcept {
  static bool installed = false;
  if (installed || !On()) return;
  installed = true;
  HHOOK mouse = SetWindowsHookExW(WH_MOUSE, &MouseHook, nullptr, GetCurrentThreadId());
  HHOOK messages = SetWindowsHookExW(WH_GETMESSAGE, &MessageHook, nullptr, GetCurrentThreadId());
  LaunchLog::Write(L"probe", std::wstring(L"wheel probe: WH_MOUSE hook ").append(mouse ? L"installed" : L"failed").append(L", WH_GETMESSAGE hook ").append(messages ? L"installed" : L"failed"));
}

inline void WatchIsland(winrt::Microsoft::ReactNative::ReactNativeIsland const &island, std::string const &id) noexcept {
  if (!On()) return;
  InstallThreadHooks();
  try {
    auto content = island.Island();
    if (!content) {
      LaunchLog::Write(L"probe", L"wheel probe: no content island yet for " + std::wstring(id.begin(), id.end()));
      return;
    }
    auto source = winrt::Microsoft::UI::Input::InputPointerSource::GetForIsland(content);
    source.PointerWheelChanged([id](winrt::Microsoft::UI::Input::InputPointerSource const &, winrt::Microsoft::UI::Input::PointerEventArgs const &args) {
      try {
        auto point = args.CurrentPoint();
        auto properties = point.Properties();
        auto at = point.Position();
        LaunchLog::Write(L"probe", std::wstring(L"wheel probe: island ").append(std::wstring(id.begin(), id.end())).append(L" PointerWheelChanged delta ").append(std::to_wstring(properties.MouseWheelDelta())).append(properties.IsHorizontalMouseWheel() ? L" horizontal" : L" vertical").append(L" at ").append(std::to_wstring(static_cast<int>(at.X))).append(L",").append(std::to_wstring(static_cast<int>(at.Y))).append(L" device ").append(std::to_wstring(static_cast<int>(point.PointerDeviceType()))).append(args.Handled() ? L" (already handled)" : L""));
      } catch (...) {
      }
    });
    LaunchLog::Write(L"probe", L"wheel probe: watching the island's pointer wheel for " + std::wstring(id.begin(), id.end()));
  } catch (...) {
    LaunchLog::Write(L"probe", L"wheel probe: the island's pointer source could not be watched");
  }
}

}
