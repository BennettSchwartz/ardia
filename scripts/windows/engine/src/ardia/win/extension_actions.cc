#include "ardia/win/extension_actions.h"

#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "ardia/win/host.h"
#include "ardia/win/input_watch.h"
#include "ardia/win/tab_state.h"
#include "base/base64.h"
#include "base/no_destructor.h"
#include "base/strings/stringprintf.h"
#include "chrome/browser/extensions/extension_action_runner.h"
#include "chrome/browser/extensions/extension_tab_util.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser.h"
#include "chrome/browser/ui/browser_window/public/browser_collection_observer.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection_platform_delegate.h"
#include "content/public/browser/web_contents.h"
#include "extensions/browser/extension_action.h"
#include "extensions/browser/extension_action_manager.h"
#include "extensions/browser/extension_registry.h"
#include "extensions/browser/extension_util.h"
#include "extensions/common/extension.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/gfx/image/image.h"
#include "ui/gfx/image/image_skia.h"
#include "ui/gfx/image/image_skia_rep.h"

namespace ardia_win {

namespace {

constexpr size_t kMostIds = 64;
constexpr size_t kMostIconBytes = 64 * 1024;
constexpr base::TimeDelta kGrantLifetime = base::Seconds(10);

std::map<HWND, PopupGrant>& Grants() {
  static base::NoDestructor<std::map<HWND, PopupGrant>> grants;
  return *grants;
}

base::Value HexColor(SkColor color) {
  if (!SkColorGetA(color)) {
    return base::Value();
  }
  return base::Value(base::StringPrintf("#%02x%02x%02x", SkColorGetR(color),
                                        SkColorGetG(color),
                                        SkColorGetB(color)));
}

std::string PngDataUrl(const gfx::Image& image) {
  if (image.IsEmpty()) {
    return std::string();
  }
  const gfx::ImageSkiaRep& rep = image.ToImageSkia()->GetRepresentation(2.0f);
  std::optional<std::vector<uint8_t>> png =
      gfx::PNGCodec::EncodeBGRASkBitmap(rep.GetBitmap(), false);
  if (!png || png->size() > kMostIconBytes) {
    return std::string();
  }
  return "data:image/png;base64," + base::Base64Encode(*png);
}

const extensions::Extension* UsableExtension(Profile* profile,
                                             const std::string& id) {
  const extensions::Extension* extension =
      extensions::ExtensionRegistry::Get(profile)->enabled_extensions().GetByID(
          id);
  if (!extension) {
    return nullptr;
  }
  if (profile->IsOffTheRecord() &&
      !extensions::util::IsIncognitoEnabled(id, profile)) {
    return nullptr;
  }
  return extension;
}

extensions::ExtensionAction* ActionOf(Profile* profile,
                                      const extensions::Extension& extension) {
  return extensions::ExtensionActionManager::Get(profile)->GetExtensionAction(
      extension);
}

void MakeLastActive(BrowserWindowInterface* browser) {
  BrowserCollectionObserver* order =
      GlobalBrowserCollection::GetInstance()->GetPlatformDelegate();
  order->OnBrowserActivated(browser);
}

std::string Execute(content::WebContents* contents,
                    HWND window,
                    const std::string& id) {
  Profile* profile = Profile::FromBrowserContext(contents->GetBrowserContext());
  TabState* tab = TabState::FromWebContents(contents);
  if (!tab || !window || !Host::Get()->ShowsIn(contents, window)) {
    return "none";
  }
  const extensions::Extension* extension = UsableExtension(profile, id);
  extensions::ExtensionAction* action =
      extension ? ActionOf(profile, *extension) : nullptr;
  const int tab_id = extensions::ExtensionTabUtil::GetTabId(contents);
  auto* runner = extensions::ExtensionActionRunner::GetForWebContents(contents);
  if (!action || !runner || !action->GetIsVisible(tab_id)) {
    return "none";
  }
  if (!TakeRecentInput(window)) {
    return "none";
  }
  if (BrowserWindowInterface* browser = Host::Get()->BrowserOfTab(contents)) {
    MakeLastActive(browser);
  }
  switch (runner->RunAction(extension, true)) {
    case extensions::ExtensionAction::ShowAction::kShowPopup:
      Grants()[window] = PopupGrant{id, tab->key(),
                                    action->GetPopupUrl(tab_id),
                                    base::TimeTicks::Now()};
      return "popup";
    case extensions::ExtensionAction::ShowAction::kToggleSidePanel:
      return "sidePanel";
    case extensions::ExtensionAction::ShowAction::kNone:
      return "none";
  }
  return "none";
}

base::DictValue ActionStates(content::WebContents* contents,
                             const base::ListValue* ids) {
  base::DictValue states;
  if (!ids) {
    return states;
  }
  Profile* profile = Profile::FromBrowserContext(contents->GetBrowserContext());
  const int tab_id = extensions::ExtensionTabUtil::GetTabId(contents);
  size_t asked = 0;
  for (const base::Value& entry : *ids) {
    if (++asked > kMostIds) {
      break;
    }
    const std::string* id = entry.GetIfString();
    const extensions::Extension* extension =
        id ? UsableExtension(profile, *id) : nullptr;
    extensions::ExtensionAction* action =
        extension ? ActionOf(profile, *extension) : nullptr;
    if (!action) {
      continue;
    }
    gfx::Image icon = action->GetExplicitlySetIcon(tab_id);
    if (icon.IsEmpty()) {
      icon = action->GetDeclarativeIcon(tab_id);
    }
    std::string badge = action->GetDisplayBadgeText(tab_id);
    base::DictValue state;
    state.Set("title", action->GetTitle(tab_id));
    state.Set("badgeText", badge.starts_with("<<") ? std::string() : badge);
    state.Set("badgeColor", HexColor(action->GetBadgeBackgroundColor(tab_id)));
    state.Set("badgeTextColor", HexColor(action->GetBadgeTextColor(tab_id)));
    state.Set("popup", action->GetPopupUrl(tab_id).spec());
    state.Set("enabled", action->GetIsVisible(tab_id));
    state.Set("icon", PngDataUrl(icon));
    states.Set(*id, std::move(state));
  }
  return states;
}

}

bool CallExtensionTabMethod(content::WebContents* contents,
                            HWND window,
                            const std::string& method,
                            const base::DictValue& args,
                            Reply& reply) {
  if (method == "executeExtensionAction") {
    const std::string* id = args.FindString("extensionId");
    base::DictValue answer;
    answer.Set("result", id ? Execute(contents, window, *id) : "none");
    std::move(reply).Run(std::move(answer));
    return true;
  }
  if (method == "extensionActionStates") {
    base::DictValue answer;
    answer.Set("states", ActionStates(contents, args.FindList("ids")));
    std::move(reply).Run(std::move(answer));
    return true;
  }
  return false;
}

std::optional<PopupGrant> TakePopupGrant(HWND window, const GURL& url) {
  auto found = Grants().find(window);
  if (found == Grants().end()) {
    return std::nullopt;
  }
  PopupGrant grant = std::move(found->second);
  Grants().erase(found);
  if (!url.is_valid() || grant.url != url ||
      base::TimeTicks::Now() - grant.at > kGrantLifetime) {
    return std::nullopt;
  }
  return grant;
}

void ForgetPopupGrants(HWND window) {
  Grants().erase(window);
}

base::DictValue ExtensionActionsOf(Profile* profile) {
  base::DictValue actions;
  if (!profile) {
    return actions;
  }
  for (const auto& extension :
       extensions::ExtensionRegistry::Get(profile)->enabled_extensions()) {
    if (!UsableExtension(profile, extension->id())) {
      continue;
    }
    extensions::ExtensionAction* action = ActionOf(profile, *extension);
    base::DictValue fields;
    fields.Set("hasAction", action != nullptr);
    if (action) {
      const int tab = extensions::ExtensionAction::kDefaultTabId;
      const GURL popup = action->GetPopupUrl(tab);
      fields.Set("popup", popup.is_valid() && popup.path().size() > 1
                              ? base::Value(popup.path().substr(1))
                              : base::Value());
      fields.Set("actionTitle", action->GetTitle(tab));
      const std::string icon =
          action->default_icon() ? PngDataUrl(action->GetDefaultIconImage())
                                 : std::string();
      fields.Set("actionIcon", icon.empty() ? base::Value() : base::Value(icon));
    }
    actions.Set(extension->id(), std::move(fields));
  }
  return actions;
}

}
