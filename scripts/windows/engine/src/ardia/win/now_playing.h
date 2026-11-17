#ifndef ARDIA_WIN_NOW_PLAYING_H_
#define ARDIA_WIN_NOW_PLAYING_H_

#include <optional>
#include <set>
#include <string>
#include <vector>

#include "ardia/win/api.h"
#include "base/containers/flat_map.h"
#include "base/memory/weak_ptr.h"
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
#include "url/gurl.h"

class SkBitmap;

namespace gfx {
class Size;
}

namespace ardia_win {

struct NowPlayingState {
  std::string title;
  std::string artist;
  std::string album;
  std::optional<std::string> artwork;
  std::string playback_state;
  double position = 0;
  std::optional<double> duration;
  double playback_rate = 1;
  double timestamp = 0;
  bool has_video = false;
  std::vector<std::string> actions;
  bool controllable = false;
  bool operator==(const NowPlayingState&) const = default;
};

enum class MediaAction { kPlay, kPause, kToggle, kNext, kPrevious, kSeekBy, kSeekTo, kStop };

struct MediaCommandArgs {
  MediaAction action;
  double seconds = 0;
};

enum class MediaCommandResult { kDone, kRefused, kNoSession };

std::optional<MediaCommandArgs> ParseMediaCommand(const base::DictValue& args);

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
    std::vector<media_session::mojom::MediaSessionAction> actions;
    std::vector<media_session::MediaImage> artwork;
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
  void MediaMetadataChanged(const MediaPlayerInfo& info,
                            const content::MediaPlayerId& id) override;
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
  bool ScriptReaches(const content::MediaPlayerId& id) const;
  void Hear(const content::MediaPlayerId& id);
  MediaCommandResult RunCommand(const MediaCommandArgs& command);
  MediaCommandResult SeekBy(content::MediaSession* session, double seconds);
  bool Declared(const GURL& url) const;
  void Download(const GURL& url, int pixels, Reply reply);
  void ArtworkDownloaded(int request,
                         const GURL& asked,
                         int id,
                         int http_status,
                         const GURL& url,
                         const std::vector<SkBitmap>& bitmaps,
                         const std::vector<gfx::Size>& sizes);
  void AnswerArtwork(base::DictValue answer);
  std::optional<NowPlayingState> FromSession() const;
  std::optional<NowPlayingState> Held();
  std::optional<NowPlayingState> Current();
  void Update();
  void Send(const std::optional<NowPlayingState>& state);
  void Forget();

  Sample session_;
  std::optional<NowPlayingState> sent_;
  std::optional<NowPlayingState> held_;
  std::set<content::MediaPlayerId> heard_;
  std::set<content::MediaPlayerId> playing_;
  bool awaiting_page_player_ = false;
  base::TimeTicks sent_at_;
  base::OneShotTimer coalesce_;
  base::OneShotTimer seek_report_;
  Reply artwork_reply_;
  int artwork_request_ = 0;
  mojo::Receiver<media_session::mojom::MediaSessionObserver> receiver_{this};
  base::WeakPtrFactory<NowPlaying> weak_factory_{this};
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

}

#endif
