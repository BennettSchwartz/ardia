// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_TOKEN_POLICY_INTERNAL_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_TOKEN_POLICY_INTERNAL_H_

#include <cstddef>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/callback_list.h"
#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/timer/timer.h"
#include "base/values.h"
#include "chrome/browser/ardia/ac_cli_token_policy.h"
#include "content/public/browser/devtools_agent_host.h"

class GURL;

namespace content {
class DevToolsAgentHostClient;
class RenderFrameHost;
}

namespace ardia {
namespace cli_token_policy_internal {

inline constexpr int kMethodNotAllowed = -32601;
inline constexpr int kInvalidRequest = -32600;
inline constexpr int kParseError = -32700;
inline constexpr int kRefused = -32000;
inline constexpr size_t kMaxPending = 4096;
inline constexpr int kMaxIoReadBytes = 16 * 1024 * 1024;
inline constexpr char kAnswerFilePicker[] = "Ardia.answerFilePicker";
inline constexpr char kOutOfScope[] = "ardia: tab_out_of_scope";
inline constexpr char kInternalCommand[] = "ardia.internal";

enum class CommandDomain {
  kTarget,
  kPage,
  kRuntime,
  kDom,
  kInput,
  kNetwork,
  kEmulation,
  kBrowser,
  kStorage,
  kFetch,
  kAccessibility,
  kOther,
  kCount,
};

CommandDomain DomainOf(std::string_view method);
void CountCommand(CommandDomain domain);

bool IsOffscreenTarget(const std::string* target_id);

bool IsWebUrl(const GURL& url);
bool IsWebDestination(std::string_view spec);
bool PluginTargetInScope(const PluginScope& scope,
                         content::DevToolsAgentHost* host);
bool PluginMayAttachToFrame(const PluginScope& scope,
                            content::RenderFrameHost* frame);
bool PluginMayAttachToTargetId(const PluginScope& scope,
                               const std::string* target_id);
bool PluginForwardsEvent(std::string_view method);

struct PluginCommandContext {
  bool on_root_session = false;
  base::RepeatingCallback<bool(const std::string&)> session_known;
  base::RepeatingCallback<std::optional<std::pair<double, double>>()> viewport;
};

void ScrubPluginTargetInfo(const PluginScope& scope, base::DictValue* info);

std::string PluginRefusal(const PluginScope& scope,
                          const std::string& method,
                          base::DictValue& params,
                          const PluginCommandContext& context);

std::string ErrorReply(int id,
                       const std::string& session,
                       int code,
                       const std::string& message);

class TokenClient;

std::map<content::DevToolsAgentHostClient*, TokenClient*>& Registry();

class TokenClient : public ArdiaDevToolsTokenClient {
 public:
  TokenClient(content::DevToolsAgentHostClient* client,
              content::DevToolsAgentHost* host,
              TokenKind kind,
              std::optional<PluginScope> scope);
  ~TokenClient() override;

  TokenKind kind() const { return kind_; }
  const std::optional<PluginScope>& scope() const { return scope_; }
  content::DevToolsAgentHost* root_host() const { return root_host_.get(); }
  void Revoke();
  bool MayInputTo(content::RenderFrameHost* frame);
  bool MaySessionInput(const std::string& session);
  bool PluginSessionLive(const std::string& session);

  bool FilterCommand(std::string& message, std::string* reply) override;
  bool FilterEvent(std::string& message) override;
  bool ShouldClose() const override;
  bool MayAttachToURL(const GURL& url, bool is_webui) override;
  bool MayAttachToRenderFrameHost(content::RenderFrameHost* frame) override;
  bool MayReadLocalFiles() override;
  bool MayWriteLocalFiles() override;
  void SetCloser(
      base::RepeatingCallback<void(bool drop_queued)> close) override;
  void SetChannel(base::RepeatingCallback<void(std::string)> to_browser,
                  base::RepeatingCallback<void(std::string)> to_client) override;

 private:
  bool AnswerFilePickerCommand(int id,
                               const std::string& session,
                               const base::DictValue* params,
                               std::string* reply);
  bool PluginCommandAllowed(int id,
                            const std::string& session,
                            const std::string& method,
                            base::DictValue& params,
                            std::string* reply);
  void ForgetSession(const std::string& session);
  void ForgetSessionOf(const std::string& message);
  std::vector<std::string> Subtree(const std::string& session) const;
  void DropSubtree(const std::string& session);
  void NoteCommand(const std::string& method,
                   const std::string& session,
                   const base::DictValue* params);
  bool FilterResponse(const std::string& method, std::string& message);
  bool FilterTargetEvent(std::string_view method, std::string& message);
  bool FilterPluginEvent(std::string_view method,
                         std::string_view session,
                         std::string& message);
  bool FilterPluginReply(int id,
                         const std::string& session,
                         std::string& message);
  bool SessionInScope(const std::string& session);
  bool RootInScope();
  void WatchTab(const std::string& session);
  void TabLeftWindow(const std::string& session);
  std::optional<std::pair<double, double>> ViewportOf(
      const std::string& session);
  void DetachOutOfScope(const std::string& session);
  void CloseOutOfScope();
  void CheckScope();
  void SendInternal(const std::string& session,
                    const std::string& method,
                    base::DictValue params);
  content::DevToolsAgentHost* HostOf(const std::string& session);

  const raw_ptr<content::DevToolsAgentHostClient> client_;
  const scoped_refptr<content::DevToolsAgentHost> root_host_;
  const TokenKind kind_;
  const std::optional<PluginScope> scope_;
  std::map<std::string, std::string> targets_;
  std::map<std::string, std::string> parents_;
  std::map<std::string, std::string> detaching_;
  std::set<std::string> told_targets_;
  std::set<std::string> left_;
  bool root_left_ = false;
  struct TabWatch {
    base::CallbackListSubscription will_detach;
    base::CallbackListSubscription did_insert;
  };
  std::map<std::string, TabWatch> tab_watches_;
  TabWatch root_tab_watch_;
  std::map<std::pair<std::string, int>, std::string> outstanding_;
  base::RepeatingCallback<void(bool drop_queued)> closer_;
  base::RepeatingCallback<void(std::string)> to_browser_;
  base::RepeatingCallback<void(std::string)> to_client_;
  base::RepeatingTimer scope_timer_;
  int next_internal_id_ = 0;
  bool wedged_ = false;
  bool draining_ = false;
  bool revoked_ = false;
  base::WeakPtrFactory<TokenClient> weak_factory_{this};
};

}
}

#endif
