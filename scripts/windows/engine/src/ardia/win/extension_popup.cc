#include "ardia/win/extension_popup.h"

#include <utility>

#include "ardia/win/api.h"
#include "ardia/win/host.h"
#include "base/functional/bind.h"
#include "base/location.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "chrome/browser/extensions/extension_view_host.h"
#include "chrome/browser/extensions/extension_view_host_factory.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/web_contents.h"
#include "extensions/common/constants.h"
#include "extensions/common/extension.h"
#include "ui/aura/window.h"
#include "ui/aura/window_tree_host.h"
#include "ui/views/widget/widget.h"

namespace ardia_win {

namespace {

constexpr gfx::Size kSmallest(25, 25);
constexpr gfx::Size kLargest(800, 600);

}

std::unique_ptr<ExtensionPopup> ExtensionPopup::Create(
    std::string key,
    HWND parent,
    const extensions::Extension& extension,
    const GURL& url,
    Browser* browser) {
  if (!browser || !url.SchemeIs(extensions::kExtensionScheme) ||
      url.host() != extension.id()) {
    return nullptr;
  }
  std::unique_ptr<extensions::ExtensionViewHost> host =
      extensions::ExtensionViewHostFactory::CreatePopupHost(extension, url,
                                                            browser);
  if (!host) {
    return nullptr;
  }
  std::unique_ptr<ExtensionPopup> popup(
      new ExtensionPopup(std::move(key), parent, std::move(host), browser));
  popup->Build();
  return popup->window_ ? std::move(popup) : nullptr;
}

ExtensionPopup::ExtensionPopup(std::string key,
                               HWND parent,
                               std::unique_ptr<extensions::ExtensionViewHost> host,
                               Browser* browser)
    : key_(std::move(key)),
      extension_id_(host->extension_id()),
      parent_(parent),
      browser_(browser),
      host_(std::move(host)) {}

ExtensionPopup::~ExtensionPopup() {
  Observe(nullptr);
}

content::WebContents* ExtensionPopup::contents() const {
  return host_ ? host_->host_contents() : nullptr;
}

void ExtensionPopup::Build() {
  Observe(host_->host_contents());
  host_->SetCloseHandler(
      base::BindOnce(&ExtensionPopup::Closed, weak_factory_.GetWeakPtr()));
  registry_observation_.Observe(
      extensions::ExtensionRegistry::Get(host_->browser_context()));
  browsers_observation_.Observe(GlobalBrowserCollection::GetInstance());

  widget_ = std::make_unique<views::Widget>();
  views::Widget::InitParams params(
      views::Widget::InitParams::CLIENT_OWNS_WIDGET,
      views::Widget::InitParams::TYPE_WINDOW_FRAMELESS);
  params.bounds = gfx::Rect(kSmallest);
  params.activatable = views::Widget::InitParams::Activatable::kYes;
  params.remove_standard_frame = true;
  params.shadow_type = views::Widget::InitParams::ShadowType::kNone;
  params.name = "ArdiaExtensionPopup";
  widget_->Init(std::move(params));

  auto view = std::make_unique<ExtensionViewViews>(
      Profile::FromBrowserContext(host_->browser_context()), host_.get());
  view->SetContainer(this);
  view_ = widget_->SetContentsView(std::move(view));
  view_->Init();
  view_observation_.Observe(view_.get());

  gfx::NativeWindow native = widget_->GetNativeWindow();
  if (native && native->GetHost()) {
    window_ = native->GetHost()->GetAcceleratedWidget();
    native->AddPreTargetHandler(Host::Get());
  }
}

void ExtensionPopup::Show() {
  shown_ = true;
  if (widget_ && !widget_->IsVisible()) {
    widget_->ShowInactive();
  }
}

void ExtensionPopup::Hide() {
  shown_ = false;
  if (widget_ && widget_->IsVisible()) {
    widget_->Hide();
  }
}

void ExtensionPopup::CloseFromHost() {
  if (closing_) {
    return;
  }
  closing_ = true;
  Send("windowClose", base::DictValue());
}

void ExtensionPopup::Send(std::string_view name, base::DictValue data) {
  base::DictValue payload;
  payload.Set("key", key_);
  payload.Set("name", name);
  payload.Set("data", std::move(data));
  Emit("tab", std::move(payload));
}

void ExtensionPopup::SendNavigation(bool loading) {
  content::WebContents* page = contents();
  if (!page) {
    return;
  }
  base::DictValue data;
  data.Set("url", page->GetVisibleURL().spec());
  data.Set("title", base::UTF16ToUTF8(page->GetTitle()));
  data.Set("canGoBack", false);
  data.Set("canGoForward", false);
  data.Set("isLoading", loading);
  data.Set("committedUrl", page->GetLastCommittedURL().spec());
  Send("navigation", std::move(data));
}

void ExtensionPopup::CloseSoon() {
  if (closing_) {
    return;
  }
  CloseFromHost();
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(
                     [](std::string key) { Host::Get()->DropPopup(key); },
                     key_));
}

void ExtensionPopup::Closed(extensions::ExtensionHost* host) {
  CloseSoon();
}

gfx::Size ExtensionPopup::GetMinBounds() {
  return kSmallest;
}

gfx::Size ExtensionPopup::GetMaxBounds() {
  return kLargest;
}

void ExtensionPopup::OnViewPreferredSizeChanged(views::View* view) {
  const gfx::Size size = view->GetPreferredSize();
  if (size.IsEmpty() || size == preferred_) {
    return;
  }
  preferred_ = size;
  base::DictValue data;
  data.Set("width", size.width());
  data.Set("height", size.height());
  Send("preferredSize", std::move(data));
}

void ExtensionPopup::DidStartLoading() {
  SendNavigation(true);
}

void ExtensionPopup::DidStopLoading() {
  SendNavigation(false);
}

void ExtensionPopup::DidFinishNavigation(
    content::NavigationHandle* navigation) {
  if (!navigation->IsInPrimaryMainFrame() || !navigation->HasCommitted() ||
      navigation->IsSameDocument()) {
    return;
  }
  const GURL& url = navigation->GetURL();
  if (!url.SchemeIs(extensions::kExtensionScheme) ||
      url.host() != extension_id_) {
    CloseSoon();
  }
}

void ExtensionPopup::DidOpenRequestedURL(
    content::WebContents* new_contents,
    content::RenderFrameHost* source,
    const GURL& url,
    const content::Referrer& referrer,
    WindowOpenDisposition disposition,
    ui::PageTransition transition,
    bool started_from_context_menu,
    bool renderer_initiated) {
  if (new_contents && new_contents != contents()) {
    CloseSoon();
  }
}

void ExtensionPopup::OnExtensionUnloaded(
    content::BrowserContext* browser_context,
    const extensions::Extension* extension,
    extensions::UnloadedExtensionReason reason) {
  if (extension && extension->id() == extension_id_) {
    CloseSoon();
  }
}

void ExtensionPopup::OnBrowserClosed(BrowserWindowInterface* browser) {
  if (browser == browser_) {
    browser_ = nullptr;
    CloseSoon();
  }
}

}
