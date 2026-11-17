#ifndef ARDIA_WIN_NOW_PLAYING_H_
#define ARDIA_WIN_NOW_PLAYING_H_

#include <optional>
#include <set>
#include <string>
#include <vector>

#include "ardia/win/api.h"
#include "ardia/win/now_playing_artwork.h"
#include "ardia/win/now_playing_state.h"
#include "base/containers/flat_map.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "base/values.h"
#include "content/public/browser/media_player_id.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_user_data.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "services/media_session/public/cpp/media_image.h"
#include "services/media_session/public/cpp/media_metadata.h"
#include "services/media_session/public/cpp/media_position.h"
#include "services/media_session/public/mojom/media_session.mojom.h"

namespace ardia_win {

class NowPlaying : public content::WebContentsObserver,
                   public content::WebContentsUserData<NowPlaying>,
                   public media_session::mojom::MediaSessionObserver {
 public:
  NowPlaying(const NowPlaying&) = delete;
  NowPlaying& operator=(const NowPlaying&) = delete;
  ~NowPlaying() override;

  static void Watch(content::WebContents* contents);
  static void Resend(content::WebContents* contents);
  static void End(content::WebContents* contents);
  static MediaCommandResult Command(content::WebContents* contents,
                                    const MediaCommandArgs& command);
  static void DownloadArtwork(content::WebContents* contents,
                              const base::DictValue& args,
                              Reply reply);

 private:
  friend class content::WebContentsUserData<NowPlaying>;

  struct Sample {
    bool active = false;
    bool playing = false;
    bool controllable = false;
    bool has_video = false;
    std::u16string title;
    std::u16string artist;
    std::u16string album;
    std::optional<media_session::MediaPosition> position;
  };

  explicit NowPlaying(content::WebContents* contents);

  void MediaSessionCreated(content::MediaSession* session) override;
  void PrimaryPageChanged(content::Page& page) override;
  void MediaStartedPlaying(const MediaPlayerInfo& info,
                           const content::MediaPlayerId& id) override;
  void MediaStoppedPlaying(const MediaPlayerInfo& info,
                           const content::MediaPlayerId& id,
                           MediaStoppedReason reason) override;
  void MediaDestroyed(const content::MediaPlayerId& id) override;
  void WebContentsDestroyed() override;

  void MediaSessionInfoChanged(
      media_session::mojom::MediaSessionInfoPtr info) override;
  void MediaSessionMetadataChanged(
      const std::optional<media_session::MediaMetadata>& metadata) override;
  void MediaSessionActionsChanged(
      const std::vector<media_session::mojom::MediaSessionAction>& actions)
      override;
  void MediaSessionImagesChanged(
      const base::flat_map<media_session::mojom::MediaSessionImageType,
                           std::vector<media_session::MediaImage>>& images)
      override;
  void MediaSessionPositionChanged(
      const std::optional<media_session::MediaPosition>& position) override;

  void ObserveSession(content::MediaSession* session);
  bool SessionLive() const;
  bool Lists(media_session::mojom::MediaSessionAction action) const;
  bool PageHandles(media_session::mojom::MediaSessionAction action) const;
  bool OnPrimaryPage(const content::MediaPlayerId& id) const;
  content::RenderFrameHost* RepresentedFrame() const;
  MediaCommandResult RunCommand(const MediaCommandArgs& command);
  MediaCommandResult RunInRepresentedFrame(const MediaCommandArgs& command);
  MediaCommandResult SeekBy(content::MediaSession* session, double seconds);
  std::optional<NowPlayingState> FromSession() const;
  std::optional<NowPlayingState> Held();
  std::optional<NowPlayingState> Current();
  void Update();
  void ForceReport();
  void Send(const std::optional<NowPlayingState>& state);
  void Forget();

  Sample session_;
  std::vector<media_session::mojom::MediaSessionAction> actions_;
  std::optional<NowPlayingState> sent_;
  std::optional<NowPlayingState> held_;
  std::set<content::MediaPlayerId> heard_;
  std::set<content::MediaPlayerId> playing_;
  std::optional<content::MediaPlayerId> represented_;
  bool awaiting_page_player_ = false;
  bool force_report_ = false;
  base::TimeTicks sent_at_;
  base::OneShotTimer coalesce_;
  base::OneShotTimer seek_report_;
  NowPlayingArtwork artwork_;
  mojo::Receiver<media_session::mojom::MediaSessionObserver> receiver_{this};
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

}

#endif
