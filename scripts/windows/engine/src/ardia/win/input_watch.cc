#include "ardia/win/input_watch.h"

#include <map>
#include <set>

#include "base/no_destructor.h"
#include "base/synchronization/lock.h"
#include "base/time/time.h"

namespace ardia_win {

namespace {

constexpr base::TimeDelta kInputLifetime = base::Seconds(1);

struct Seen {
  base::TimeTicks at;
  bool used = true;
};

struct Watch {
  base::Lock lock;
  std::map<HWND, Seen> seen;
  std::set<DWORD> threads;
};

Watch& State() {
  static base::NoDestructor<Watch> watch;
  return *watch;
}

bool RealInput(UINT message) {
  switch (message) {
    case WM_LBUTTONDOWN:
    case WM_RBUTTONDOWN:
    case WM_MBUTTONDOWN:
    case WM_XBUTTONDOWN:
    case WM_POINTERDOWN:
    case WM_KEYDOWN:
    case WM_SYSKEYDOWN:
      return true;
    default:
      return false;
  }
}

void Note(HWND root) {
  if (!root) {
    return;
  }
  Watch& watch = State();
  base::AutoLock lock(watch.lock);
  watch.seen[root] = Seen{base::TimeTicks::Now(), false};
}

LRESULT CALLBACK MessageHook(int code, WPARAM w_param, LPARAM l_param) {
  if (code == HC_ACTION && w_param == PM_REMOVE && l_param) {
    const MSG* message = reinterpret_cast<const MSG*>(l_param);
    if (RealInput(message->message)) {
      HWND target = message->hwnd ? message->hwnd : ::GetFocus();
      Note(target ? ::GetAncestor(target, GA_ROOT) : nullptr);
    }
  }
  return ::CallNextHookEx(nullptr, code, w_param, l_param);
}

}

void WatchInputOf(HWND app_window) {
  const DWORD thread = ::GetWindowThreadProcessId(app_window, nullptr);
  if (!thread) {
    return;
  }
  Watch& watch = State();
  {
    base::AutoLock lock(watch.lock);
    if (!watch.threads.insert(thread).second) {
      return;
    }
  }
  if (!::SetWindowsHookExW(WH_GETMESSAGE, &MessageHook, nullptr, thread)) {
    base::AutoLock lock(watch.lock);
    watch.threads.erase(thread);
  }
}

bool TakeRecentInput(HWND app_window) {
  Watch& watch = State();
  base::AutoLock lock(watch.lock);
  auto found = watch.seen.find(app_window);
  if (found == watch.seen.end() || found->second.used ||
      base::TimeTicks::Now() - found->second.at > kInputLifetime) {
    return false;
  }
  found->second.used = true;
  return true;
}

void NoteInputForTest(HWND app_window) {
  Note(app_window);
}

}
