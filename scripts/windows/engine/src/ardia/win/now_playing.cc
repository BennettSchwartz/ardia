#include "ardia/win/now_playing.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string_view>
#include <utility>

#include "ardia/win/tab_state.h"
#include "base/base64.h"
#include "base/functional/bind.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "content/public/browser/media_session.h"
#include "content/public/browser/page.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "mojo/public/cpp/bindings/callback_helpers.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/gfx/geometry/size.h"
#include "url/gurl.h"

namespace ardia_win {

namespace {

using Action = media_session::mojom::MediaSessionAction;
using SuspendType = media_session::mojom::MediaSession::SuspendType;

constexpr size_t kTextLimit = 1024;
constexpr size_t kImageUrlLimit = 1 << 20;
constexpr size_t kActionLimit = 32;
constexpr double kSeekLimit = 366.0 * 24 * 60 * 60;
constexpr double kDriftSeconds = 0.5;
constexpr double kLoopNearEndSeconds = 0.5;
constexpr double kLoopRestartSeconds = 1;
constexpr base::TimeDelta kSeekSettles = base::Seconds(2);
constexpr int kMostImagePixels = 512;

std::string Bounded(const std::u16string& text) {
  std::u16string bounded = text.substr(0, kTextLimit);
  if (!bounded.empty() && bounded.back() >= 0xD800 &&
      bounded.back() <= 0xDBFF) {
    bounded.pop_back();
  }
  return base::UTF16ToUTF8(bounded);
}

bool AllowedImage(const GURL& url) {
  if (!url.is_valid() || url.spec().size() > kImageUrlLimit) {
    return false;
  }
  return url.SchemeIsHTTPOrHTTPS() ||
         base::StartsWith(url.spec(), "data:image/",
                          base::CompareCase::INSENSITIVE_ASCII);
}

std::optional<std::string_view> ActionName(Action action) {
  switch (action) {
    case Action::kPlay:
      return "play";
    case Action::kPause:
      return "pause";
    case Action::kPreviousTrack:
      return "previoustrack";
    case Action::kNextTrack:
      return "nexttrack";
    case Action::kSeekBackward:
      return "seekbackward";
    case Action::kSeekForward:
      return "seekforward";
    case Action::kSkipAd:
      return "skipad";
    case Action::kStop:
      return "stop";
    case Action::kSeekTo:
      return "seekto";
    case Action::kEnterPictureInPicture:
      return "enterpictureinpicture";
    case Action::kExitPictureInPicture:
      return "exitpictureinpicture";
    case Action::kToggleMicrophone:
      return "togglemicrophone";
    case Action::kToggleCamera:
      return "togglecamera";
    case Action::kHangUp:
      return "hangup";
    case Action::kPreviousSlide:
      return "previousslide";
    case Action::kNextSlide:
      return "nextslide";
    case Action::kEnterAutoPictureInPicture:
      return "enterautopictureinpicture";
    default:
      return std::nullopt;
  }
}

bool HasVideo(const media_session::mojom::MediaSessionInfo& info) {
  if (!info.audio_video_states) {
    return false;
  }
  return std::ranges::any_of(*info.audio_video_states, [](auto state) {
    return state == media_session::mojom::MediaAudioVideoState::kAudioVideo ||
           state == media_session::mojom::MediaAudioVideoState::kVideoOnly;
  });
}

int WidestSize(const media_session::MediaImage& image) {
  int widest = 0;
  for (const gfx::Size& size : image.sizes) {
    widest = std::max(widest, size.width());
  }
  return widest;
}

std::optional<std::string> LargestArtwork(
    const std::vector<media_session::MediaImage>& images) {
  const media_session::MediaImage* chosen = nullptr;
  for (const media_session::MediaImage& image : images) {
    if (AllowedImage(image.src) &&
        (!chosen || WidestSize(image) > WidestSize(*chosen))) {
      chosen = &image;
    }
  }
  return chosen ? std::optional<std::string>(chosen->src.spec())
                : std::nullopt;
}

double NowMs() {
  return base::Time::Now().InMillisecondsFSinceUnixEpoch();
}

double Reached(const NowPlayingState& state, double at_ms) {
  const double elapsed = state.playback_state == "playing"
                             ? (at_ms - state.timestamp) / 1000 *
                                   state.playback_rate
                             : 0;
  return std::max(0.0, state.position + elapsed);
}

double Projected(const NowPlayingState& state, double at_ms) {
  const double reached = Reached(state, at_ms);
  if (!state.duration) {
    return reached;
  }
  if (state.loop && *state.duration > 0) {
    return std::fmod(reached, *state.duration);
  }
  return std::min(reached, *state.duration);
}

bool SameReport(const std::optional<NowPlayingState>& before,
                const std::optional<NowPlayingState>& after) {
  if (!before || !after) {
    return !before && !after;
  }
  NowPlayingState anchored = *after;
  anchored.position = before->position;
  anchored.timestamp = before->timestamp;
  if (!(anchored == *before)) {
    return false;
  }
  double drift = std::abs(Projected(*before, after->timestamp) - after->position);
  if (before->loop && before->duration && *before->duration > 0) {
    drift = std::min(drift, *before->duration - drift);
  }
  return drift < kDriftSeconds;
}

base::DictValue EventData(const std::optional<NowPlayingState>& state) {
  base::DictValue data;
  if (!state) {
    data.Set("state", base::Value());
    return data;
  }
  base::ListValue actions;
  for (const std::string& action : state->actions) {
    actions.Append(action);
  }
  base::DictValue fields;
  fields.Set("title", state->title);
  fields.Set("artist", state->artist);
  fields.Set("album", state->album);
  fields.Set("artwork",
             state->artwork ? base::Value(*state->artwork) : base::Value());
  fields.Set("playbackState", state->playback_state);
  fields.Set("position", state->position);
  fields.Set("duration",
             state->duration ? base::Value(*state->duration) : base::Value());
  fields.Set("playbackRate", state->playback_rate);
  fields.Set("timestamp", state->timestamp);
  fields.Set("hasVideo", state->has_video);
  fields.Set("actions", std::move(actions));
  fields.Set("controllable", state->controllable);
  fields.Set("loop", state->loop);
  data.Set("state", std::move(fields));
  return data;
}

base::DictValue NoImage() {
  base::DictValue result;
  result.Set("uri", base::Value());
  return result;
}

void ImageDownloaded(Reply reply,
                     int id,
                     int http_status,
                     const GURL& url,
                     const std::vector<SkBitmap>& bitmaps,
                     const std::vector<gfx::Size>& sizes) {
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
    std::move(reply).Run(std::move(result));
    return;
  }
  std::move(reply).Run(NoImage());
}

}

std::optional<MediaCommandArgs> ParseMediaCommand(const base::DictValue& args) {
  static constexpr std::pair<std::string_view, MediaAction> kActions[] = {
      {"play", MediaAction::kPlay},       {"pause", MediaAction::kPause},
      {"toggle", MediaAction::kToggle},   {"next", MediaAction::kNext},
      {"previous", MediaAction::kPrevious}, {"seekBy", MediaAction::kSeekBy},
      {"seekTo", MediaAction::kSeekTo},   {"stop", MediaAction::kStop},
  };
  const std::string* name = args.FindString("action");
  if (!name) {
    return std::nullopt;
  }
  std::optional<MediaAction> action;
  for (const auto& [known, value] : kActions) {
    if (*name == known) {
      action = value;
    }
  }
  if (!action) {
    return std::nullopt;
  }
  const base::Value* seconds = args.Find("seconds");
  const bool finite = seconds && (seconds->is_int() || seconds->is_double()) &&
                      std::isfinite(seconds->GetDouble());
  if (seconds && !seconds->is_none() && !finite) {
    return std::nullopt;
  }
  if (*action != MediaAction::kSeekBy && *action != MediaAction::kSeekTo) {
    return MediaCommandArgs{*action, 0};
  }
  if (!finite) {
    return std::nullopt;
  }
  const double value = seconds->GetDouble();
  if (std::abs(value) > kSeekLimit ||
      (*action == MediaAction::kSeekTo && value < 0)) {
    return std::nullopt;
  }
  return MediaCommandArgs{*action, value};
}

void DownloadPageImage(content::WebContents* contents,
                       const base::DictValue& args,
                       Reply reply) {
  const std::string* text = args.FindString("url");
  const GURL url(text ? *text : std::string());
  const double limit = args.FindDouble("maxPixels").value_or(0);
  if (!AllowedImage(url) || !std::isfinite(limit) || limit < 1) {
    std::move(reply).Run(NoImage());
    return;
  }
  const int pixels =
      static_cast<int>(std::min<double>(limit, kMostImagePixels));
  contents->DownloadImage(
      url, false, gfx::Size(pixels, pixels), static_cast<uint32_t>(pixels),
      false,
      base::BindOnce(&ImageDownloaded,
                     mojo::WrapCallbackWithDefaultInvokeIfNotRun(
                         std::move(reply), NoImage())));
}

NowPlaying::NowPlaying(content::WebContents* contents)
    : content::WebContentsObserver(contents),
      content::WebContentsUserData<NowPlaying>(*contents) {
  ObserveSession(content::MediaSession::GetIfExists(contents));
}

NowPlaying::~NowPlaying() = default;

void NowPlaying::Watch(content::WebContents* contents) {
  if (contents && !FromWebContents(contents)) {
    CreateForWebContents(contents);
  }
}

void NowPlaying::Resend(content::WebContents* contents) {
  if (NowPlaying* now = contents ? FromWebContents(contents) : nullptr) {
    now->Send(now->Current());
  }
}

void NowPlaying::End(content::WebContents* contents) {
  NowPlaying* now = contents ? FromWebContents(contents) : nullptr;
  if (now && now->sent_) {
    now->Send(std::nullopt);
  }
}

bool NowPlaying::Command(content::WebContents* contents,
                         const MediaCommandArgs& command) {
  NowPlaying* now = contents ? FromWebContents(contents) : nullptr;
  return now && now->RunCommand(command);
}

void NowPlaying::ObserveSession(content::MediaSession* session) {
  if (!session || receiver_.is_bound()) {
    return;
  }
  session->AddObserver(receiver_.BindNewPipeAndPassRemote());
}

bool NowPlaying::SessionLive() const {
  return session_.active && !awaiting_page_player_;
}

bool NowPlaying::RunCommand(const MediaCommandArgs& command) {
  content::MediaSession* session =
      web_contents() ? content::MediaSession::GetIfExists(web_contents())
                     : nullptr;
  if (!session || !SessionLive()) {
    return false;
  }
  switch (command.action) {
    case MediaAction::kPlay:
      session->Resume(SuspendType::kUI);
      break;
    case MediaAction::kPause:
      session->Suspend(SuspendType::kUI);
      break;
    case MediaAction::kToggle:
      if (session_.playing) {
        session->Suspend(SuspendType::kUI);
      } else {
        session->Resume(SuspendType::kUI);
      }
      break;
    case MediaAction::kNext:
      session->NextTrack();
      break;
    case MediaAction::kPrevious:
      seeked_at_ = base::TimeTicks::Now();
      session->PreviousTrack();
      break;
    case MediaAction::kSeekBy:
      if (command.seconds != 0) {
        seeked_at_ = base::TimeTicks::Now();
        session->Seek(base::Seconds(command.seconds));
      }
      break;
    case MediaAction::kSeekTo:
      seeked_at_ = base::TimeTicks::Now();
      session->SeekTo(base::Seconds(command.seconds));
      break;
    case MediaAction::kStop:
      session->Stop(SuspendType::kUI);
      break;
  }
  return true;
}

std::optional<NowPlayingState> NowPlaying::FromSession() {
  NowPlayingState state;
  state.timestamp = NowMs();
  state.title = Bounded(session_.title);
  state.artist = Bounded(session_.artist);
  state.album = Bounded(session_.album);
  state.artwork = LargestArtwork(session_.artwork);
  state.playback_state = session_.playing ? "playing" : "paused";
  if (session_.position) {
    const double position =
        session_.position->GetPositionAtTime(base::TimeTicks::Now())
            .InSecondsF();
    state.position = std::isfinite(position) ? std::max(0.0, position) : 0;
    const base::TimeDelta duration = session_.position->duration();
    if (!duration.is_max() && duration.is_positive()) {
      state.duration = duration.InSecondsF();
      state.position = std::min(state.position, *state.duration);
    }
    const double rate = session_.position->playback_rate();
    state.playback_rate = std::isfinite(rate) && rate != 0 ? rate : 1;
  }
  state.has_video = session_.has_video;
  for (const Action action : session_.actions) {
    if (state.actions.size() >= kActionLimit) {
      break;
    }
    const std::optional<std::string_view> name = ActionName(action);
    if (name && std::ranges::find(state.actions, *name) == state.actions.end()) {
      state.actions.emplace_back(*name);
    }
  }
  state.controllable = session_.controllable;
  if (sent_ && !loop_ && state.duration && sent_->duration == state.duration &&
      sent_->title == state.title && sent_->playback_state == "playing" &&
      state.playback_state == "playing" &&
      base::TimeTicks::Now() - seeked_at_ > kSeekSettles) {
    const double reached = Reached(*sent_, state.timestamp);
    loop_ = reached >= *state.duration - kLoopNearEndSeconds &&
            state.position <= kLoopRestartSeconds &&
            state.position + kLoopRestartSeconds < reached;
  }
  state.loop = loop_;
  return state;
}

std::optional<NowPlayingState> NowPlaying::Held() {
  if (awaiting_page_player_ || players_.empty() || !web_contents()) {
    held_.reset();
    return std::nullopt;
  }
  if (!held_) {
    if (!sent_ || !web_contents()->IsAudioMuted()) {
      return std::nullopt;
    }
    held_ = sent_;
  }
  const bool playing = !playing_players_.empty();
  if ((held_->playback_state == "playing") != playing) {
    const double now = NowMs();
    held_->position = Projected(*held_, now);
    held_->timestamp = now;
    held_->playback_state = playing ? "playing" : "paused";
  }
  return held_;
}

std::optional<NowPlayingState> NowPlaying::Current() {
  if (SessionLive()) {
    held_.reset();
    return FromSession();
  }
  return Held();
}

void NowPlaying::Update() {
  std::optional<NowPlayingState> state = Current();
  if (!state) {
    loop_ = false;
  }
  if (!SameReport(sent_, state)) {
    Send(state);
  }
}

void NowPlaying::Send(const std::optional<NowPlayingState>& state) {
  sent_ = state;
  TabState* tab =
      web_contents() ? TabState::FromWebContents(web_contents()) : nullptr;
  if (tab) {
    tab->Send("nowPlaying", EventData(state));
  }
}

void NowPlaying::Forget() {
  players_.clear();
  playing_players_.clear();
  held_.reset();
  loop_ = false;
}

void NowPlaying::MediaSessionCreated(content::MediaSession* session) {
  ObserveSession(session);
}

void NowPlaying::PrimaryPageChanged(content::Page& page) {
  Forget();
  awaiting_page_player_ = true;
  Update();
}

void NowPlaying::MediaStartedPlaying(const MediaPlayerInfo& info,
                                     const content::MediaPlayerId& id) {
  content::RenderFrameHost* frame =
      content::RenderFrameHost::FromID(id.frame_routing_id);
  if (!frame || !frame->GetPage().IsPrimary()) {
    return;
  }
  players_.insert(id);
  playing_players_.insert(id);
  awaiting_page_player_ = false;
  Update();
}

void NowPlaying::MediaStoppedPlaying(const MediaPlayerInfo& info,
                                     const content::MediaPlayerId& id,
                                     MediaStoppedReason reason) {
  if (playing_players_.erase(id)) {
    Update();
  }
}

void NowPlaying::MediaDestroyed(const content::MediaPlayerId& id) {
  playing_players_.erase(id);
  if (players_.erase(id)) {
    Update();
  }
}

void NowPlaying::WebContentsDestroyed() {
  receiver_.reset();
}

void NowPlaying::MediaSessionInfoChanged(
    media_session::mojom::MediaSessionInfoPtr info) {
  if (!info) {
    return;
  }
  session_.active = info->state !=
                    media_session::mojom::MediaSessionInfo::SessionState::kInactive;
  session_.playing =
      info->playback_state == media_session::mojom::MediaPlaybackState::kPlaying;
  session_.controllable = info->is_controllable;
  session_.has_video = HasVideo(*info);
  Update();
}

void NowPlaying::MediaSessionMetadataChanged(
    const std::optional<media_session::MediaMetadata>& metadata) {
  const std::u16string title = metadata ? metadata->title : std::u16string();
  if (title != session_.title) {
    loop_ = false;
  }
  session_.title = title;
  session_.artist = metadata ? metadata->artist : std::u16string();
  session_.album = metadata ? metadata->album : std::u16string();
  Update();
}

void NowPlaying::MediaSessionActionsChanged(
    const std::vector<media_session::mojom::MediaSessionAction>& actions) {
  session_.actions = actions;
  Update();
}

void NowPlaying::MediaSessionImagesChanged(
    const base::flat_map<media_session::mojom::MediaSessionImageType,
                         std::vector<media_session::MediaImage>>& images) {
  const auto artwork =
      images.find(media_session::mojom::MediaSessionImageType::kArtwork);
  session_.artwork = artwork != images.end()
                         ? artwork->second
                         : std::vector<media_session::MediaImage>();
  Update();
}

void NowPlaying::MediaSessionPositionChanged(
    const std::optional<media_session::MediaPosition>& position) {
  session_.position = position;
  Update();
}

WEB_CONTENTS_USER_DATA_KEY_IMPL(NowPlaying);

}
