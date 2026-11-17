#include "ardia/win/now_playing.h"

#include <algorithm>
#include <vector>

#include "base/functional/bind.h"
#include "base/location.h"
#include "content/common/content_export.h"
#include "content/public/browser/media_session.h"
#include "content/public/browser/web_contents.h"

namespace content {
CONTENT_EXPORT bool ArdiaWinPageHandlesMediaSessionAction(
    WebContents* contents,
    media_session::mojom::MediaSessionAction action);
}

namespace ardia_win {

namespace {

using Action = media_session::mojom::MediaSessionAction;
using SuspendType = media_session::mojom::MediaSession::SuspendType;

constexpr base::TimeDelta kSeekReportDelay = base::Seconds(1);

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
