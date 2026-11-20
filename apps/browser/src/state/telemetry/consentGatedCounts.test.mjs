import assert from "node:assert/strict";
import { after, test } from "node:test";
globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("./client.ts");

const sharing = (on) => {
  client.loadChoice();
  client.setSharing(on, "settings");
};
after(() => client.setSharing(false, "settings"));

let clock = 0;
let windowlessGiven = 0;
const playing = { playbackState: "playing", position: 10, duration: 100, playbackRate: 1, timestamp: 0, loop: false };

const ROWS = [
  ["autoHideTabsChoices", (m) => m.noteAutoHideTabsChosen(), "takeAutoHideTabsChoices", null, 1],
  ["autoHideTabsChoices", (m) => m.noteTornOffWindowKeptAutoHide(), "takeTornOffWindowsKeptAutoHide", null, 1],
  ["bookmarkMoves", (m) => m.noteBookmarksMoved(3), "takeBookmarkMoveCounts", "bookmarks_moved", 3],
  ["bookmarkMoves", (m) => m.noteBookmarkSyncDiff(40), "takeBookmarkMoveCounts", "bookmark_sync_diff_ms_max", 40],
  ["cleanUpCounts", (m) => m.noteAutoCleanUp(3, 1), "takeCleanUpCounts", "clean_up_auto_tabs", 3],
  ["configProblemToasts", (m) => m.noteConfigProblemToastShown(), "takeConfigProblemToastCounts", "config_problem_toasts", 1],
  ["configProblemToasts", (m) => m.noteConfigProblemToastDismissed(), "takeConfigProblemToastCounts", "config_problem_toast_dismissals", 1],
  ["developerModeCounts", (m) => m.noteDeveloperModeToggled(false, true), "takeDeveloperModeCounts", "developer_mode_turned_off_on_local_sites", 1],
  ["developerModeCounts", (m) => m.noteDeveloperBarPress("console"), "takeDeveloperModeCounts", "developer_bar_console_opens", 1],
  ["dockCounts", (m) => m.noteSidebarSlide(true), "takeDockCounts", "sidebar_slides_past_target", 1],
  ["dockCounts", (m) => m.noteSidebarPeekRevealHeldBack(), "takeDockCounts", "sidebar_peek_reveals_held_back", 1],
  ["dockCounts", (m) => m.notePageFullScreenPeek(), "takeDockCounts", "sidebar_page_full_screen_peeks", 1],
  ["dockCounts", (m) => m.noteSidebarPeekResize(), "takeDockCounts", "sidebar_peek_resizes", 1],
  ["dockCounts", (m) => m.noteSidebarPeekClosedWhileResizing(), "takeDockCounts", "sidebar_peek_closes_while_resizing", 1],
  ["dockCounts", (m) => m.noteSidebarScreenEdge("stopped"), "takeDockCounts", "sidebar_screen_edge_stops", 1],
  ["dockCounts", (m) => m.noteFullScreenPeek(), "takeDockCounts", "sidebar_full_screen_peeks", 1],
  ["dockCounts", (m) => m.noteFullScreenPeekClosed(100), "takeDockCounts", "sidebar_full_screen_peek_quick_closes", 1],
  ["dockCounts", (m) => m.noteSidebarFieldRemeasure(), "takeDockCounts", "sidebar_field_remeasures", 1],
  ["downloadWork", (m) => m.noteDownloadProgressUpdate(), "takeDownloadWork", "download_progress_updates", 1],
  ["downloadWork", (m) => m.noteDownloadHistoryWrite(2048), "takeDownloadWork", "download_history_kb_written", 2],
  ["introCounts", (m) => m.noteIntroShown(true), "takeIntroCounts", "intros_music_muted", 1],
  ["introCounts", (m) => m.noteIntroSkipped(), "takeIntroCounts", "intros_skipped", 1],
  ["introCounts", (m) => m.noteIntroMusicFailed(), "takeIntroCounts", "intros_music_failed", 1],
  ["introCounts", (m) => m.noteIntroEnded({ skipped: false, shown: "animated", firstFrameMs: 640 }), "takeIntroCounts", "intros_finished", 1],
  ["littleArdiaEscapes", (m) => m.noteLittleArdiaAppHandoff("returnToApp"), "takeLittleArdiaEscapeCloses", "little_ardia_returns_to_app", 1],
  ["littleArdiaEscapes", (m) => m.noteLittleArdiaLinkKeptBehind("arrival"), "takeLittleArdiaEscapeCloses", "little_ardia_link_windows_kept_on_arrival", 1],
  ["littleArdiaEscapes", (m) => m.noteLittleArdiaReturnsDropped(3), "takeLittleArdiaEscapeCloses", "little_ardia_returns_dropped", 3],
  ["littleArdiaEscapes", (m) => m.noteLittleArdiaFitBelowSaved(), "takeLittleArdiaEscapeCloses", "little_ardia_fits_below_saved_size", 1],
  ["littleArdiaEscapes", (m) => m.noteLittleArdiaEscapeClose("window"), "takeLittleArdiaEscapeCloses", "little_ardia_escape_closes_unfocused", 1],
  ["liveCompletedTabs", (m) => m.noteLiveCompletedTabsClosed(3), "takeLiveCompletedTabsClosed", null, 3],
  ["mediaCardCounts", (m) => m.sidebarPlayerOpenCounter().motionStarted(true), "takeMediaCardCounts", "sidebar_player_expands", 1],
  ["mediaCardCounts", (m) => m.noteSidebarPlayerFromOtherProfile(), "takeMediaCardCounts", "sidebar_player_from_other_profile", 1],
  ["mediaCardCounts", (m) => m.noteNowPlayingLoopRestart(), "takeMediaCardCounts", "now_playing_loop_restarts", 1],
  ["mediaCardCounts", (m) => m.noteMediaPositionReport(playing, { ...playing, position: 0, timestamp: 1000 }), "takeMediaCardCounts", "media_position_rewinds", 1],
  ["memoryTrimCounts", (m) => m.noteMemoryTrim(), "takeMemoryTrimCounts", "engine_memory_trims", 1],
  ["memoryTrimCounts", (m) => m.noteMemoryTrimFailure(), "takeMemoryTrimCounts", "engine_memory_trim_failures", 1],
  ["memoryTrimCounts", (m) => m.noteMemoryTrimGivenUp(), "takeMemoryTrimCounts", "engine_memory_trims_given_up", 1],
  ["memoryTrimCounts", (m) => m.noteHeapCollection(50, true), "takeMemoryTrimCounts", "memory_trim_slow_collections", 1],
  ["openTabSyncCounts", (m) => m.noteOpenTabsPublished(4), "takeOpenTabSyncCounts", "sync_open_tabs_published", 4],
  ["openTabSyncCounts", (m) => m.noteOpenTabsWoke(), "takeOpenTabSyncCounts", "sync_open_tabs_wakes", 1],
  ["openTabSyncCounts", (m) => m.noteOpenTabsApplied({ opened: 2, closed: 5, updated: 1 }), "takeOpenTabSyncCounts", "sync_open_tabs_mass_closes", 1],
  ["pagerCounts", (m) => m.notePagerSettle(false), "takePagerCounts", "profile_pager_settles_without_switch", 1],
  ["pagerCounts", (m) => m.noteProfileDotReorder(), "takePagerCounts", "profile_dot_reorders", 1],
  ["peekMotion", (m) => m.notePeekEntrance("genie", true, false), "takePeekMotionCounts", "peek_mesh_fallbacks", 1],
  ["peekMotion", (m) => m.notePeekInterrupt(), "takePeekMotionCounts", "peek_entrance_interrupts", 1],
  ["peekMotion", (m) => m.notePeekDone("promoted"), "takePeekMotionCounts", "peek_promotes", 1],
  ["popupTabCounts", (m) => m.notePopupOpenedAsTab(), "takePopupTabCounts", "popups_opened_as_tabs", 1],
  ["popupTabCounts", (m) => m.notePeekFromShiftWindow(), "takePopupTabCounts", "shift_click_window_peeks", 1],
  ["recentlyClosedCounts", (m) => m.noteRecentlyClosedCleared(4), "takeRecentlyClosedCounts", "recently_closed_entries_cleared", 4],
  ["sessionWrites", (m) => m.noteSessionWrite(3072, true), "takeSessionWrites", "session_kb_written", 3],
  ["sidebarResizeCounts", (m) => m.noteSidebarResize(), "takeSidebarResizeCounts", "sidebar_resizes", 1],
  ["sidebarScrollCounts", (m) => m.noteSidebarScrolled((clock += 1000)), "takeSidebarScrollCounts", "sidebar_scrolls", 1],
  ["sidebarScrollCounts", (m) => m.noteSidebarHoverHeld(), "takeSidebarScrollCounts", "sidebar_scroll_held_hovers", 1],
  ["sidebarScrollCounts", (m) => m.noteNewTabDocked(false), "takeSidebarScrollCounts", "sidebar_new_tab_undocks", 1],
  ["tidyTabsCounts", (m) => m.noteTidyTabsRun(4), "takeTidyTabsCounts", "tidy_tabs_moved", 4],
  ["tidyTabsCounts", (m) => m.noteTidyTabsUndo(), "takeTidyTabsCounts", "tidy_tabs_undos", 1],
  ["urlCopies", (m) => m.noteUrlCopied(true), "takeUrlCopyCounts", "url_copies_while_pending", 1],
  ["urlCopies", (m) => m.noteSelectedTabUrlsCopied(), "takeUrlCopyCounts", "url_copies_of_selected_tabs", 1],
  ["hoverCardCounts", (m) => m.noteTabHoverCardPress(true), "takeHoverCardCounts", "tab_hover_card_resets", 1],
  ["hoverCardCounts", (m) => m.noteTabMenuPinnedReset(), "takeHoverCardCounts", "tab_menu_pinned_resets", 1],
  ["liveGithub", (m) => m.noteLiveGithubRequest("held"), "takeLiveGithubCounts", "live_github_requests_held", 1],
  ["liveGithub", (m) => m.noteLiveGithubDetails(3, 1), "takeLiveGithubCounts", "live_github_details_fetched", 3],
  ["liveHides", (m) => m.noteLiveRowHide(), "takeLiveHideCounts", "live_row_hides", 1],
  ["liveHides", (m) => m.noteLiveStackHide(), "takeLiveHideCounts", "live_stack_hides", 1],
  ["liveHides", (m) => m.noteLiveRepoMenuPick("repos:none", true), "takeLiveHideCounts", "live_repo_hide_alls", 1],
  ["tabSwitcherOpens", (m) => m.noteTabSwitcherOpenedInWebKit(), "takeTabSwitcherOpensInWebKit", null, 1],
  ["tabSwitcherOpens", (m) => m.noteTabSwitcherOverflowOpened(), "takeTabSwitcherScrollCounts", "tab_switcher_overflow_opens", 1],
  ["tabSwitcherOpens", (m) => m.noteTabSwitcherOverflowClick(), "takeTabSwitcherScrollCounts", "tab_switcher_overflow_clicks", 1],
  ["tabSwitcherOpens", (m) => m.noteTabSwitcherWheelScrolled(), "takeTabSwitcherScrollCounts", "tab_switcher_wheel_scrolls", 1],
  ["pictureInPictureCounts", (m) => m.notePictureInPictureBackToTab("webkit"), "takePictureInPictureCounts", "backToTab.webkit", 1],
  ["tabSleepCounts", (m) => m.noteCaptureIndicatorCleared(), "takeTabSleepCounts", "capture_indicators_cleared", 1],
  ["tabSleepCounts", (m) => m.noteMediaCardCleared(), "takeTabSleepCounts", "media_cards_cleared", 1],
  ["tabSleepCounts", (m) => m.noteTabSlept(true, "proactive"), "takeTabSleepCounts", "pinned_tabs_slept_by_memory_saver", 1],
  ["tabSleepCounts", (m) => m.noteTabSleptOverBudgetReopened(), "takeTabSleepCounts", "tabs_slept_over_budget_reopened", 1],
  ["tabSleepCounts", (m) => m.noteBudgetSweep(2, 1), "takeTabSleepCounts", "tabs_over_budget_skipped_loading", 2],
  ["tabSleepCounts", (m) => m.noteProfileUnloaded(), "takeTabSleepCounts", "profiles_unloaded", 1],
  ["tabSleepCounts", (m) => m.noteUnloadedProfileReopened(), "takeTabSleepCounts", "unloaded_profiles_reopened", 1],
  ["tabSleepCounts", (m) => m.noteUnloadedProfileReloaded(120), "takeTabSleepCounts", "unloaded_profile_reload_ms", 120],
  ["tabSleepCounts", (m) => m.noteTopAppsKeptRunning(2), "takeTabSleepCounts", "top_app_closes_kept_running", 2],
  ["tabSleepCounts", (m) => m.noteTopAppUnloadedFromMenu(), "takeTabSleepCounts", "top_apps_unloaded_from_menu", 1],
  ["updateCounts", (m) => m.noteSwitchRefresh("failed"), "takeUpdateCounts", "kill_switch_refresh_failures", 1],
  ["updateCounts", (m) => m.noteLoginPasswordCheck("denied"), "takeUpdateCounts", "login_password_checks_denied", 1],
  ["cliCounts", (m) => m.noteCliPillShown(true), "takeCliCounts", "cli_pill_compact_shows", 1],
  ["cliCounts", (m) => m.noteCliAutoEnabled(), "takeCliCounts", "cli_auto_enables", 1],
  ["cliCounts", (m) => m.noteWindowlessPages({ given: (windowlessGiven += 2), missed: 0 }), "takeCliCounts", "windowless_pages_given_geometry", 2],
  ["exportCounts", (m) => m.notePasswordListShown(2000, 10), "takeExportCounts", "password_list_large_shows", 1],
  ["importRuns", (m) => m.noteSearchEngineOfferTaken(), "takeImportRuns", "import_search_engine_offers_taken", 1],
  ["importRuns", (m) => m.noteImportExtensionStorePages(2), "takeImportRuns", "import_extension_store_pages_opened", 2],
];

const read = (taken, field) => (field === null ? taken : field.split(".").reduce((value, key) => value[key], taken));

for (const [module, note, take, field, expected] of ROWS) {
  const call = String(note).replace(/^\(m\) => m\./, "");
  test(`${module}: ${call} counts only while sharing is on, and turning sharing off drops what it counted`, async () => {
    const m = await import(`./${module}.ts`);
    const counted = () => read(m[take](), field);

    sharing(false);
    m[take]();
    note(m);
    assert.equal(counted(), 0, "with sharing off the note counts nothing");

    sharing(true);
    m[take]();
    note(m);
    assert.equal(counted(), expected, "with sharing on the note counts");

    note(m);
    sharing(false);
    sharing(true);
    assert.equal(counted(), 0, "turning sharing off drops what was counted");
    sharing(false);
  });
}
