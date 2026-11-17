#ifndef ARDIA_WIN_NOW_PLAYING_ARTWORK_H_
#define ARDIA_WIN_NOW_PLAYING_ARTWORK_H_

#include <optional>
#include <string>
#include <vector>

#include "ardia/win/api.h"
#include "base/memory/raw_ref.h"
#include "base/memory/weak_ptr.h"
#include "content/public/browser/global_routing_id.h"
#include "content/public/browser/weak_document_ptr.h"
#include "services/media_session/public/cpp/media_image.h"
#include "url/gurl.h"

class SkBitmap;

namespace content {
class RenderFrameHost;
class WebContents;
}

namespace gfx {
class Size;
}

namespace ardia_win {

class NowPlayingArtwork {
 public:
  explicit NowPlayingArtwork(content::WebContents& contents);
  NowPlayingArtwork(const NowPlayingArtwork&) = delete;
  NowPlayingArtwork& operator=(const NowPlayingArtwork&) = delete;
  ~NowPlayingArtwork();

  void ImagesChanged(std::vector<media_session::MediaImage> images);
  void PageChanged();
  const std::vector<media_session::MediaImage>& images() const {
    return images_;
  }
  std::string Reported(const std::string& url);
  void Download(const std::string& asked, int pixels, Reply reply);
  void AnswerAll();

 private:
  struct Ask {
    GURL url;
    int pixels = 0;
    Reply reply;
  };

  content::RenderFrameHost* Routed() const;
  bool StillRouted() const;
  bool Declared(const GURL& url) const;
  void Start(Ask ask);
  void Downloaded(int generation,
                  GURL url,
                  int id,
                  int http_status,
                  const GURL& image_url,
                  const std::vector<SkBitmap>& bitmaps,
                  const std::vector<gfx::Size>& sizes);

  const raw_ref<content::WebContents> contents_;
  std::vector<media_session::MediaImage> images_;
  content::WeakDocumentPtr document_;
  int generation_ = 0;
  std::string long_url_;
  std::string long_token_;
  int tokens_ = 0;
  bool fetching_ = false;
  Reply fetching_reply_;
  std::optional<Ask> queued_;
  base::WeakPtrFactory<NowPlayingArtwork> weak_factory_{this};
};

}

#endif
