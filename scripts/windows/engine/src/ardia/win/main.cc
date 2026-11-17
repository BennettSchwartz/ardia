#include "ardia/win/main.h"

#include <windows.h>

#include <share.h>
#include <stdio.h>

#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "ardia/core/ac_hooks.h"
#include "ardia/core/ac_launch_switches.h"
#include "ardia/win/api.h"
#include "ardia/win/external_apps.h"
#include "ardia/win/frame_view.h"
#include "ardia/win/hooks.h"
#include "ardia/win/host.h"
#include "ardia/win/kept_pages.h"
#include "ardia/win/launch_guard.h"
#include "ardia/win/test_gate.h"
#include "base/base_switches.h"
#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/functional/bind.h"
#include "base/location.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/process/process.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "base/values.h"
#include "chrome/browser/devtools/chrome_devtools_manager_delegate.h"
#include "chrome/install_static/user_data_dir.h"
#include "chrome/browser/chrome_browser_main.h"
#include "chrome/browser/chrome_browser_main_extra_parts.h"
#include "chrome/browser/lifetime/application_lifetime_desktop.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/common/chrome_result_codes.h"
#include "chrome/common/chrome_switches.h"
#include "components/keep_alive_registry/keep_alive_types.h"
#include "components/keep_alive_registry/scoped_keep_alive.h"
#include "components/url_formatter/url_fixer.h"
#include "content/public/common/content_switches.h"
#include "media/base/media_switches.h"
#include "url/gurl.h"

namespace base {
extern bool (*g_ardia_pre_translate_message)(const MSG& msg);
}

namespace ardia_win {

namespace {

struct App {
  HMODULE module = nullptr;
  ArdiaAppPreTranslateFunction pre_translate = nullptr;
  ArdiaAppStopFunction stop = nullptr;
  bool started = false;
};

App& TheApp() {
  static App app;
  return app;
}

struct Gate {
  std::string refusal = "no scratch ARDIA_DATA_DIR";
  bool asked = false;
  std::string port;
};

Gate& TheGate() {
  static base::NoDestructor<Gate> gate;
  return *gate;
}

std::unique_ptr<ScopedKeepAlive>& KeepAlive() {
  static base::NoDestructor<std::unique_ptr<ScopedKeepAlive>> keep_alive;
  return *keep_alive;
}

constexpr size_t kReplayedLinksMostCharacters = 24000;
constexpr int kHandOffHoldMostMs = 20000;

struct Quitting {
  bool app_quitting = false;
  bool engine_quitting = false;
  int held_launches = 0;
  int dropped_links = 0;
  size_t held_link_characters = 0;
  std::vector<std::string> held_links;
  base::CommandLine::StringType log_file;
};

Quitting& TheQuit() {
  static base::NoDestructor<Quitting> quitting;
  return *quitting;
}

bool QuitUnderWay() {
  const Quitting& quit = TheQuit();
  return quit.app_quitting || quit.engine_quitting;
}

std::wstring OwnExecutable() {
  std::wstring path(MAX_PATH, L'\0');
  while (true) {
    const DWORD length = ::GetModuleFileNameW(
        nullptr, path.data(), static_cast<DWORD>(path.size()));
    if (length == 0) {
      return std::wstring();
    }
    if (length < path.size()) {
      path.resize(length);
      return path;
    }
    if (path.size() >= 32768) {
      return std::wstring();
    }
    path.resize(path.size() * 2);
  }
}

bool StartCopyOfArdia(std::wstring command_line,
                      DWORD* process_id,
                      DWORD* error) {
  *error = 0;
  const std::wstring executable = OwnExecutable();
  if (executable.empty()) {
    *error = ::GetLastError();
    return false;
  }
  STARTUPINFOW startup = {sizeof(startup)};
  PROCESS_INFORMATION started = {};
  if (!::CreateProcessW(executable.c_str(), command_line.data(), nullptr,
                        nullptr, FALSE, 0, nullptr, nullptr, &startup,
                        &started)) {
    *error = ::GetLastError();
    return false;
  }
  *process_id = started.dwProcessId;
  ::CloseHandle(started.hThread);
  ::CloseHandle(started.hProcess);
  return true;
}

std::wstring RawCommandLineWithSwitch(const std::string& name,
                                      const std::string& value) {
  std::wstring_view raw(::GetCommandLineW());
  size_t end = 0;
  if (!raw.empty() && raw.front() == L'"') {
    const size_t closing = raw.find(L'"', 1);
    end = closing == std::wstring_view::npos ? raw.size() : closing + 1;
  } else {
    end = raw.find_first_of(L" \t");
    if (end == std::wstring_view::npos) {
      end = raw.size();
    }
  }
  std::wstring line(raw.substr(0, end));
  line += L" --" + base::UTF8ToWide(name) + L"=" + base::UTF8ToWide(value);
  line += raw.substr(end);
  return line;
}

std::wstring AppLibraryPath() {
  std::wstring path(MAX_PATH, L'\0');
  DWORD length = ::GetModuleFileNameW(nullptr, path.data(),
                                      static_cast<DWORD>(path.size()));
  path.resize(length);
  size_t slash = path.find_last_of(L'\\');
  if (slash == std::wstring::npos) {
    return std::wstring();
  }
  path.resize(slash + 1);
  path.append(L"ArdiaApp.dll");
  return path;
}

bool AppLibraryPresent() {
  std::wstring path = AppLibraryPath();
  return !path.empty() &&
         ::GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES;
}

std::wstring Environment(const wchar_t* name) {
  std::wstring value(32768, L'\0');
  DWORD length = ::GetEnvironmentVariableW(name, value.data(),
                                          static_cast<DWORD>(value.size()));
  if (length == 0 || length >= value.size()) {
    return std::wstring();
  }
  value.resize(length);
  return value;
}

bool Set(const std::wstring& value) {
  return !value.empty() && value != L"0";
}

std::string TestEntryFromEnvironment(std::string_view key) {
  const std::string entries = base::WideToUTF8(Environment(L"ARDIA_TEST"));
  for (std::string_view entry : base::SplitStringPiece(
           entries, ",", base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY)) {
    const size_t equals = entry.find('=');
    if (equals != std::string_view::npos &&
        base::TrimWhitespaceASCII(entry.substr(0, equals), base::TRIM_ALL) ==
            key) {
      return std::string(base::TrimWhitespaceASCII(entry.substr(equals + 1),
                                                   base::TRIM_ALL));
    }
  }
  return std::string();
}

void AddFeatures(base::CommandLine* command_line,
                 const char* switch_name,
                 std::string_view features) {
  std::string all = command_line->GetSwitchValueASCII(switch_name);
  if (!all.empty()) {
    all.push_back(',');
  }
  all.append(features);
  command_line->AppendSwitchASCII(switch_name, all);
}

constexpr const char* kSwitchesThatOpenTheProfile[] = {
    "allow-insecure-localhost",
    "auto-open-devtools-for-tabs",
    "custom-devtools-frontend",
    "devtools-flags",
    "disable-extensions-except",
    "disable-web-security",
    "enable-automation",
    "enable-ui-devtools",
    "extensions-on-chrome-urls",
    "extensions-on-extension-urls",
    "host-resolver-rules",
    "host-rules",
    "ignore-certificate-errors",
    "ignore-certificate-errors-spki-list",
    "load-apps",
    "load-extension",
    "log-net-log",
    "net-log-capture-mode",
    "proxy-pac-url",
    "proxy-server",
    "remote-allow-origins",
    "remote-debugging-address",
    "remote-debugging-io-pipes",
    "remote-debugging-pipe",
    "remote-debugging-port",
    "remote-debugging-socket-name",
    "remote-debugging-targets",
    "silent-debugger-extension-api",
    "ssl-key-log-file",
    "unsafely-treat-insecure-origin-as-secure",
    "webtransport-developer-mode",
};

bool BrowserProcess(const base::CommandLine& command_line) {
  return command_line.GetSwitchValueNative(switches::kProcessType).empty();
}

std::wstring ChromiumUserDataDir() {
  std::wstring user_data_dir;
  std::wstring invalid;
  if (!install_static::GetUserDataDirectory(&user_data_dir, &invalid) ||
      !invalid.empty()) {
    return std::wstring();
  }
  return user_data_dir;
}

constexpr const char* kWindowsSwitchesThatOpenTheProfile[] = {
    "browser-subprocess-path",
    "gpu-launcher",
    "no-sandbox",
    "renderer-cmd-prefix",
    "utility-cmd-prefix",
};

void KeepRealProfileClosed(base::CommandLine* command_line) {
  if (TheGate().refusal.empty()) {
    return;
  }
  for (const char* name : kSwitchesThatOpenTheProfile) {
    command_line->RemoveSwitch(name);
  }
  for (const char* name : kWindowsSwitchesThatOpenTheProfile) {
    command_line->RemoveSwitch(name);
  }
  ::SetEnvironmentVariableW(L"SSLKEYLOGFILE", nullptr);
  if (::GetEnvironmentVariableW(L"SSLKEYLOGFILE", nullptr, 0) != 0) {
    LOG(ERROR) << "Ardia engine: SSLKEYLOGFILE could not be cleared outside "
                  "a test instance; not starting";
    base::Process::TerminateCurrentProcessImmediately(1);
  }
}

void DecideTestGate(base::CommandLine* command_line) {
  for (const char* forbidden :
       {switches::kRemoteDebuggingPort, switches::kRemoteDebuggingPipe,
        "remote-allow-origins", kTestInstanceSwitch, ardiacore::kTestSwitch,
        ardiacore::kTraceSwitch, ardiacore::kDataDirSwitch}) {
    command_line->RemoveSwitch(forbidden);
  }
  std::wstring data_dir = Environment(L"ARDIA_DATA_DIR");
  while (!data_dir.empty() &&
         (data_dir.back() == L'\\' || data_dir.back() == L'/')) {
    data_dir.pop_back();
  }
  const std::wstring port = Environment(L"ARDIA_REMOTE_DEBUGGING_PORT");
  const std::wstring test = Environment(L"ARDIA_TEST");
  const std::wstring trace = Environment(L"ARDIA_TRACE");
  Gate& gate = TheGate();
  std::wstring refusal = TestGateRefusal(data_dir, ChromiumUserDataDir());
  if (refusal.empty()) {
    refusal = HoldScratchFolders(data_dir, ChromiumUserDataDir());
  }
  gate.refusal = base::WideToUTF8(refusal);
  gate.asked = !port.empty() || !test.empty() || !trace.empty();
  KeepRealProfileClosed(command_line);
  if (!gate.refusal.empty()) {
    return;
  }
  command_line->AppendSwitch(kTestInstanceSwitch);
  if (!port.empty()) {
    command_line->AppendSwitchNative(switches::kRemoteDebuggingPort, port);
    command_line->AppendSwitchASCII("remote-allow-origins", "*");
    gate.port = base::WideToUTF8(port);
  }
  if (!test.empty()) {
    command_line->AppendSwitchNative(ardiacore::kTestSwitch, test);
  }
  if (!trace.empty()) {
    command_line->AppendSwitchNative(ardiacore::kTraceSwitch, trace);
  }
}

void AddLaunchSwitches(base::CommandLine* command_line) {
  command_line->AppendSwitch(switches::kNoStartupWindow);
  command_line->AppendSwitch(switches::kNoFirstRun);
  command_line->AppendSwitch(switches::kNoDefaultBrowserCheck);
  command_line->AppendSwitch(switches::kHideCrashRestoreBubble);
  command_line->AppendSwitch("keep-old-history");
  AddFeatures(command_line, switches::kDisableFeatures,
              "CalculateNativeWinOcclusion,SettingsGlowupJourneys");
  AddFeatures(command_line, switches::kEnableFeatures, "WebContentsDiscard");
  std::wstring data_dir = Environment(L"ARDIA_DATA_DIR");
  while (!data_dir.empty() &&
         (data_dir.back() == L'\\' || data_dir.back() == L'/')) {
    data_dir.pop_back();
  }
  const bool background = Set(Environment(L"ARDIA_BACKGROUND"));
  if (!data_dir.empty()) {
    command_line->AppendSwitchNative(ardiacore::kDataDirSwitch, data_dir);
    command_line->AppendSwitchNative(switches::kUserDataDir,
                                     data_dir + L"\\Chromium");
  }
  if (background) {
    command_line->AppendSwitch(ardiacore::kBackgroundSwitch);
    command_line->AppendSwitch(switches::kMuteAudio);
    command_line->AppendSwitch(switches::kUseFakeDeviceForMediaStream);
  }
  std::wstring app_switches = Environment(L"ARDIA_SWITCHES");
  if (!app_switches.empty()) {
    command_line->AppendSwitchNative(ardiacore::kSwitchesSwitch, app_switches);
  }
}

void WriteLaunchLog(const std::string& line) {
  std::wstring path =
      base::CommandLine::ForCurrentProcess()->GetSwitchValueNative("log-file");
  if (path.empty()) {
    path = LaunchLogPath();
  }
  if (path.empty()) {
    return;
  }
  FILE* file = _wfsopen(path.c_str(), L"ab", _SH_DENYNO);
  if (!file) {
    return;
  }
  const std::string text = "engine 0 " + line + "\n";
  fwrite(text.data(), 1, text.size(), file);
  fclose(file);
}

void SaveLaunchGuardFacts(const LaunchGuardFacts& facts,
                          int refused_starts_before) {
  const std::wstring data_dir = AppDataDirectory();
  if (data_dir.empty()) {
    return;
  }
  std::string json =
      "{\"waitedForPreviousMs\":" +
      std::to_string(facts.predecessor_wait_ms < 0 ? 0
                                                    : facts.predecessor_wait_ms) +
      ",\"unfinishedStartsBefore\":" +
      std::to_string(facts.unfinished_starts_before) +
      ",\"restoreStateSetAside\":" +
      (facts.recovered_to.empty() ? "false" : "true") +
      ",\"profileHeldByAnother\":" +
      (facts.profile_held_by_another ? "true" : "false") +
      ",\"refusedStartsBefore\":" + std::to_string(refused_starts_before);
  if (!facts.replayed_from.empty()) {
    json += ",\"replayedFrom\":\"" + facts.replayed_from +
            "\",\"replayedLaunches\":" +
            std::to_string(facts.replayed_launches);
  }
  json += "}\n";
  FILE* file = nullptr;
  if (_wfopen_s(&file, (data_dir + L"\\launch-guard.json").c_str(), L"wb") !=
          0 ||
      !file) {
    return;
  }
  fwrite(json.data(), 1, json.size(), file);
  fclose(file);
}

void NoteLaunchGuard() {
  const LaunchGuardFacts& facts = GuardFacts();
  const int refused = TakeRefusedStarts();
  SaveLaunchGuardFacts(facts, refused);
  std::string replayed;
  if (facts.replayed_from == kReplayedFromQuittingApp) {
    replayed = ", started again for " +
               std::to_string(facts.replayed_launches) +
               " launches that reached a quitting Ardia";
  } else if (facts.replayed_from == kReplayedAfterRefusal) {
    replayed = ", started again after Chromium refused the last launch";
  }
  WriteLaunchLog("launch guard: waited " +
                 std::to_string(facts.predecessor_wait_ms < 0
                                    ? 0
                                    : facts.predecessor_wait_ms) +
                 " ms for a previous Ardia, " +
                 std::to_string(facts.unfinished_starts_before) +
                 " unfinished starts before this one, restore state " +
                 (facts.recovered_to.empty() ? "kept" : "set aside") +
                 replayed +
                 (refused ? ", " + std::to_string(refused) +
                                " refused starts since the last one"
                          : std::string()));
}

void NoteTestGate() {
  const Gate& gate = TheGate();
  if (!gate.refusal.empty() && !gate.asked) {
    return;
  }
  const std::string facts =
      std::string("; ardiacore test instance: ") +
      (ardiacore::TestInstance() ? "yes" : "no") +
      "; reauth=granted honoured: " +
      (ardiacore::TestValue("reauth") == "granted" ? "yes" : "no");
  std::string line =
      gate.refusal.empty()
          ? "test gate: a test instance; remote debugging port: " +
                (gate.port.empty() ? std::string("none") : gate.port) + facts
          : "test gate: ARDIA_REMOTE_DEBUGGING_PORT, ARDIA_TEST and "
            "ARDIA_TRACE ignored: not a test instance (" +
                gate.refusal + ")" + facts;
  LOG(WARNING) << "Ardia engine " << line;
  WriteLaunchLog(line);
}

bool ForEngineWindow(const MSG& msg) {
  constexpr wchar_t kPrefix[] = L"Chrome_";
  constexpr int kPrefixLength = 7;
  if (!msg.hwnd) {
    return false;
  }
  wchar_t name[kPrefixLength + 2] = {};
  int length = ::GetClassNameW(msg.hwnd, name, kPrefixLength + 2);
  return length >= kPrefixLength &&
         std::wstring_view(name, kPrefixLength) == kPrefix;
}

FILE*& InputTrace() {
  static FILE* trace = nullptr;
  return trace;
}

bool Traced(const MSG& msg) {
  return (msg.message >= WM_MOUSEFIRST && msg.message <= WM_MOUSELAST) ||
         (msg.message >= WM_NCMOUSEMOVE && msg.message <= WM_NCXBUTTONDBLCLK) ||
         (msg.message >= WM_KEYFIRST && msg.message <= WM_KEYLAST) ||
         (msg.message >= WM_NCPOINTERUPDATE && msg.message <= WM_POINTERHWHEEL);
}

void Trace(const MSG& msg, bool engine_window, bool taken) {
  FILE* trace = InputTrace();
  if (!trace || !Traced(msg)) {
    return;
  }
  static int moves = 0;
  if (msg.message == WM_MOUSEMOVE || msg.message == WM_POINTERUPDATE ||
      msg.message == WM_NCMOUSEMOVE || msg.message == WM_NCPOINTERUPDATE) {
    if (++moves > 40) {
      return;
    }
  }
  wchar_t name[64] = {};
  ::GetClassNameW(msg.hwnd, name, 64);
  fprintf(trace, "%lu msg=0x%04x hwnd=%p class=%ls engine=%d taken=%d\n",
          static_cast<unsigned long>(::GetTickCount()), msg.message,
          static_cast<void*>(msg.hwnd), name, engine_window ? 1 : 0,
          taken ? 1 : 0);
  fflush(trace);
}

bool PreTranslate(const MSG& msg) {
  if (TakeTopEdgePress(msg)) {
    return true;
  }
  App& app = TheApp();
  const bool engine_window = ForEngineWindow(msg);
  bool taken = false;
  if (app.started && app.pre_translate && !engine_window) {
    taken = app.pre_translate(&msg) != 0;
  }
  Trace(msg, engine_window, taken);
  return taken;
}

bool Background() {
  return Set(Environment(L"ARDIA_BACKGROUND")) ||
         base::CommandLine::ForCurrentProcess()->HasSwitch(
             ardiacore::kBackgroundSwitch);
}

void ShowStartFailure(const std::wstring& reason, const std::wstring& advice) {
  if (Background()) {
    return;
  }
  const std::wstring log = LaunchLogPath();
  std::wstring text = L"Ardia couldn't start.\n\n" + reason + L"\n\n" + advice;
  if (!log.empty()) {
    text += L" The details are in " + log + L".";
  }
  ::MessageBoxW(nullptr, text.c_str(), L"Ardia",
                MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TASKMODAL |
                    MB_TOPMOST);
}

void ShowStartFailureAndQuit(const std::wstring& reason) {
  ShowStartFailure(reason,
                   L"Installing Ardia again from ardia.dev usually fixes this.");
  QuitApp();
}

void FailStart(const std::wstring& reason) {
  MarkStartSettled();
  LOG(ERROR) << "Ardia: the app did not start: " << base::WideToUTF8(reason);
  WriteLaunchLog("app start failed: " + base::WideToUTF8(reason));
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&ShowStartFailureAndQuit, reason));
}

std::wstring AppRefusal(HMODULE module, int result) {
  auto failure = reinterpret_cast<ArdiaAppStartFailureFunction>(
      ::GetProcAddress(module, "ArdiaAppStartFailure"));
  const wchar_t* text = failure ? failure() : nullptr;
  std::wstring reason = text && *text ? std::wstring(text)
                                      : std::wstring(L"The app stopped while starting");
  return reason + L" (code " + std::to_wstring(result) + L").";
}

void ShowRecoveryNotice(const std::wstring& folder) {
  if (Background()) {
    return;
  }
  const std::wstring text =
      L"Ardia didn't finish starting the last few times, so it opened "
      L"without your last session.\n\nYour bookmarks, history and "
      L"passwords are untouched. The session it set aside is in " +
      folder + L".";
  ::MessageBoxW(nullptr, text.c_str(), L"Ardia",
                MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND | MB_TOPMOST);
}

void ClaimGuardUntilOwned(int attempts_left) {
  ClaimGuard();
  if (OwnsGuard() || attempts_left <= 0) {
    return;
  }
  base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
      FROM_HERE, base::BindOnce(&ClaimGuardUntilOwned, attempts_left - 1),
      base::Milliseconds(kClaimRetryMs));
}

bool StartApp() {
  App& app = TheApp();
  std::wstring path = AppLibraryPath();
  app.module =
      ::LoadLibraryExW(path.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
  if (!app.module) {
    const DWORD error = ::GetLastError();
    FailStart(error == ERROR_MOD_NOT_FOUND
                  ? L"A file Ardia needs is missing from its folder "
                    L"(Windows error 126)."
                  : L"Ardia's app library could not be loaded (Windows "
                    L"error " +
                        std::to_wstring(error) + L").");
    return false;
  }
  auto start = reinterpret_cast<ArdiaAppStartFunction>(
      ::GetProcAddress(app.module, "ArdiaAppStart"));
  app.pre_translate = reinterpret_cast<ArdiaAppPreTranslateFunction>(
      ::GetProcAddress(app.module, "ArdiaAppPreTranslateMessage"));
  app.stop = reinterpret_cast<ArdiaAppStopFunction>(
      ::GetProcAddress(app.module, "ArdiaAppStop"));
  if (!start) {
    FailStart(L"Ardia's app library doesn't match its engine.");
    return false;
  }
  std::wstring traced = Environment(L"ARDIA_INPUT_TRACE");
  if (!traced.empty()) {
    _wfopen_s(&InputTrace(), traced.c_str(), L"w");
  }
  int result = start(EngineApi());
  if (result != 0) {
    FailStart(AppRefusal(app.module, result));
    return false;
  }
  app.started = true;
  base::g_ardia_pre_translate_message = &PreTranslate;
  return true;
}

void StopApp() {
  App& app = TheApp();
  base::g_ardia_pre_translate_message = nullptr;
  if (app.started && app.stop) {
    app.stop();
  }
  app.started = false;
}

class MainParts : public ChromeBrowserMainExtraParts {
 public:
  MainParts() = default;
  MainParts(const MainParts&) = delete;
  MainParts& operator=(const MainParts&) = delete;
  ~MainParts() override = default;

  void PreEarlyInitialization() override {
    KeepRealProfileClosed(base::CommandLine::ForCurrentProcess());
  }

  void PreBrowserStart() override {
    KeepAlive() = std::make_unique<ScopedKeepAlive>(
        KeepAliveOrigin::APP_CONTROLLER, KeepAliveRestartOption::DISABLED);
  }

  void PostBrowserStart() override {
    NoteTestGate();
    NoteLaunchGuard();
    ClaimGuardUntilOwned(kClaimAttempts);
    Host::Get()->Start();
    WatchEngineEvents();
    if (!StartApp()) {
      return;
    }
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE, base::BindOnce(&MarkStartSettled),
        base::Seconds(kStartSettlesAfterSeconds));
    const std::wstring recovered = GuardFacts().recovered_to;
    if (!recovered.empty()) {
      base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
          FROM_HERE, base::BindOnce(&ShowRecoveryNotice, recovered));
    }
  }

  void PostMainMessageLoopRun() override {
    TheQuit().engine_quitting = true;
    MarkExiting();
    StopApp();
    KeepAlive().reset();
  }
};

void AddMainParts(ChromeBrowserMainParts* main_parts) {
  main_parts->AddParts(std::make_unique<MainParts>());
}

bool KeepsWindowWithoutTabs(const BrowserWindowInterface* browser) {
  return Host::Get()->Keeps(browser);
}

std::vector<std::string> LaunchLinks(const base::CommandLine& command_line,
                                     const base::FilePath& cur_dir) {
  std::vector<std::string> links;
  for (const base::CommandLine::StringType& argument :
       command_line.GetArgs()) {
    GURL url(base::WideToUTF8(argument));
    if (!url.is_valid()) {
      url = url_formatter::FixupRelativeFile(cur_dir,
                                             base::FilePath(argument));
    }
    if (url.is_valid() && (url.SchemeIsHTTPOrHTTPS() || url.SchemeIsFile())) {
      links.push_back(url.spec());
    }
  }
  return links;
}

void EmitRelaunch(const std::vector<std::string>& links) {
  base::ListValue urls;
  for (const std::string& link : links) {
    urls.Append(link);
  }
  base::DictValue payload;
  payload.Set("urls", std::move(urls));
  Emit("relaunch", std::move(payload));
}

void HoldLaunchForReplay(const base::CommandLine& command_line,
                         std::vector<std::string> links) {
  Quitting& quit = TheQuit();
  quit.held_launches++;
  for (std::string& link : links) {
    if (quit.held_link_characters + link.size() + 3 >
        kReplayedLinksMostCharacters) {
      quit.dropped_links++;
      continue;
    }
    quit.held_link_characters += link.size() + 3;
    quit.held_links.push_back(std::move(link));
  }
  if (quit.log_file.empty()) {
    quit.log_file = command_line.GetSwitchValueNative("log-file");
  }
  WriteLaunchLog("relaunch: a launch reached this Ardia while it was "
                 "quitting; it starts again once this one has ended (" +
                 std::to_string(quit.held_launches) + " launches and " +
                 std::to_string(quit.held_links.size()) + " links held" +
                 (quit.dropped_links ? ", " + std::to_string(quit.dropped_links) +
                                           " links over the length limit"
                                     : std::string()) +
                 ")");
}

bool Relaunched(const base::CommandLine& command_line,
                const base::FilePath& cur_dir) {
  std::vector<std::string> links = LaunchLinks(command_line, cur_dir);
  if (QuitUnderWay()) {
    HoldLaunchForReplay(command_line, std::move(links));
    return true;
  }
  ClearExiting();
  EmitRelaunch(links);
  return true;
}

void ReplayHeldLaunches() {
  Quitting& quit = TheQuit();
  base::CommandLine replay{base::FilePath(OwnExecutable())};
  replay.AppendSwitchASCII(
      kReplayedLaunchSwitch,
      ReplayedLaunchValue(kReplayedFromQuittingApp, quit.held_launches));
  if (!quit.log_file.empty()) {
    replay.AppendSwitchNative("log-file", quit.log_file);
  }
  for (const std::string& link : quit.held_links) {
    replay.AppendArg(link);
  }
  DWORD process_id = 0;
  DWORD error = 0;
  if (StartCopyOfArdia(replay.GetCommandLineString(), &process_id, &error)) {
    WriteLaunchLog("relaunch: started a fresh Ardia (" +
                   std::to_string(process_id) + ") for " +
                   std::to_string(quit.held_launches) + " launches and " +
                   std::to_string(quit.held_links.size()) +
                   " links that arrived while this one was quitting");
  } else {
    WriteLaunchLog("relaunch: a fresh Ardia for " +
                   std::to_string(quit.held_launches) +
                   " launches that arrived while this one was quitting could "
                   "not be started (Windows error " +
                   std::to_string(error) + ")");
  }
  quit.held_launches = 0;
  quit.held_links.clear();
}

int AnswerRefusedLaunch(int exit_code) {
  const LaunchGuardFacts& facts = GuardFacts();
  const int already_waited =
      facts.predecessor_wait_ms < 0 ? 0 : facts.predecessor_wait_ms;
  const int budget = kPredecessorWaitSeconds * 1000 - already_waited;
  int waited = 0;
  const bool previous_ended = WaitForPreviousToEnd(budget, &waited);
  const bool waited_for_previous = already_waited > 0 || waited > 0;
  if (previous_ended && waited_for_previous &&
      facts.replayed_from != kReplayedAfterRefusal) {
    LetGoOfGuard();
    DWORD process_id = 0;
    DWORD error = 0;
    const bool started = StartCopyOfArdia(
        RawCommandLineWithSwitch(
            kReplayedLaunchSwitch,
            ReplayedLaunchValue(kReplayedAfterRefusal, 1)),
        &process_id, &error);
    WriteLaunchLog(
        "launch guard: Chromium refused this launch because the previous "
        "Ardia still held the profile; it ended after " +
        std::to_string(already_waited + waited) + " ms" +
        (started ? ", and a fresh Ardia (" + std::to_string(process_id) +
                       ") starts in this one's place"
                 : ", and a fresh Ardia could not be started (Windows error " +
                       std::to_string(error) + ")"));
    if (started) {
      return 0;
    }
  }
  CountRefusedStart();
  const std::wstring reason =
      previous_ended
          ? std::wstring(L"Another program or another computer is using "
                         L"Ardia's profile folder, so Ardia couldn't open it.")
          : L"The copy of Ardia that was closing hadn't finished after " +
                std::to_wstring((already_waited + waited) / 1000) +
                L" seconds, so this one couldn't open your profile.";
  WriteLaunchLog("app start failed: " + base::WideToUTF8(reason) +
                 " (Chromium's profile-in-use exit, code " +
                 std::to_string(exit_code) + ")");
  ShowStartFailure(reason,
                   previous_ended
                       ? std::wstring(L"Close the program using it, or "
                                      L"restart Windows, then open Ardia "
                                      L"again.")
                       : std::wstring(L"Wait a moment, then open Ardia "
                                      L"again. Restarting Windows ends a "
                                      L"copy that is stuck."));
  return exit_code;
}

void HoldHandOffForTest() {
  if (!TheGate().refusal.empty()) {
    return;
  }
  int hold_ms = 0;
  if (!base::StringToInt(TestEntryFromEnvironment("handOffHoldMs"),
                         &hold_ms) ||
      hold_ms <= 0) {
    return;
  }
  hold_ms = hold_ms > kHandOffHoldMostMs ? kHandOffHoldMostMs : hold_ms;
  WriteLaunchLog("test: this launch waits " + std::to_string(hold_ms) +
                 " ms before it looks for a running Ardia");
  ::Sleep(static_cast<DWORD>(hold_ms));
}

}

void NoteForTest(const std::string& line) {
  if (ardiacore::TestInstance()) {
    WriteLaunchLog(line);
  }
}

void BeforeChromeMain() {
  base::CommandLine* command_line = base::CommandLine::ForCurrentProcess();
  if (!BrowserProcess(*command_line)) {
    return;
  }
  command_line->RemoveSwitch(switches::kProcessType);
  DecideTestGate(command_line);
  if (!AppLibraryPresent()) {
    return;
  }
  std::wstring data_dir = Environment(L"ARDIA_DATA_DIR");
  while (!data_dir.empty() &&
         (data_dir.back() == L'\\' || data_dir.back() == L'/')) {
    data_dir.pop_back();
  }
  GuardBrowserLaunch(
      data_dir.empty() ? ChromiumUserDataDir() : data_dir + L"\\Chromium",
      command_line);
  AddLaunchSwitches(command_line);
  HoldHandOffForTest();
  ardia_win::AskBeforeDiscards();
  g_ardia_win_hosts_normal_windows = true;
  g_ardia_win_frame_view = &CreateHostedFrameView;
  g_ardia_win_add_main_parts = &AddMainParts;
  g_ardia_win_relaunched = &Relaunched;
  InstallExternalAppAsks();
  g_ardia_keeps_window_without_tabs = &KeepsWindowWithoutTabs;
}

void AfterChromeMain(int exit_code) {
  if (!g_ardia_win_add_main_parts) {
    return;
  }
  if (TheQuit().held_launches > 0) {
    ReplayHeldLaunches();
  } else if (exit_code == CHROME_RESULT_CODE_PROFILE_IN_USE) {
    exit_code = AnswerRefusedLaunch(exit_code);
  }
  base::Process::TerminateCurrentProcessImmediately(exit_code);
}

const char* TestGateDecision() {
  return TheGate().refusal.c_str();
}

void AppQuitting(bool quitting) {
  Quitting& quit = TheQuit();
  if (quitting) {
    if (quit.app_quitting) {
      return;
    }
    quit.app_quitting = true;
    MarkExiting();
    WriteLaunchLog("relaunch: the app began quitting; a new launch waits "
                   "for it to end or starts again after it");
    return;
  }
  if (!quit.app_quitting || quit.engine_quitting) {
    return;
  }
  quit.app_quitting = false;
  ClearExiting();
  const int held = quit.held_launches;
  std::vector<std::string> links = std::move(quit.held_links);
  quit.held_launches = 0;
  quit.held_links.clear();
  quit.held_link_characters = 0;
  quit.dropped_links = 0;
  WriteLaunchLog("relaunch: the app stopped quitting; " +
                 std::to_string(held) + " held launches go to it now");
  if (held > 0) {
    EmitRelaunch(links);
  }
}

void QuitApp() {
  TheQuit().engine_quitting = true;
  MarkExiting();
  MarkStartSettled();
  KeepAlive().reset();
  ChromeDevToolsManagerDelegate::AllowBrowserToClose();
  chrome::CloseAllBrowsersAndQuit();
}

}
