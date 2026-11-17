#ifndef ARDIA_WIN_NOW_PLAYING_ARTWORK_H_
#define ARDIA_WIN_NOW_PLAYING_ARTWORK_H_

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "ardia/win/api.h"
#include "base/memory/raw_ref.h"
#include "base/memory/weak_ptr.h"
#include "services/media_session/public/cpp/media_image.h"
#include "url/gurl.h"

class SkBitmap;

namespace content {
class WebContents;
}

namespace network {
class SimpleURLLoader;
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

  bool Declared(const GURL& url) const;
  void Start(Ask ask);
  void Fetched(std::optional<std::string> body);
  void Decode(const std::string& bytes);
  void Decoded(const SkBitmap& bitmap);
  void Finish(base::DictValue result);

  const raw_ref<content::WebContents> contents_;
  std::vector<media_session::MediaImage> images_;
  std::string long_url_;
  std::string long_token_;
  int tokens_ = 0;
  std::optional<Ask> current_;
  std::optional<Ask> queued_;
  std::unique_ptr<network::SimpleURLLoader> loader_;
  base::WeakPtrFactory<NowPlayingArtwork> weak_factory_{this};
};

}

#endif
