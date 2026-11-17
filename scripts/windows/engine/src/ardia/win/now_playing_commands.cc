#include "ardia/win/now_playing.h"

#include <algorithm>
#include <memory>
#include <string_view>
#include <utility>
#include <vector>

#include "ardia/core/ac_launch_switches.h"
#include "base/functional/bind.h"
#include "base/location.h"
#include "base/unguessable_token.h"
#include "content/common/content_export.h"
#include "content/public/browser/media_session.h"
#include "content/public/browser/media_session_service.h"
#include "content/public/browser/web_contents.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "services/media_session/public/cpp/media_session_service.h"
#include "services/media_session/public/mojom/audio_focus.mojom.h"

namespace content {
CONTENT_EXPORT bool ArdiaWinPageHandlesMediaSessionAction(
    WebContents* contents,
    media_session::mojom::MediaSessionAction action);
}

namespace ardia_win {

namespace {

using Action = media_session::mojom::MediaSessionAction;
using SuspendType = media_session::mojom::MediaSession::SuspendType;
using FocusManager = mojo::Remote<media_session::mojom::AudioFocusManager>;
using SessionState = media_session::mojom::MediaSessionInfo::SessionState;
using FocusType = media_session::mojom::AudioFocusType;

constexpr base::TimeDelta kSeekReportDelay = base::Seconds(1);

std::string_view SessionStateName(SessionState state) {
  switch (state) {
    case SessionState::kActive:
      return "active";
    case SessionState::kDucking:
      return "ducking";
    case SessionState::kSuspended:
      return "suspended";
    case SessionState::kInactive:
      return "inactive";
  }
  return "unknown";
}

std::string_view FocusTypeName(FocusType type) {
  switch (type) {
    case FocusType::kGain:
      return "gain";
    case FocusType::kGainTransientMayDuck:
      return "transientMayDuck";
    case FocusType::kGainTransient:
      return "transient";
    case FocusType::kAmbient:
      return "ambient";
  }
  return "unknown";
}

void AnswerFocusRequests(
    std::unique_ptr<FocusManager> manager,
    const base::UnguessableToken& request_id,
    Reply reply,
    std::vector<media_session::mojom::AudioFocusRequestStatePtr> requests) {
  base::DictValue result;
  result.Set("ok", true);
  result.Set("held", false);
  result.Set("requests", static_cast<int>(requests.size()));
  for (const auto& request : requests) {
    if (!request || !request->request_id ||
        *request->request_id != request_id) {
      continue;
    }
    result.Set("held", true);
    result.Set("type", FocusTypeName(request->audio_focus_type));
    if (request->session_info) {
      result.Set("state", SessionStateName(request->session_info->state));
    }
  }
  std::move(reply).Run(std::move(result));
}

}

void NowPlaying::AudioFocusForTest(content::WebContents* contents,
                                   const base::DictValue& args,
                                   Reply reply) {
  if (!ardiacore::TestInstance()) {
    std::move(reply).Run(Error("audioFocusForTest is for test instances"));
    return;
  }
  auto manager = std::make_unique<FocusManager>();
  content::GetMediaSessionService().BindAudioFocusManager(
      manager->BindNewPipeAndPassReceiver());
  media_session::mojom::AudioFocusManager* asked = manager->get();
  asked->GetFocusRequests(base::BindOnce(
      &AnswerFocusRequests, std::move(manager),
      content::MediaSession::GetRequestIdFromWebContents(contents),
      std::move(reply)));
}

bool NowPlaying::Lists(Action action) const {
  content::MediaSession* session =
      web_contents() ? content::MediaSession::GetIfExists(web_contents())
                     : nullptr;
  if (!session) {
    return false;
  }
  const std::vector<Action> actions = session->GetMediaSessionActionsSync();
  return std::ranges::find(actions, action) != actions.end();
}

bool NowPlaying::PageHandles(Action action) const {
  return web_contents() &&
         content::ArdiaWinPageHandlesMediaSessionAction(web_contents(), action);
}

MediaCommandResult NowPlaying::RunCommand(const MediaCommandArgs& command) {
  content::MediaSession* session =
      web_contents() ? content::MediaSession::GetIfExists(web_contents())
                     : nullptr;
  media_session::mojom::MediaSessionInfoPtr info;
  if (session) {
    info = session->GetMediaSessionInfoSync();
  }
  if (!info ||
      info->state ==
          media_session::mojom::MediaSessionInfo::SessionState::kInactive) {
    return reported_on_page_ ? MediaCommandResult::kNothingDone
                             : MediaCommandResult::kNoSession;
  }
  const bool playing =
      info->playback_state == media_session::mojom::MediaPlaybackState::kPlaying;
  switch (command.action) {
    case MediaAction::kPlay:
      session->Resume(SuspendType::kUI);
      break;
    case MediaAction::kPause:
      session->Suspend(SuspendType::kUI);
      break;
    case MediaAction::kToggle:
      if (playing) {
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
                       base::BindOnce(&NowPlaying::ForceReport,
                                      base::Unretained(this)));
  }
  return MediaCommandResult::kDone;
}

}
