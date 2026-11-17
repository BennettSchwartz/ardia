import { hostCall, onEngineTopic } from "../engine/host";
import { expectEqual, expectTrue, type Check } from "./check";
import { LOAD_MS, SETTLE_MS, origin, port, restore, setAutoplay, withMedia } from "./engineAutoplayKit";
import { click, evaluate, firstWindow, LEFT, listed, pause, show, until } from "./engineSleep";

type NowPlaying = { title?: string; artist?: string; album?: string; artwork?: string | null; playbackState?: string; position?: number; duration?: number | null; playbackRate?: number; timestamp?: number; hasVideo?: boolean; actions?: string[]; controllable?: boolean; loop?: boolean };
type PageState = { paused?: boolean; time?: number; calls?: string[]; ad?: { active?: boolean } | null; frame?: { paused?: boolean; time?: number; calls?: string[] } | null };
type Image = { uri?: string | null; width?: number; height?: number };

const TITLE = "now playing page";
const FRAME_TITLE = "now playing frame";
const SONG = { title: "Ardia Song", artist: "Ardia Band", album: "Ardia Album" };
const PAGE_ACTIONS = ["play", "pause", "nexttrack", "previoustrack", "seekto"];
const DECLARED_DURATION = 120;
const SEEK_TO = 42;
const STEADY_MS = 10000;
const MOST_STEADY_REPORTS = 5;
const ART_PIXELS = 256;
const FRAME_BUTTON = { x: 100, y: 100 };
const PNG_DATA = "data:image/png;base64,";

function reportsOf(key: string) {
  const reports: (NowPlaying | null)[] = [];
  const watching = onEngineTopic("tab", (event: { key?: unknown; name?: unknown; data?: { state?: NowPlaying | null } }) => {
    if (event.key === key && event.name === "nowPlaying") reports.push(event.data?.state ?? null);
  });
  return { reports, latest: async () => (reports.length ? reports[reports.length - 1]! : undefined), stop: () => watching.remove() };
}

type Reports = ReturnType<typeof reportsOf>;

const command = (key: string, action: string, seconds: number | null = null) => hostCall("tab.call", { key, method: "mediaCommand", action, seconds });

const pageState = async (key: string) =>
  ((await evaluate(key, 'const media = typeof m === "undefined" ? null : m; post("result", JSON.stringify({ paused: media ? media.paused : null, time: media ? media.currentTime : null, calls: window.calls || [], ad: window.adState || null, frame: window.frameState || null }));')) ?? {}) as PageState;

const startPlaying = async (key: string) => {
  const started = await evaluate(key, 'm.play().then(() => "played", (error) => error.name).then((result) => post("result", JSON.stringify(result)));', true);
  expectEqual(started, "played", "the page plays with sound under a script gesture");
};

const reported = (reports: Reports, what: string, done: (state: NowPlaying | null | undefined) => boolean) => until(`${what} (nowPlaying)`, SETTLE_MS, reports.latest, done);
const isPlaying = (state: NowPlaying | null | undefined) => state?.playbackState === "playing";
const isPaused = (state: NowPlaying | null | undefined) => state?.playbackState === "paused";
const called = (key: string, call: string, what: string) => until(what, SETTLE_MS, () => pageState(key), (state) => !!state.calls?.includes(call));

async function withReports(name: string, path: string, title: string, run: (key: string, reports: Reports, windowId: string) => Promise<void>) {
  const reports = reportsOf(`self-check-autoplay-${name}`);
  try {
    await withMedia(name, path, title, (key, windowId) => run(key, reports, windowId));
  } finally {
    reports.stop();
  }
}

async function downloaded(key: string, url: string): Promise<Image | null> {
  return (await hostCall<Image>("tab.call", { key, method: "downloadImage", url, maxPixels: ART_PIXELS })) ?? null;
}

function expectPng(image: Image | null, what: string) {
  expectTrue(typeof image?.uri === "string" && image.uri.startsWith(PNG_DATA), `${what}: a PNG data URI, got ${JSON.stringify(image).slice(0, 120)}`);
  const width = image!.width ?? 0;
  const height = image!.height ?? 0;
  expectTrue(width > 0 && height > 0 && width <= ART_PIXELS && height <= ART_PIXELS, `${what}: within ${ART_PIXELS} px, got ${width}x${height}`);
}

async function playsAfterBlock(name: string, path: string) {
  try {
    await withReports(name, path, TITLE, async (key, reports) => {
      await until("the unrelated cross-site ad iframe reports", SETTLE_MS, () => pageState(key), (state) => state.ad?.active === false);
      await startPlaying(key);
      await reported(reports, "the page reports playing", isPlaying);
      await setAutoplay("block");
      await until("blocking autoplay pauses the media the user did not ask for", SETTLE_MS, () => pageState(key), (state) => state.paused === true);
      await reported(reports, "the paused media is reported paused", isPaused);
      await command(key, "play");
      await until("the card's play plays it on the blocked site", SETTLE_MS, () => pageState(key), (state) => state.paused === false && (state.time ?? 0) > 0);
      await reported(reports, "the page reports playing again", isPlaying);
      await pause(500);
      expectEqual((await pageState(key)).ad?.active, false, "the unrelated cross-site ad iframe's navigator.userActivation.hasBeenActive after the card's play");
    });
  } finally {
    await restore();
  }
}

const nowPlayingChecks: Check[] = [
  {
    name: "engine now playing: a playing page reports its Media Session metadata, playing, controllable and its actions, and its artwork downloads as a PNG",
    run: () =>
      withReports("np-report", "nowplaying", TITLE, async (key, reports) => {
        await startPlaying(key);
        const state = await reported(reports, "the page's session is reported playing with its declared duration and artwork", (now) => isPlaying(now) && now?.title === SONG.title && now?.duration === DECLARED_DURATION && !!now?.artwork);
        expectEqual({ title: state?.title, artist: state?.artist, album: state?.album }, SONG, "the reported metadata");
        expectEqual({ controllable: state?.controllable, hasVideo: state?.hasVideo, duration: state?.duration }, { controllable: true, hasVideo: false, duration: DECLARED_DURATION }, "controllable audio with the page's declared duration");
        expectEqual(PAGE_ACTIONS.filter((action) => !state?.actions?.includes(action)), [], `the page's action handlers among the actions ${JSON.stringify(state?.actions)}`);
        expectEqual(state?.artwork, `${origin}/art.png`, "the artwork is the largest declared size, as on the Mac");
        expectPng(await downloaded(key, state!.artwork!), "the 300 px PNG artwork, asked for at 256 px");
        expectPng(await downloaded(key, `${origin}/art.svg`), "the SVG artwork, rasterized in the page's renderer");
        expectEqual((await downloaded(key, "file:///C:/Windows/win.ini"))?.uri ?? null, null, "a file URL is not downloaded");
      }),
  },
  {
    name: "engine now playing: pause, play, next, previous and seek from the app reach the page's Media Session handlers",
    run: () =>
      withReports("np-commands", "nowplaying", TITLE, async (key, reports) => {
        await startPlaying(key);
        await reported(reports, "the page reports playing", isPlaying);
        await command(key, "pause");
        await called(key, "pause", "the page's pause handler runs");
        await until("the page pauses", SETTLE_MS, () => pageState(key), (state) => state.paused === true);
        await reported(reports, "the page reports paused", isPaused);
        await command(key, "play");
        await called(key, "play", "the page's play handler runs");
        await until("the page plays again", SETTLE_MS, () => pageState(key), (state) => state.paused === false);
        await reported(reports, "the page reports playing again", isPlaying);
        await command(key, "next");
        await called(key, "nexttrack", "the page's nexttrack handler runs");
        await command(key, "previous");
        await called(key, "previoustrack", "the page's previoustrack handler runs");
        await command(key, "seekTo", SEEK_TO);
        await called(key, `seekto:${SEEK_TO}`, "the page's seekto handler runs with the time asked for");
        await reported(reports, "the reported position moves to the seek", (now) => Math.abs((now?.position ?? 0) - SEEK_TO) < 3);
      }),
  },
  {
    name: "engine now playing: on a page without action handlers, pause, play and seekTo from the app reach its media through the session",
    run: () =>
      withReports("np-bare", "nowplaying?bare", TITLE, async (key, reports) => {
        await startPlaying(key);
        await reported(reports, "the page reports playing", isPlaying);
        await command(key, "pause");
        await until("the media pauses", SETTLE_MS, () => pageState(key), (state) => state.paused === true);
        await reported(reports, "the page reports paused", isPaused);
        await command(key, "seekTo", 1);
        await until("the media seeks", SETTLE_MS, () => pageState(key), (state) => Math.abs((state.time ?? -1) - 1) < 0.3);
        await command(key, "play");
        await until("the media plays again", SETTLE_MS, () => pageState(key), (state) => state.paused === false);
        expectEqual((await pageState(key)).calls?.filter((call) => !call.startsWith("play:")) ?? [], [], "no page handler was involved");
      }),
  },
  {
    name: "engine now playing: media in a cross-site iframe is reported and obeys play and pause from the app",
    run: () =>
      withReports("np-framed", "npframe", FRAME_TITLE, async (key, reports, windowId) => {
        await show(key, windowId, LEFT);
        await until("the cross-site iframe reports", SETTLE_MS, () => pageState(key), (state) => state.frame?.paused === true);
        await click(key, FRAME_BUTTON.x, FRAME_BUTTON.y);
        await until("a click in the iframe plays its media", SETTLE_MS, () => pageState(key), (state) => state.frame?.paused === false);
        const state = await reported(reports, "the iframe's session is reported playing", (now) => isPlaying(now) && now?.title === SONG.title);
        expectEqual(state?.controllable, true, "the iframe's media is controllable");
        await command(key, "pause");
        await until("the app's pause reaches the iframe's handler", SETTLE_MS, () => pageState(key), (now) => now.frame?.paused === true && !!now.frame.calls?.includes("pause"));
        await reported(reports, "the iframe reports paused", isPaused);
        await command(key, "play");
        await until("the app's play reaches the iframe's handler", SETTLE_MS, () => pageState(key), (now) => now.frame?.paused === false && !!now.frame.calls?.includes("play"));
        await reported(reports, "the iframe reports playing again", isPlaying);
      }),
  },
  {
    name: "engine now playing: the session ends when the page navigates away",
    run: () =>
      withReports("np-navigate", "nowplaying", TITLE, async (key, reports) => {
        await startPlaying(key);
        await reported(reports, "the page reports playing", isPlaying);
        await hostCall("tab.call", { key, method: "loadUrl", url: `${origin}/a` });
        await until("the next page loads", LOAD_MS, () => listed(key), (tab) => tab?.title === "loaded a");
        await reported(reports, "the session ends with the page", (now) => now === null);
      }),
  },
  {
    name: "engine now playing: the session ends when the tab closes",
    run: async () => {
      const key = "self-check-np-close";
      const reports = reportsOf(key);
      const windowId = await firstWindow();
      try {
        await hostCall("tab.create", { key, url: `${origin}/nowplaying`, profile: "" }, windowId);
        await until(`the page ${key} loads`, LOAD_MS, () => listed(key), (tab) => tab?.title === TITLE && tab.loading === false);
        await startPlaying(key);
        await reported(reports, "the page reports playing", isPlaying);
        await hostCall("tab.close", { key });
        await reported(reports, "the session ends with the tab", (now) => now === null);
      } finally {
        reports.stop();
        await hostCall("tab.close", { key }).catch(() => null);
      }
    },
  },
  {
    name: "engine now playing: on a blocked site, the card's play reaches the page's play handler, and an unrelated cross-site ad iframe gains no user activation",
    run: () => playsAfterBlock("np-blocked", "nowplaying?withad"),
  },
  {
    name: "engine now playing: on a blocked site, the card's play plays a page without action handlers, and an unrelated cross-site ad iframe gains no user activation",
    run: () => playsAfterBlock("np-blocked-bare", "nowplaying?withad&bare"),
  },
  {
    name: "engine now playing: steady playback of a looping track sends few reports and marks the loop",
    run: () =>
      withReports("np-steady", "nowplaying?plain", TITLE, async (key, reports) => {
        await startPlaying(key);
        await reported(reports, "the page reports playing", isPlaying);
        await pause(1000);
        const before = reports.reports.length;
        await pause(STEADY_MS);
        const sent = reports.reports.length - before;
        console.info(`[ardia windows] self-check note: ${sent} nowPlaying reports over ${STEADY_MS / 1000} s of steady looping playback`);
        expectTrue(sent <= MOST_STEADY_REPORTS, `at most ${MOST_STEADY_REPORTS} reports over ${STEADY_MS / 1000} s of steady playback, got ${sent}`);
        const last = await reports.latest();
        expectEqual({ playing: isPlaying(last), loop: last?.loop }, { playing: true, loop: true }, "the looping track is reported playing and looping");
      }),
  },
];

export const checks: Check[] = port ? nowPlayingChecks : [];
