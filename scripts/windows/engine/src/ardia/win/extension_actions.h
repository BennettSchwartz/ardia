#ifndef ARDIA_WIN_EXTENSION_ACTIONS_H_
#define ARDIA_WIN_EXTENSION_ACTIONS_H_

#include <windows.h>

#include <optional>
#include <string>

#include "ardia/win/api.h"
#include "base/time/time.h"
#include "base/values.h"
#include "url/gurl.h"

class Profile;

namespace content {
class WebContents;
}

namespace ardia_win {

struct PopupGrant {
  std::string extension_id;
  std::string page_key;
  GURL url;
  base::TimeTicks at;
};

bool CallExtensionTabMethod(content::WebContents* contents,
                            HWND window,
                            const std::string& method,
                            const base::DictValue& args,
                            Reply& reply);
std::optional<PopupGrant> TakePopupGrant(HWND window, const GURL& url);
void ForgetPopupGrants(HWND window);
base::DictValue ExtensionActionsOf(Profile* profile);

}

#endif
