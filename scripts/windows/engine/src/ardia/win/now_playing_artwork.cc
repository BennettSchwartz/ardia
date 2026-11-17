#include "ardia/win/now_playing_artwork.h"

#include <algorithm>
#include <cstdint>
#include <utility>

#include "base/base64.h"
#include "base/functional/bind.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "content/public/browser/media_session.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "mojo/public/cpp/bindings/callback_helpers.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/gfx/geometry/size.h"

namespace ardia_win {

namespace {

constexpr size_t kImageUrlLimit = 1 << 20;
constexpr size_t kLongestReportedUrl = 2048;
constexpr int kMostImagePixels = 512;
constexpr char kTokenPrefix[] = "ardia-artwork:";

bool AllowedImage(const GURL& url) {
  if (!url.is_valid() || url.spec().size() > kImageUrlLimit) {
    return false;
  }
  return url.SchemeIsHTTPOrHTTPS() ||
         base::StartsWith(url.spec(), "data:image/",
                          base::CompareCase::INSENSITIVE_ASCII);
}

base::DictValue NoImage() {
  base::DictValue result;
  result.Set("uri", base::Value());
  return result;
}

base::DictValue ImageOf(const std::vector<SkBitmap>& bitmaps) {
  for (const SkBitmap& bitmap : bitmaps) {
    if (bitmap.drawsNothing() || bitmap.width() > kMostImagePixels ||
        bitmap.height() > kMostImagePixels) {
      continue;
    }
    std::optional<std::vector<uint8_t>> png =
        gfx::PNGCodec::EncodeBGRASkBitmap(bitmap, false);
    if (!png) {
      continue;
    }
    base::DictValue result;
    result.Set("uri", "data:image/png;base64," + base::Base64Encode(*png));
    result.Set("width", bitmap.width());
    result.Set("height", bitmap.height());
    return result;
  }
  return NoImage();
}

}

NowPlayingArtwork::NowPlayingArtwork(content::WebContents& contents)
    : contents_(contents) {}

NowPlayingArtwork::~NowPlayingArtwork() {
  AnswerAll();
}

content::RenderFrameHost* NowPlayingArtwork::Routed() const {
  content::MediaSession* session =
      content::MediaSession::GetIfExists(&*contents_);
  return session ? session->GetRoutedFrame() : nullptr;
}

bool NowPlayingArtwork::StillRouted() const {
  content::RenderFrameHost* frame = document_.AsRenderFrameHostIfValid();
  return frame && frame == Routed();
}

void NowPlayingArtwork::ImagesChanged(
    std::vector<media_session::MediaImage> images) {
  images_ = std::move(images);
  content::RenderFrameHost* routed = Routed();
  document_ = routed ? routed->GetWeakDocumentPtr() : content::WeakDocumentPtr();
  ++generation_;
}

void NowPlayingArtwork::PageChanged() {
  images_.clear();
  document_ = content::WeakDocumentPtr();
  ++generation_;
}

bool NowPlayingArtwork::Declared(const GURL& url) const {
  return AllowedImage(url) &&
         std::ranges::any_of(images_,
                             [&url](const media_session::MediaImage& image) {
                               return image.src == url;
                             });
}

std::string NowPlayingArtwork::Reported(const std::string& url) {
  if (url.size() <= kLongestReportedUrl) {
    return url;
  }
  if (url != long_url_) {
    long_url_ = url;
    long_token_ = kTokenPrefix + base::NumberToString(++tokens_);
  }
  return long_token_;
}

void NowPlayingArtwork::Download(const std::string& asked,
                                 int pixels,
                                 Reply reply) {
  const GURL url(!long_token_.empty() && asked == long_token_ ? long_url_
                                                              : asked);
  if (!Declared(url) || !StillRouted()) {
    std::move(reply).Run(NoImage());
    return;
  }
  Ask ask{url, std::clamp(pixels, 1, kMostImagePixels), std::move(reply)};
  if (fetching_) {
    if (queued_) {
      std::move(queued_->reply).Run(NoImage());
    }
    queued_ = std::move(ask);
    return;
  }
  Start(std::move(ask));
}

void NowPlayingArtwork::Start(Ask ask) {
  content::RenderFrameHost* frame = document_.AsRenderFrameHostIfValid();
  if (!frame || frame != Routed() || !Declared(ask.url)) {
    std::move(ask.reply).Run(NoImage());
    return;
  }
  fetching_ = true;
  fetching_reply_ = std::move(ask.reply);
  contents_->DownloadImageInFrame(
      frame->GetGlobalId(), ask.url, false, gfx::Size(ask.pixels, ask.pixels),
      static_cast<uint32_t>(ask.pixels), false,
      mojo::WrapCallbackWithDefaultInvokeIfNotRun(
          base::BindOnce(&NowPlayingArtwork::Downloaded,
                         weak_factory_.GetWeakPtr(), generation_, ask.url),
          0, 0, GURL(), std::vector<SkBitmap>(), std::vector<gfx::Size>()));
}

void NowPlayingArtwork::Downloaded(int generation,
                                   GURL url,
                                   int id,
                                   int http_status,
                                   const GURL& image_url,
                                   const std::vector<SkBitmap>& bitmaps,
                                   const std::vector<gfx::Size>& sizes) {
  fetching_ = false;
  Reply reply = std::move(fetching_reply_);
  const bool stands =
      generation == generation_ && StillRouted() && Declared(url);
  if (reply) {
    std::move(reply).Run(stands ? ImageOf(bitmaps) : NoImage());
  }
  if (queued_) {
    Ask next = std::move(*queued_);
    queued_.reset();
    Start(std::move(next));
  }
}

void NowPlayingArtwork::AnswerAll() {
  if (fetching_reply_) {
    std::move(fetching_reply_).Run(NoImage());
  }
  if (queued_) {
    Reply reply = std::move(queued_->reply);
    queued_.reset();
    std::move(reply).Run(NoImage());
  }
}

}
