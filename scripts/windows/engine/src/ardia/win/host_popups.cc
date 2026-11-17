#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "ardia/win/extension_actions.h"
#include "ardia/win/extension_popup.h"
#include "ardia/win/host.h"
#include "ardia/win/hosted_window.h"
#include "ardia/win/tab_calls.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser.h"
#include "content/public/browser/web_contents.h"
#include "extensions/browser/extension_registry.h"
#include "extensions/browser/extension_util.h"
#include "extensions/common/extension.h"
#include "url/gurl.h"

namespace ardia_win {

namespace {

std::string Field(const base::DictValue& args, std::string_view key) {
  const std::string* value = args.FindString(key);
  return value ? *value : std::string();
}

base::DictValue Done() {
  base::DictValue result;
  result.Set("ok", true);
  return result;
}

}

ExtensionPopup* Host::FindPopup(const std::string& key) const {
  auto found = popups_.find(key);
  return found == popups_.end() ? nullptr : found->second.get();
}

ExtensionPopup* Host::PopupOfWindow(HWND window) const {
  for (const auto& [key, popup] : popups_) {
    if (window && popup->window() == window) {
      return popup.get();
    }
  }
  return nullptr;
}

void Host::CreatePopup(base::DictValue args, HWND parent, Reply reply) {
  const std::string key = Field(args, "key");
  if (key.empty() || !::IsWindow(parent) || popups_.contains(key) ||
      Find(key)) {
    std::move(reply).Run(Error("a pop-up needs a new key and a window"));
    return;
  }
  std::optional<PopupGrant> grant =
      TakePopupGrant(parent, GURL(Field(args, "url")));
  if (!grant) {
    std::move(reply).Run(
        Error("no pop-up was granted for that address in this window"));
    return;
  }
  content::WebContents* page = Find(grant->page_key);
  if (!page || !ShowsIn(page, parent)) {
    std::move(reply).Run(Error("the page behind the pop-up is not shown"));
    return;
  }
  Profile* profile = Profile::FromBrowserContext(page->GetBrowserContext());
  const extensions::Extension* extension =
      extensions::ExtensionRegistry::Get(profile)->enabled_extensions().GetByID(
          grant->extension_id);
  if (!extension || (profile->IsOffTheRecord() &&
                     !extensions::util::IsIncognitoEnabled(
                         grant->extension_id, profile))) {
    std::move(reply).Run(Error("the extension is not on in this profile"));
    return;
  }
  ClosePopupsOf(parent);
  std::unique_ptr<ExtensionPopup> popup = ExtensionPopup::Create(
      key, parent, *extension, grant->url, BrowserOf(page));
  if (!popup) {
    std::move(reply).Run(Error("the pop-up did not open"));
    return;
  }
  HWND window = popup->window();
  MakeBare(window);
  HoldAsPage(window);
  SetOwner(window, parent);
  WatchParent(parent);
  popups_[key] = std::move(popup);
  std::move(reply).Run(Done());
}

base::DictValue Host::ShowPopup(ExtensionPopup* popup,
                                const base::DictValue& args,
                                HWND parent) {
  if (!args.FindBool("visible").value_or(true)) {
    auto wanted = keyboard_wanted_.find(popup->parent());
    if (wanted != keyboard_wanted_.end() && wanted->second == popup->key()) {
      keyboard_wanted_.erase(wanted);
    }
    popup->Hide();
    return Done();
  }
  if (!::IsWindow(parent) || parent != popup->parent()) {
    return Error("the pop-up belongs to another window");
  }
  double scale = 1;
  const gfx::Rect place = PlaceFromArgs(args, parent, &scale);
  popup->set_place(place);
  HWND window = popup->window();
  SetOwner(window, parent);
  Place(window, parent, place);
  ShapeWindow(window, place.x(), place.y(), place.width(), place.height(),
              Scaled(args.FindDouble("radius").value_or(0), scale),
              args.FindList("holes"), scale);
  if (!popup->shown()) {
    popup->Show();
    Place(window, parent, place);
  }
  return Done();
}

void Host::CallPopup(ExtensionPopup* popup,
                     const base::DictValue& args,
                     Reply reply) {
  const std::string method = Field(args, "method");
  content::WebContents* contents = popup->contents();
  if (!contents) {
    std::move(reply).Run(Error("the pop-up is gone"));
    return;
  }
  if (method == "focus") {
    if (popup->shown()) {
      GiveKeyboardTo(popup->window(), popup->parent(), contents, popup->key(),
                     args.FindBool("follow").value_or(false), false);
    }
    std::move(reply).Run(Done());
    return;
  }
  if (method == "evaluate") {
    CallTabMethod(contents, method, args, reply);
    return;
  }
  std::move(reply).Run(Error("a pop-up takes only evaluate and focus"));
}

void Host::ClosePopupsOf(HWND parent) {
  std::vector<std::string> keys;
  for (const auto& [key, popup] : popups_) {
    if (popup->parent() == parent) {
      keys.push_back(key);
    }
  }
  for (const std::string& key : keys) {
    if (ExtensionPopup* popup = FindPopup(key)) {
      popup->CloseFromHost();
    }
    DropPopup(key);
  }
}

void Host::DropPopup(const std::string& key) {
  auto found = popups_.find(key);
  if (found == popups_.end()) {
    return;
  }
  std::unique_ptr<ExtensionPopup> popup = std::move(found->second);
  popups_.erase(found);
  auto wanted = keyboard_wanted_.find(popup->parent());
  if (wanted != keyboard_wanted_.end() && wanted->second == key) {
    keyboard_wanted_.erase(wanted);
  }
  popup->Hide();
}

}
