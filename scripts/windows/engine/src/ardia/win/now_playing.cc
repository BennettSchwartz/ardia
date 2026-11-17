#include "ardia/win/now_playing.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string_view>
#include <utility>

#include "ardia/win/tab_state.h"
#include "base/base64.h"
#include "base/functional/bind.h"
#include "base/location.h"
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
#include "url/origin.h"

namespace content {
bool ArdiaWinPageHandlesMediaSessionAction(
    WebContents* contents,
    media_session::mojom::MediaSessionAction action);
}

namespace ardia_win {

namespace {

using Action = media_session::mojom::MediaSessionAction;
using SuspendType = media_session::mojom::MediaSession::SuspendType;

constexpr size_t kTextLimit = 1024;
constexpr size_t kImageUrlLimit = 1 << 20;
constexpr size_t kActionLimit = 32;
constexpr double kSeekLimit = 366.0 * 24 * 60 * 60;
constexpr double kDriftSeconds = 0.5;
constexpr int kMostImagePixels = 512;
constexpr base::TimeDelta kReportGap = base::Milliseconds(100);
constexpr base::TimeDelta kSeekReportDelay = base::Seconds(1);

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

double Projected(const NowPlayingState& state, double at_ms) {
  const double elapsed = state.playback_state == "playing"
                             ? (at_ms - state.timestamp) / 1000 *
                                   state.playback_rate
                             : 0;
  const double reached = std::max(0.0, state.position + elapsed);
  return state.duration ? std::min(reached, *state.duration) : reached;
}

bool SameReport(const std::optional<NowPlayingState>& before,
                const std::optional<NowPlayingState>& after) {
  if (!before || !after) {
    return !before && !after;
  }
  NowPlayingState anchored = *after;
  anchored.position = before->position;
  anchored.timestamp = before->timestamp;
  return anchored == *before &&
         std::abs(Projected(*before, after->timestamp) - after->position) <
             kDriftSeconds;
}

bool ChangesState(const std::optional<NowPlayingState>& before,
                  const std::optional<NowPlayingState>& after) {
  return !before || !after || before->playback_state != after->playback_state ||
         before->controllable != after->controllable;
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
  fields.Set("loop", false);
  data.Set("state", std::move(fields));
  return data;
}

base::DictValue NoImage() {
  base::DictValue result;
  result.Set("uri", base::Value());
  return result;
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

NowPlaying::NowPlaying(content::WebContents* contents)
    : content::WebContentsObserver(contents),
      content::WebContentsUserData<NowPlaying>(*contents) {
  ObserveSession(content::MediaSession::GetIfExists(contents));
}

NowPlaying::~NowPlaying() {
  AnswerArtwork(NoImage());
}

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

MediaCommandResult NowPlaying::Command(content::WebContents* contents,
                                       const MediaCommandArgs& command) {
  NowPlaying* now = contents ? FromWebContents(contents) : nullptr;
  return now ? now->RunCommand(command) : MediaCommandResult::kNoSession;
}

void NowPlaying::DownloadArtwork(content::WebContents* contents,
                                 const base::DictValue& args,
                                 Reply reply) {
  NowPlaying* now = contents ? FromWebContents(contents) : nullptr;
  const std::string* url = args.FindString("url");
  const double limit = args.FindDouble("maxPixels").value_or(0);
  if (!now || !url || !std::isfinite(limit) || limit < 1) {
    std::move(reply).Run(NoImage());
    return;
  }
  now->Download(GURL(*url),
                static_cast<int>(std::min<double>(limit, kMostImagePixels)),
                std::move(reply));
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

bool NowPlaying::Lists(Action action) const {
  return std::ranges::find(session_.actions, action) != session_.actions.end();
}

bool NowPlaying::PageHandles(Action action) const {
  return web_contents() &&
         content::ArdiaWinPageHandlesMediaSessionAction(web_contents(), action);
}

bool NowPlaying::OnPrimaryPage(const content::MediaPlayerId& id) const {
  content::RenderFrameHost* frame =
      content::RenderFrameHost::FromID(id.frame_routing_id);
  return frame && frame->GetPage().IsPrimary();
}

bool NowPlaying::ScriptReaches(const content::MediaPlayerId& id) const {
  content::RenderFrameHost* frame =
      content::RenderFrameHost::FromID(id.frame_routing_id);
  if (!frame || !web_contents()) {
    return false;
  }
  const url::Origin& top =
      web_contents()->GetPrimaryMainFrame()->GetLastCommittedOrigin();
  for (content::RenderFrameHost* each = frame; each; each = each->GetParent()) {
    if (!each->GetLastCommittedOrigin().IsSameOriginWith(top)) {
      return false;
    }
  }
  return true;
}

MediaCommandResult NowPlaying::RunCommand(const MediaCommandArgs& command) {
  content::MediaSession* session =
      web_contents() ? content::MediaSession::GetIfExists(web_contents())
                     : nullptr;
  if (!session || !SessionLive()) {
    return MediaCommandResult::kNoSession;
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
      if (!PageHandles(Action::kNextTrack)) {
        return MediaCommandResult::kRefused;
      }
      session->NextTrack();
      break;
    case MediaAction::kPrevious:
      if (!PageHandles(Action::kPreviousTrack)) {
        return MediaCommandResult::kRefused;
      }
      session->PreviousTrack();
      break;
    case MediaAction::kSeekBy:
      return SeekBy(session, command.seconds);
    case MediaAction::kSeekTo:
      if (!Lists(Action::kSeekTo)) {
        return MediaCommandResult::kRefused;
      }
      session->SeekTo(base::Seconds(command.seconds));
      break;
    case MediaAction::kStop:
      session->Stop(SuspendType::kUI);
      break;
  }
  return MediaCommandResult::kDone;
}

MediaCommandResult NowPlaying::SeekBy(content::MediaSession* session,
                                      double seconds) {
  if (seconds == 0) {
    return MediaCommandResult::kDone;
  }
  const base::TimeDelta delta = base::Seconds(seconds);
  if (delta.is_zero()) {
    return MediaCommandResult::kRefused;
  }
  const Action relative =
      delta.is_positive() ? Action::kSeekForward : Action::kSeekBackward;
  if (!Lists(Action::kSeekTo) && !Lists(relative)) {
    return MediaCommandResult::kRefused;
  }
  if (PageHandles(Action::kSeekTo) && sent_) {
    double target = std::max(0.0, Projected(*sent_, NowMs()) + seconds);
    if (sent_->duration) {
      target = std::min(target, *sent_->duration);
    }
    session->SeekTo(base::Seconds(target));
    return MediaCommandResult::kDone;
  }
  session->Seek(delta);
  if (PageHandles(relative)) {
    seek_report_.Start(FROM_HERE, kSeekReportDelay,
                       base::BindOnce(
                           [](NowPlaying* now) { now->Send(now->Current()); },
                           base::Unretained(this)));
  }
  return MediaCommandResult::kDone;
}

bool NowPlaying::Declared(const GURL& url) const {
  return AllowedImage(url) &&
         std::ranges::any_of(session_.artwork,
                             [&url](const media_session::MediaImage& image) {
                               return image.src == url;
                             });
}

void NowPlaying::Download(const GURL& url, int pixels, Reply reply) {
  content::MediaSession* session =
      content::MediaSession::GetIfExists(web_contents());
  content::RenderFrameHost* frame =
      session ? session->GetRoutedFrame() : nullptr;
  if (!frame || !Declared(url)) {
    std::move(reply).Run(NoImage());
    return;
  }
  AnswerArtwork(NoImage());
  artwork_reply_ = std::move(reply);
  const int request = ++artwork_request_;
  web_contents()->DownloadImageInFrame(
      frame->GetGlobalId(), url, false, gfx::Size(pixels, pixels),
      static_cast<uint32_t>(pixels), false,
      mojo::WrapCallbackWithDefaultInvokeIfNotRun(
          base::BindOnce(&NowPlaying::ArtworkDownloaded,
                         weak_factory_.GetWeakPtr(), request, url),
          0, 0, GURL(), std::vector<SkBitmap>(), std::vector<gfx::Size>()));
}

void NowPlaying::ArtworkDownloaded(int request,
                                   const GURL& asked,
                                   int id,
                                   int http_status,
                                   const GURL& url,
                                   const std::vector<SkBitmap>& bitmaps,
                                   const std::vector<gfx::Size>& sizes) {
  if (request != artwork_request_ || !artwork_reply_) {
    return;
  }
  if (!Declared(asked)) {
    AnswerArtwork(NoImage());
    return;
  }
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
    AnswerArtwork(std::move(result));
    return;
  }
  AnswerArtwork(NoImage());
}

void NowPlaying::AnswerArtwork(base::DictValue answer) {
  if (artwork_reply_) {
    std::move(artwork_reply_).Run(std::move(answer));
  }
}

std::optional<NowPlayingState> NowPlaying::FromSession() const {
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
  return state;
}

std::optional<NowPlayingState> NowPlaying::Held() {
  if (awaiting_page_player_ || heard_.empty() || !web_contents()) {
    held_.reset();
    return std::nullopt;
  }
  if (!held_) {
    if (!sent_) {
      return std::nullopt;
    }
    held_ = sent_;
  }
  const bool playing = std::ranges::any_of(
      heard_, [this](const content::MediaPlayerId& id) {
        return playing_.contains(id);
      });
  if ((held_->playback_state == "playing") != playing) {
    const double now = NowMs();
    held_->position = Projected(*held_, now);
    held_->timestamp = now;
    held_->playback_state = playing ? "playing" : "paused";
  }
  NowPlayingState state = *held_;
  state.controllable =
      held_->controllable &&
      std::ranges::any_of(heard_, [this](const content::MediaPlayerId& id) {
        return ScriptReaches(id);
      });
  return state;
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
  if (SameReport(sent_, state)) {
    coalesce_.Stop();
    return;
  }
  const base::TimeTicks now = base::TimeTicks::Now();
  if (ChangesState(sent_, state) || now - sent_at_ >= kReportGap) {
    Send(state);
    return;
  }
  if (!coalesce_.IsRunning()) {
    coalesce_.Start(FROM_HERE, sent_at_ + kReportGap - now,
                    base::BindOnce(&NowPlaying::Update, base::Unretained(this)));
  }
}

void NowPlaying::Send(const std::optional<NowPlayingState>& state) {
  coalesce_.Stop();
  seek_report_.Stop();
  sent_ = state;
  sent_at_ = base::TimeTicks::Now();
  TabState* tab =
      web_contents() ? TabState::FromWebContents(web_contents()) : nullptr;
  if (tab) {
    tab->Send("nowPlaying", EventData(state));
  }
}

void NowPlaying::Forget() {
  heard_.clear();
  playing_.clear();
  held_.reset();
}

void NowPlaying::Hear(const content::MediaPlayerId& id) {
  heard_.insert(id);
  awaiting_page_player_ = false;
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
  if (!OnPrimaryPage(id)) {
    return;
  }
  playing_.insert(id);
  if (info.has_audio) {
    Hear(id);
  }
  Update();
}

void NowPlaying::MediaStoppedPlaying(const MediaPlayerInfo& info,
                                     const content::MediaPlayerId& id,
                                     MediaStoppedReason reason) {
  if (playing_.erase(id)) {
    Update();
  }
}

void NowPlaying::MediaMetadataChanged(const MediaPlayerInfo& info,
                                      const content::MediaPlayerId& id) {
  if (info.has_audio && !heard_.contains(id) && OnPrimaryPage(id)) {
    Hear(id);
    Update();
  }
}

void NowPlaying::MediaDestroyed(const content::MediaPlayerId& id) {
  playing_.erase(id);
  if (heard_.erase(id)) {
    Update();
  }
}

void NowPlaying::WebContentsDestroyed() {
  coalesce_.Stop();
  seek_report_.Stop();
  receiver_.reset();
  AnswerArtwork(NoImage());
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
  session_.title = metadata ? metadata->title : std::u16string();
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
