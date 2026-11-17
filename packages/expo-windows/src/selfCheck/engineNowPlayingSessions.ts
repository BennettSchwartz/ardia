import { hostCall } from "../engine/host";
import { expectEqual, expectTrue, type Check } from "./check";
import { LOAD_MS, SETTLE_MS, origin, port, restore, setAutoplay } from "./engineAutoplayKit";
import { LEFT, evaluate, heard, hide, listed, pause, show, until } from "./engineSleep";
import { TITLE, activeSessionOf, commandReply, isPlaying, pausePage, reported, startPlaying, unaskedPlay, withReports, type Reports } from "./engineNowPlayingKit";

const ELEMENT_UNMUTES_AFTER_MS = 2000;
const FOCUS_SETTLES_MS = 1000;
const NOTHING_PLAYS_MS = 1500;
const NOT_DONE = { ok: true, done: false };
const BY_SCRIPT = { ok: true, done: true, byScript: true };
const RESUME_AT = 20;
const SEEK_ONLY_AT = 5;
const SEEK_SLACK = 1;

type Answer = { ok?: boolean; done?: boolean; byScript?: boolean; refused?: string };
type Media = { paused?: boolean; time?: number; played?: number };

const answerOf = async (key: string, action: string, seconds: number | null = null): Promise<Answer> => {
  const reply = await commandReply(key, action, seconds);
  if (reply.startsWith("refused")) return { refused: reply };
  const answer = JSON.parse(reply) as Answer;
  return { ok: answer.ok, done: answer.done, ...(answer.byScript === undefined ? {} : { byScript: answer.byScript }) };
};
type BothMedia = { m?: Media; n?: Media };
const bothOf = async (key: string) => ((await evaluate(key, 'const read = (e) => ({ paused: e.paused, time: e.currentTime, played: e.played.length }); post("result", JSON.stringify({ m: read(m), n: read(n) }));')) ?? {}) as BothMedia;
const mediaOf = async (key: string) => ((await evaluate(key, 'post("result", JSON.stringify({ paused: m.paused, time: m.currentTime, played: m.played.length }));')) ?? {}) as Media;
const setMuted = (key: string, muted: boolean) => hostCall("tab.call", { key, method: "setMuted", muted });
const loadedAt = (key: string, marker: string) => until(`the page with ${marker} loads`, LOAD_MS, () => listed(key), (tab) => String(tab?.url).includes(marker) && tab?.title === TITLE && tab.loading === false && tab.discarded !== true);

async function neverPlayed(key: string, what: string) {
  await pause(NOTHING_PLAYS_MS);
  const media = await mediaOf(key);
  expectEqual({ paused: media.paused, played: media.played }, { paused: true, played: 0 }, `${what}: the page's idle player never played (${JSON.stringify(media)})`);
}

async function discardedAndReloaded(key: string, windowId: string, method = "reloadToPlay") {
  await hide(key, windowId);
  const outcome = (await hostCall<{ outcome?: unknown }>("tab.call", { key, method: "discard" })).outcome;
  expectEqual(outcome, "discarded", "the hidden page is discarded");
  await hostCall("tab.call", { key, method });
  await loadedAt(key, "wake");
}

async function onlyNullAfter(reports: Reports, from: number, what: string) {
  await pause(NOTHING_PLAYS_MS);
  const after = reports.reports.slice(from);
  expectEqual(after.filter((state) => state !== null).length, 0, `${what}: nothing of the page navigated away from is reported (${JSON.stringify(after.map((state) => state?.playbackState ?? null))})`);
}

const sessionChecks: Check[] = [
  {
    name: "engine now playing: a muted tab never takes the hardware media keys or the system media controls from a tab that is heard, even when focused, and is eligible again once unmuted",
    run: () =>
      withReports("np-keys-heard", "nowplaying?plain&long", TITLE, (heard, heardReports) =>
        withReports("np-keys-muted", "nowplaying?plain&long", TITLE, async (muted, mutedReports) => {
          await startPlaying(heard);
          await reported(heardReports, "the heard tab reports playing", isPlaying);
          await startPlaying(muted);
          await reported(mutedReports, "the second tab reports playing", isPlaying);
          const bothHeard = { heard: await activeSessionOf(heard), muted: await activeSessionOf(muted) };
          await setMuted(muted, true);
          await until("the heard tab's session is the active one once the other tab is muted", SETTLE_MS, () => activeSessionOf(heard), (state) => state.active === true);
          expectEqual((await activeSessionOf(muted)).active, false, "the muted tab's session is not the active one");
          const mutedCard = await mutedReports.latest();
          expectTrue(isPlaying(mutedCard) && mutedCard?.controllable === true, `the muted tab's card still reports its session, playing and controllable (${JSON.stringify(mutedCard)})`);
          const mayMove = (await hostCall<{ keyboardMayMove?: unknown }>("host.info")).keyboardMayMove === true;
          await hostCall("tab.call", { key: muted, method: "focus", ...(mayMove ? {} : { background: true }) });
          await pause(FOCUS_SETTLES_MS);
          const focused = await hostCall<{ keyboardPage?: unknown }>("host.info");
          expectEqual({ heard: (await activeSessionOf(heard)).active, muted: (await activeSessionOf(muted)).active }, { heard: true, muted: false }, "after the muted tab's page is focused, the heard tab's session is still the active one");
          await setMuted(muted, false);
          await until("the unmuted tab, on top of the focus stack, is the active session again", SETTLE_MS, () => activeSessionOf(muted), (state) => state.active === true);
          console.info(`[ardia windows] self-check note: active session with both heard ${JSON.stringify(bothHeard)}; the focus call ${mayMove ? "could" : "could not"} move the keyboard, keyboard page after it ${JSON.stringify(focused.keyboardPage ?? null)}; once unmuted, the unmuted tab is the active session`);
        }),
      ),
  },
  {
    name: "engine now playing: a page that starts its track muted on the element and unmutes it while playing gets its card",
    run: () =>
      withReports("np-element-muted", "nowplaying?plain&long", TITLE, async (key, reports) => {
        const started = await evaluate(key, 'm.muted = true; m.play().then(() => "played", (error) => error.name).then((result) => post("result", JSON.stringify(result)));', true);
        expectEqual(started, "played", "the page plays its track muted on the element");
        await pause(ELEMENT_UNMUTES_AFTER_MS);
        const whileMuted = reports.reports.filter((state) => state?.controllable === true).length;
        await evaluate(key, 'm.muted = false; post("result", "true");');
        const state = await reported(reports, "the unmuted track is reported playing and controllable", (now) => isPlaying(now) && now?.controllable === true);
        console.info(`[ardia windows] self-check note: ${whileMuted} controllable reports while the element was muted; after unmuting ${JSON.stringify({ playbackState: state?.playbackState, duration: state?.duration })}`);
      }),
  },
  {
    name: "engine now playing: a card play sent right after navigating to a page with an idle player and no session does nothing, no script plays the player, and the page navigated away from is not reported",
    run: () =>
      withReports("np-nav-play", "nowplaying?long", TITLE, async (key, reports) => {
        await startPlaying(key);
        await reported(reports, "the page reports playing", isPlaying);
        const committed = heard("tab", (event) => event.key === key && event.name === "navigation" && String(event.data?.committedUrl).includes("next"), "the next page commits");
        await hostCall("tab.call", { key, method: "loadUrl", url: `${origin}/nowplaying?plain&long&next` });
        await committed;
        const early = await answerOf(key, "play");
        expectEqual(early, NOT_DONE, "a card play sent as soon as the next page committed, before any session lives there");
        await loadedAt(key, "next");
        const from = reports.reports.length;
        expectEqual(await answerOf(key, "play"), NOT_DONE, "a card play once the next page loaded, with no session there");
        await neverPlayed(key, "after the card's plays");
        await onlyNullAfter(reports, from, "after the next page loaded");
        await hostCall("tab.call", { key, method: "reload" });
        await loadedAt(key, "next");
        expectEqual(await answerOf(key, "play"), NOT_DONE, "a card play after an ordinary reload of a tab that was never asleep");
        await neverPlayed(key, "after the reload");
      }),
  },
  {
    name: "engine now playing: a sleeping tab woken to play (reloadToPlay) plays once through the wake allowance, and a second play with no session does nothing",
    run: () =>
      withReports("np-wake", "nowplaying?plain&long&wake", TITLE, async (key, reports, windowId) => {
        await discardedAndReloaded(key, windowId);
        expectEqual(await answerOf(key, "play"), BY_SCRIPT, "the first play after the wake");
        await until("the woken page's player plays", SETTLE_MS, () => mediaOf(key), (media) => media.paused === false);
        await reported(reports, "the woken page reports playing", isPlaying);
        await evaluate(key, 'm.pause(); m.removeAttribute("src"); m.load(); post("result", "true");');
        await reported(reports, "the session ends once the page drops its media", (now) => now === null);
        expectEqual(await answerOf(key, "play"), NOT_DONE, "a second play, with no session and the allowance used");
      }),
  },
  {
    name: "engine now playing: a sleeping tab woken to play that then navigates loses the wake allowance",
    run: () =>
      withReports("np-wake-moved", "nowplaying?plain&long&wake", TITLE, async (key, reports, windowId) => {
        await discardedAndReloaded(key, windowId);
        await hostCall("tab.call", { key, method: "loadUrl", url: `${origin}/nowplaying?plain&long&moved` });
        await loadedAt(key, "moved");
        expectEqual(await answerOf(key, "play"), NOT_DONE, "a play after the woken page navigated");
        await neverPlayed(key, "after the woken page navigated");
        expectEqual((await reports.latest()) ?? null, null, "no session is reported for the moved page");
      }),
  },
  {
    name: "engine now playing: a sleeping tab woken to play resumes where it was: one seek, then the play, through the wake allowance, and a second seek does nothing",
    run: () =>
      withReports("np-wake-seek", "nowplaying?plain&long&wake", TITLE, async (key, reports, windowId) => {
        await discardedAndReloaded(key, windowId);
        expectEqual(await answerOf(key, "seekTo", RESUME_AT), BY_SCRIPT, "the resume seek after the wake");
        expectEqual(await answerOf(key, "seekTo", 5), NOT_DONE, "a second seek before the play");
        expectEqual(await answerOf(key, "play"), BY_SCRIPT, "the play after the resume seek");
        const media = await until("the woken page plays from where it was", SETTLE_MS, () => mediaOf(key), (now) => now.paused === false && (now.time ?? 0) >= RESUME_AT);
        await reported(reports, "the woken page reports playing", isPlaying);
        expectEqual(await answerOf(key, "seekTo", 1), NOT_DONE, "a seek after the play, with the allowance used and no session");
        console.info(`[ardia windows] self-check note: a woken tab resumed at ${media.time} s after a seek to ${RESUME_AT} s`);
      }),
  },
  {
    name: "engine now playing: a sleeping tab reloaded by the user (a plain reload) gets no wake allowance",
    run: () =>
      withReports("np-wake-plain", "nowplaying?plain&long&wake", TITLE, async (key, _reports, windowId) => {
        await discardedAndReloaded(key, windowId, "reload");
        expectEqual(await answerOf(key, "seekTo", RESUME_AT), NOT_DONE, "a seek after the user's own reload");
        expectEqual(await answerOf(key, "play"), NOT_DONE, "a play after the user's own reload");
        await neverPlayed(key, "after the user's own reload");
      }),
  },
  {
    name: "engine now playing: a wake whose reload a navigation replaces before it commits leaves no allowance for the page that loads instead",
    run: () =>
      withReports("np-wake-replaced", "nowplaying?plain&long&wake", TITLE, async (key, _reports, windowId) => {
        await hide(key, windowId);
        expectEqual((await hostCall<{ outcome?: unknown }>("tab.call", { key, method: "discard" })).outcome, "discarded", "the hidden page is discarded");
        await hostCall("tab.call", { key, method: "reloadToPlay" });
        await hostCall("tab.call", { key, method: "loadUrl", url: `${origin}/nowplaying?plain&long&replaced` });
        await loadedAt(key, "replaced");
        expectEqual(await answerOf(key, "play"), NOT_DONE, "a play on the page that replaced the wake's reload");
        await neverPlayed(key, "on the page that replaced the wake's reload");
      }),
  },
  {
    name: "engine now playing: after a wake, a play the page's live session takes uses the allowance up, so a later play with no session does nothing",
    run: () =>
      withReports("np-wake-session", "nowplaying?plain&long&wake", TITLE, async (key, reports, windowId) => {
        await discardedAndReloaded(key, windowId);
        await startPlaying(key);
        await reported(reports, "the woken page plays by itself and reports it", isPlaying);
        await pausePage(key);
        expectEqual(await answerOf(key, "play"), { ok: true, done: true }, "a card play the live session takes, not the script");
        await until("the session's play plays the page", SETTLE_MS, () => mediaOf(key), (media) => media.paused === false);
        await evaluate(key, 'm.pause(); m.removeAttribute("src"); m.load(); post("result", "true");');
        await reported(reports, "the session ends once the page drops its media", (now) => now === null);
        expectEqual(await answerOf(key, "play"), NOT_DONE, "a later play with no session, the allowance already used by the session's play");
      }),
  },
  {
    name: "engine now playing: the wake's seek and play reach the same element, even when another starts playing in between",
    run: () =>
      withReports("np-wake-same", "nowplaying?plain&long&second&wake", TITLE, async (key, _reports, windowId) => {
        await discardedAndReloaded(key, windowId);
        expectEqual(await answerOf(key, "seekTo", RESUME_AT), BY_SCRIPT, "the resume seek after the wake");
        await until("the seek lands on the first player", SETTLE_MS, () => bothOf(key), (both) => Math.abs((both.m?.time ?? -1) - RESUME_AT) < SEEK_SLACK);
        expectEqual(await evaluate(key, 'n.muted = true; n.play().then(() => "played", (error) => error.name).then((result) => post("result", JSON.stringify(result)));', true), "played", "the other player starts playing, muted, so a fresh choice would pick it");
        expectEqual(await answerOf(key, "play"), BY_SCRIPT, "the play after the resume seek");
        const both = await until("the player the seek chose plays", SETTLE_MS, () => bothOf(key), (now) => now.m?.paused === false);
        console.info(`[ardia windows] self-check note: after the wake's seek and play, the chosen player ${JSON.stringify(both.m)}, the other ${JSON.stringify(both.n)}`);
        expectTrue((both.m?.time ?? 0) >= RESUME_AT && (both.n?.time ?? Infinity) < RESUME_AT, `the seek and the play both reached the first player and not the other (${JSON.stringify(both)})`);
      }),
  },
  {
    name: "engine now playing: the wake's seek alone does not make the page count as asked on a site that blocks autoplay",
    run: async () => {
      try {
        await setAutoplay("block");
        await withReports("np-wake-seek-unasked", "nowplaying?plain&long&wake", TITLE, async (key, _reports, windowId) => {
          await discardedAndReloaded(key, windowId);
          expectEqual(await answerOf(key, "seekTo", SEEK_ONLY_AT), BY_SCRIPT, "the resume seek after the wake");
          await until("the seek lands", SETTLE_MS, () => mediaOf(key), (media) => Math.abs((media.time ?? -1) - SEEK_ONLY_AT) < SEEK_SLACK);
          await show(key, windowId, LEFT);
          expectEqual(await unaskedPlay(key), "NotAllowedError", "a play() the page makes itself after the wake's seek, on a site that blocks autoplay");
        });
      } finally {
        await restore();
      }
    },
  },
];

export const checks: Check[] = port ? sessionChecks : [];
