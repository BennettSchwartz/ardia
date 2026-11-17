#ifndef ARDIA_WIN_AUTOPLAY_H_
#define ARDIA_WIN_AUTOPLAY_H_

#include <string>

#include "base/values.h"

namespace content {
class RenderFrameHost;
class WebContents;
}

namespace ardia_win {

void InstallAutoplayPolicy();
void WatchAutoplay(content::WebContents* contents);
base::DictValue SetBlockAutoplayEverywhere(const base::DictValue& args);
void RunMediaCommand(content::WebContents* contents, const std::string& script);
void RunMediaCommandIn(content::RenderFrameHost* frame,
                       const std::string& script);

}

#endif
