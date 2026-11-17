#ifndef ARDIA_WIN_EXTENSION_POPUP_H_
#define ARDIA_WIN_EXTENSION_POPUP_H_

#include <windows.h>

#include <memory>
#include <string>
#include <string_view>

#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/scoped_observation.h"
#include "base/values.h"
#include "chrome/browser/ui/browser_window/public/browser_collection_observer.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/views/extensions/extension_view_views.h"
#include "content/public/browser/web_contents_observer.h"
#include "extensions/browser/extension_registry.h"
#include "extensions/browser/extension_registry_observer.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/views/view.h"
#include "ui/views/view_observer.h"
#include "url/gurl.h"

class Browser;

namespace extensions {
class Extension;
class ExtensionHost;
class ExtensionViewHost;
}

namespace views {
class Widget;
}

namespace ardia_win {

class ExtensionPopup : public ExtensionViewViews::Container,
                       public views::ViewObserver,
                       public content::WebContentsObserver,
                       public extensions::ExtensionRegistryObserver,
                       public BrowserCollectionObserver {
 public:
  static std::unique_ptr<ExtensionPopup> Create(
      std::string key,
      HWND parent,
      const extensions::Extension& extension,
      const GURL& url,
      Browser* browser);
  ExtensionPopup(const ExtensionPopup&) = delete;
  ExtensionPopup& operator=(const ExtensionPopup&) = delete;
  ~ExtensionPopup() override;

  const std::string& key() const { return key_; }
  HWND window() const { return window_; }
  HWND parent() const { return parent_; }
  void set_parent(HWND parent) { parent_ = parent; }
  const gfx::Rect& place() const { return place_; }
  void set_place(const gfx::Rect& place) { place_ = place; }
  bool shown() const { return shown_; }
  content::WebContents* contents() const;
  Browser* browser() const { return browser_; }
  void Show();
  void Hide();
  void CloseFromHost();

 private:
  ExtensionPopup(std::string key,
                 HWND parent,
                 std::unique_ptr<extensions::ExtensionViewHost> host,
                 Browser* browser);

  void Build();
  void Send(std::string_view name, base::DictValue data);
  void SendNavigation(bool loading);
  void CloseSoon();
  void Closed(extensions::ExtensionHost* host);

  gfx::Size GetMinBounds() override;
  gfx::Size GetMaxBounds() override;
  void OnViewPreferredSizeChanged(views::View* view) override;
  void DidStartLoading() override;
  void DidStopLoading() override;
  void DidFinishNavigation(content::NavigationHandle* navigation) override;
  void DidOpenRequestedURL(content::WebContents* new_contents,
                           content::RenderFrameHost* source,
                           const GURL& url,
                           const content::Referrer& referrer,
                           WindowOpenDisposition disposition,
                           ui::PageTransition transition,
                           bool started_from_context_menu,
                           bool renderer_initiated) override;
  void OnExtensionUnloaded(content::BrowserContext* browser_context,
                           const extensions::Extension* extension,
                           extensions::UnloadedExtensionReason reason) override;
  void OnBrowserClosed(BrowserWindowInterface* browser) override;

  const std::string key_;
  const std::string extension_id_;
  HWND parent_ = nullptr;
  HWND window_ = nullptr;
  gfx::Rect place_;
  bool shown_ = false;
  bool closing_ = false;
  gfx::Size preferred_;
  raw_ptr<Browser> browser_;
  std::unique_ptr<extensions::ExtensionViewHost> host_;
  std::unique_ptr<views::Widget> widget_;
  raw_ptr<ExtensionViewViews> view_ = nullptr;
  base::ScopedObservation<views::View, views::ViewObserver> view_observation_{
      this};
  base::ScopedObservation<extensions::ExtensionRegistry,
                          extensions::ExtensionRegistryObserver>
      registry_observation_{this};
  base::ScopedObservation<GlobalBrowserCollection, BrowserCollectionObserver>
      browsers_observation_{this};
  base::WeakPtrFactory<ExtensionPopup> weak_factory_{this};
};

}

#endif
