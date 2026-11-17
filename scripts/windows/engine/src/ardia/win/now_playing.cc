#include "ardia/win/now_playing.h"

#include <algorithm>
#include <cmath>
#include <utility>

#include "ardia/win/tab_state.h"
#include "base/functional/bind.h"
#include "base/location.h"
#include "content/public/browser/media_session.h"
#include "content/public/browser/page.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"

namespace ardia_win {

namespace {

using Action = media_session::mojom::MediaSessionAction;

constexpr size_t kActionLimit = 32;
constexpr int kMostImagePixels = 512;
constexpr base::TimeDelta kReportGap = base::Milliseconds(100);

}

NowPlaying::NowPlaying(content::WebContents* contents)
    : content::WebContentsObserver(contents),
      content::WebContentsUserData<NowPlaying>(*contents),
      artwork_(*contents) {
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
    base::DictValue none;
    none.Set("uri", base::Value());
    std::move(reply).Run(std::move(none));
    return;
  }
  now->artwork_.Download(
      *url, static_cast<int>(std::min<double>(limit, kMostImagePixels)),
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

bool NowPlaying::OnPrimaryPage(const content::MediaPlayerId& id) const {
  content::RenderFrameHost* frame =
      content::RenderFrameHost::FromID(id.frame_routing_id);
  return frame && frame->GetPage().IsPrimary();
}

content::RenderFrameHost* NowPlaying::RepresentedFrame() const {
  if (!represented_ || !heard_.contains(*represented_)) {
    return nullptr;
  }
  content::RenderFrameHost* frame =
      content::RenderFrameHost::FromID(represented_->frame_routing_id);
  return frame && frame->IsRenderFrameLive() && frame->GetPage().IsPrimary()
             ? frame
             : nullptr;
}

std::optional<NowPlayingState> NowPlaying::FromSession() const {
  NowPlayingState state;
  state.timestamp = NowMs();
  state.title = BoundedText(session_.title);
  state.artist = BoundedText(session_.artist);
  state.album = BoundedText(session_.album);
  state.artwork = LargestArtwork(artwork_.images());
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
  for (const Action action : actions_) {
    if (state.actions.size() >= kActionLimit) {
      break;
    }
    const std::optional<std::string_view> name = MediaActionName(action);
    if (name && std::ranges::find(state.actions, *name) == state.actions.end()) {
      state.actions.emplace_back(*name);
    }
  }
  state.controllable = session_.controllable;
  return state;
}

std::optional<NowPlayingState> NowPlaying::Held() {
  if (awaiting_page_player_ || !RepresentedFrame()) {
    held_.reset();
    return std::nullopt;
  }
  if (!held_) {
    if (!sent_) {
      return std::nullopt;
    }
    held_ = sent_;
  }
  const bool playing = playing_.contains(*represented_);
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
  if (!force_report_ && SameReport(sent_, state)) {
    coalesce_.Stop();
    return;
  }
  const base::TimeTicks now = base::TimeTicks::Now();
  if (now - sent_at_ >= kReportGap) {
    Send(state);
    return;
  }
  if (!coalesce_.IsRunning()) {
    coalesce_.Start(FROM_HERE, sent_at_ + kReportGap - now,
                    base::BindOnce(&NowPlaying::Update, base::Unretained(this)));
  }
}

void NowPlaying::ForceReport() {
  force_report_ = true;
  Update();
}

void NowPlaying::Send(const std::optional<NowPlayingState>& state) {
  coalesce_.Stop();
  seek_report_.Stop();
  force_report_ = false;
  sent_ = state;
  sent_at_ = base::TimeTicks::Now();
  TabState* tab =
      web_contents() ? TabState::FromWebContents(web_contents()) : nullptr;
  if (!tab) {
    return;
  }
  std::optional<std::string> artwork;
  if (state && state->artwork) {
    artwork = artwork_.Reported(*state->artwork);
  }
  tab->Send("nowPlaying", NowPlayingEventData(state, std::move(artwork)));
}

void NowPlaying::Forget() {
  heard_.clear();
  playing_.clear();
  represented_.reset();
  held_.reset();
}

void NowPlaying::MediaSessionCreated(content::MediaSession* session) {
  ObserveSession(session);
}

void NowPlaying::PrimaryPageChanged(content::Page& page) {
  Forget();
  artwork_.PageChanged();
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
    heard_.insert(id);
    represented_ = id;
    awaiting_page_player_ = false;
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

void NowPlaying::MediaDestroyed(const content::MediaPlayerId& id) {
  playing_.erase(id);
  const bool heard = heard_.erase(id) > 0;
  if (represented_ == id) {
    represented_.reset();
  }
  if (heard) {
    Update();
  }
}

void NowPlaying::WebContentsDestroyed() {
  coalesce_.Stop();
  seek_report_.Stop();
  receiver_.reset();
  artwork_.AnswerAll();
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
  session_.has_video = SessionHasVideo(*info);
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
  actions_ = actions;
  Update();
}

void NowPlaying::MediaSessionImagesChanged(
    const base::flat_map<media_session::mojom::MediaSessionImageType,
                         std::vector<media_session::MediaImage>>& images) {
  const auto artwork =
      images.find(media_session::mojom::MediaSessionImageType::kArtwork);
  artwork_.ImagesChanged(artwork != images.end()
                             ? artwork->second
                             : std::vector<media_session::MediaImage>());
  Update();
}

void NowPlaying::MediaSessionPositionChanged(
    const std::optional<media_session::MediaPosition>& position) {
  session_.position = position;
  Update();
}

WEB_CONTENTS_USER_DATA_KEY_IMPL(NowPlaying);

}
