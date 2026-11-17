#include "ardia/win/now_playing_artwork.h"

#include <algorithm>
#include <cstdint>
#include <utility>

#include "base/base64.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/time/time.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/storage_partition.h"
#include "content/public/browser/web_contents.h"
#include "net/base/data_url.h"
#include "net/base/isolation_info.h"
#include "net/base/net_errors.h"
#include "net/http/http_response_headers.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/data_decoder/public/cpp/decode_image.h"
#include "services/data_decoder/public/mojom/image_decoder.mojom.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "skia/ext/image_operations.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/gfx/geometry/size.h"

namespace ardia_win {

namespace {

constexpr size_t kImageUrlLimit = 1 << 20;
constexpr size_t kLongestReportedUrl = 2048;
constexpr int kMostImagePixels = 512;
constexpr size_t kMostImageBytes = 2 * 1024 * 1024;
constexpr uint64_t kMostDecodedBytes = 16 * 1024 * 1024;
constexpr base::TimeDelta kTimeout = base::Seconds(30);
constexpr char kTokenPrefix[] = "ardia-artwork:";

constexpr net::NetworkTrafficAnnotationTag kTrafficAnnotation =
    net::DefineNetworkTrafficAnnotation("ardia_now_playing_artwork", R"(
      semantics {
        sender: "Ardia playing card"
        description:
          "Downloads the artwork a page's media session declares for what it "
          "is playing, to show on the sidebar's playing card."
        trigger: "A tab plays media whose session declares artwork."
        data: "None: no cookies or credentials are sent."
        destination: WEBSITE
      }
      policy {
        cookies_allowed: NO
        setting: "None."
        policy_exception_justification: "Not implemented."
      })");

bool IsDataImage(const GURL& url) {
  return base::StartsWith(url.spec(), "data:image/",
                          base::CompareCase::INSENSITIVE_ASCII);
}

bool AllowedImage(const GURL& url) {
  if (!url.is_valid() || url.spec().size() > kImageUrlLimit) {
    return false;
  }
  return url.SchemeIsHTTPOrHTTPS() || IsDataImage(url);
}

base::DictValue NoImage() {
  base::DictValue result;
  result.Set("uri", base::Value());
  return result;
}

base::DictValue ImageOf(const SkBitmap& decoded, int pixels) {
  if (decoded.drawsNothing() || decoded.width() <= 0 || decoded.height() <= 0) {
    return NoImage();
  }
  SkBitmap bitmap = decoded;
  const int longest = std::max(decoded.width(), decoded.height());
  if (longest > pixels) {
    const double scale = static_cast<double>(pixels) / longest;
    const int width = std::max(1, static_cast<int>(decoded.width() * scale));
    const int height = std::max(1, static_cast<int>(decoded.height() * scale));
    bitmap = skia::ImageOperations::Resize(
        decoded, skia::ImageOperations::RESIZE_BEST, width, height);
  }
  std::optional<std::vector<uint8_t>> png =
      gfx::PNGCodec::EncodeBGRASkBitmap(bitmap, false);
  if (!png) {
    return NoImage();
  }
  base::DictValue result;
  result.Set("uri", "data:image/png;base64," + base::Base64Encode(*png));
  result.Set("width", bitmap.width());
  result.Set("height", bitmap.height());
  return result;
}

}

NowPlayingArtwork::NowPlayingArtwork(content::WebContents& contents)
    : contents_(contents) {}

NowPlayingArtwork::~NowPlayingArtwork() {
  AnswerAll();
}

void NowPlayingArtwork::ImagesChanged(
    std::vector<media_session::MediaImage> images) {
  images_ = std::move(images);
}

void NowPlayingArtwork::PageChanged() {
  images_.clear();
  long_url_.clear();
  long_token_.clear();
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
  if (!Declared(url)) {
    std::move(reply).Run(NoImage());
    return;
  }
  Ask ask{url, std::clamp(pixels, 1, kMostImagePixels), std::move(reply)};
  if (current_) {
    if (queued_) {
      std::move(queued_->reply).Run(NoImage());
    }
    queued_ = std::move(ask);
    return;
  }
  Start(std::move(ask));
}

void NowPlayingArtwork::Start(Ask ask) {
  if (!Declared(ask.url)) {
    std::move(ask.reply).Run(NoImage());
    return;
  }
  current_ = std::move(ask);
  const GURL url = current_->url;
  if (IsDataImage(url)) {
    std::string mime_type;
    std::string charset;
    std::string bytes;
    if (!net::DataURL::Parse(url, &mime_type, &charset, &bytes) ||
        bytes.empty() || bytes.size() > kMostImageBytes) {
      Finish(NoImage());
      return;
    }
    Decode(bytes);
    return;
  }
  auto request = std::make_unique<network::ResourceRequest>();
  request->url = url;
  request->method = "GET";
  request->credentials_mode = network::mojom::CredentialsMode::kOmit;
  request->destination = network::mojom::RequestDestination::kImage;
  request->trusted_params.emplace();
  request->trusted_params->isolation_info =
      net::IsolationInfo::CreateTransient(std::nullopt);
  loader_ = network::SimpleURLLoader::Create(std::move(request),
                                             kTrafficAnnotation);
  loader_->SetTimeoutDuration(kTimeout);
  loader_->DownloadToString(
      contents_->GetBrowserContext()
          ->GetDefaultStoragePartition()
          ->GetURLLoaderFactoryForBrowserProcess()
          .get(),
      base::BindOnce(&NowPlayingArtwork::Fetched, weak_factory_.GetWeakPtr()),
      kMostImageBytes);
}

void NowPlayingArtwork::Fetched(std::optional<std::string> body) {
  const network::mojom::URLResponseHead* head =
      loader_ ? loader_->ResponseInfo() : nullptr;
  const bool ok = loader_ && loader_->NetError() == net::OK && body &&
                  !body->empty() && head && head->headers &&
                  head->headers->response_code() == 200;
  loader_.reset();
  if (!ok || !current_ || !Declared(current_->url)) {
    Finish(NoImage());
    return;
  }
  Decode(*body);
}

void NowPlayingArtwork::Decode(const std::string& bytes) {
  data_decoder::DecodeImageIsolated(
      base::as_byte_span(bytes), data_decoder::mojom::ImageCodec::kDefault,
      true, kMostDecodedBytes, gfx::Size(),
      base::BindOnce(&NowPlayingArtwork::Decoded, weak_factory_.GetWeakPtr()));
}

void NowPlayingArtwork::Decoded(const SkBitmap& bitmap) {
  if (!current_ || !Declared(current_->url)) {
    Finish(NoImage());
    return;
  }
  Finish(ImageOf(bitmap, current_->pixels));
}

void NowPlayingArtwork::Finish(base::DictValue result) {
  loader_.reset();
  std::optional<Ask> done = std::move(current_);
  current_.reset();
  if (done && done->reply) {
    std::move(done->reply).Run(std::move(result));
  }
  if (queued_) {
    Ask next = std::move(*queued_);
    queued_.reset();
    Start(std::move(next));
  }
}

void NowPlayingArtwork::AnswerAll() {
  weak_factory_.InvalidateWeakPtrs();
  loader_.reset();
  if (current_) {
    Reply reply = std::move(current_->reply);
    current_.reset();
    if (reply) {
      std::move(reply).Run(NoImage());
    }
  }
  if (queued_) {
    Reply reply = std::move(queued_->reply);
    queued_.reset();
    if (reply) {
      std::move(reply).Run(NoImage());
    }
  }
}

}
