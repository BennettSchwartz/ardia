import { hostCall } from "../engine/host";
import { expectEqual, expectTrue, type Check } from "./check";
import { SETTLE_MS, port } from "./engineAutoplayKit";
import { evaluate, pause, until } from "./engineSleep";
import { FRAME_TITLE, TITLE, command, downloaded, expectPng, isPlaying, pageState, playFrame, reported, startPlaying, withReports } from "./engineNowPlayingKit";

const FLAP_MS = 5000;
const MOST_FLAP_REPORTS = 15;
const ROTATIONS = 10;
const MOST_ROTATION_DOWNLOADS = 2;
const DOWNLOADS_SETTLE_MS = 1500;
const LONGEST_REPORTED_ARTWORK = 2048;

const mute = (key: string, muted: boolean) => hostCall("tab.call", { key, method: "setMuted", muted });
const artHits = async (key: string, reset = false) => Number(await evaluate(key, `fetch("/art-hits${reset ? "?reset" : ""}", { cache: "no-store" }).then((r) => r.text()).then((t) => post("result", JSON.stringify(Number(t))));`));

const heldChecks: Check[] = [
  {
    name: "engine now playing: in a muted tab, the card's pause and play reach a cross-site iframe's song, and an idle element of the page around it never plays",
    run: () =>
      withReports("np-preload", "npframe?preload", FRAME_TITLE, async (key, reports, windowId) => {
        await playFrame(key, windowId);
        await reported(reports, "the iframe's song is reported playing and controllable", (now) => isPlaying(now) && now?.controllable === true);
        await mute(key, true);
        await pause(500);
        await command(key, "pause");
        await until("the card's pause pauses the iframe's song in the muted tab", SETTLE_MS, () => pageState(key), (state) => state.frame?.paused === true);
        await command(key, "play");
        await until("the card's play resumes the iframe's song in the muted tab", SETTLE_MS, () => pageState(key), (state) => state.frame?.paused === false);
        const main = await pageState(key);
        expectEqual({ paused: main.paused, time: main.time }, { paused: true, time: 0 }, "the page's idle preloaded <audio> never played");
        expectEqual((await reports.latest())?.controllable, true, "the held card stays controllable");
      }),
  },
  {
    name: "engine now playing: in a muted tab, the card goes when the player it stands for is gone, though another player that played stays",
    run: () =>
      withReports("np-represented", "nowplaying?second&long", TITLE, async (key, reports) => {
        expectEqual(await evaluate(key, 'n.play().then(() => "played", (error) => error.name).then((result) => post("result", JSON.stringify(result)));', true), "played", "the other element plays with sound first");
        await pause(500);
        await evaluate(key, 'n.pause(); post("result", "true");');
        await startPlaying(key);
        await reported(reports, "the song is reported playing", isPlaying);
        await mute(key, true);
        await pause(500);
        await evaluate(key, 'm.removeAttribute("src"); m.load(); post("result", "true");');
        await reported(reports, "the card goes once the song's player is gone", (now) => now === null);
      }),
  },
  {
    name: "engine now playing: a page flapping pause and play 200 times in a second sends about ten reports, the last with its true state",
    run: () =>
      withReports("np-flap", "nowplaying?long", TITLE, async (key, reports) => {
        await startPlaying(key);
        await reported(reports, "the page reports playing", isPlaying);
        await pause(500);
        const before = reports.reports.length;
        await evaluate(key, 'flap(); post("result", "true");');
        await until("the page finishes flapping", FLAP_MS, () => evaluate(key, 'post("result", JSON.stringify(window.flapDone));'), (done) => done === true);
        await pause(500);
        const sent = reports.reports.length - before;
        console.info(`[ardia windows] self-check note: ${sent} nowPlaying reports for 200 pause and play changes in a second`);
        expectTrue(sent <= MOST_FLAP_REPORTS, `at most ${MOST_FLAP_REPORTS} reports for the flapping, got ${sent}`);
        const state = await pageState(key);
        expectEqual({ paused: state.paused, reported: (await reports.latest())?.playbackState }, { paused: false, reported: "playing" }, "the page ends playing and the last report says so");
      }),
  },
  {
    name: "engine now playing: artwork rotated ten times quickly starts at most two downloads",
    run: () =>
      withReports("np-rotate", "nowplaying?long", TITLE, async (key, reports) => {
        await startPlaying(key);
        await reported(reports, "the page reports playing", isPlaying);
        await artHits(key, true);
        for (let i = 0; i < ROTATIONS; i++) {
          await evaluate(key, `rotate(${i}); post("result", "true");`);
          const state = await reported(reports, `the artwork ${i} is reported`, (now) => !!now?.artwork?.endsWith(`/art-hold.png?r=${i}`));
          void downloaded(key, state!.artwork!).catch(() => null);
        }
        await pause(DOWNLOADS_SETTLE_MS);
        const hits = await artHits(key);
        console.info(`[ardia windows] self-check note: ${hits} artwork downloads started for ${ROTATIONS} rotations`);
        expectTrue(hits <= MOST_ROTATION_DOWNLOADS, `at most ${MOST_ROTATION_DOWNLOADS} artwork downloads for ${ROTATIONS} quick rotations, got ${hits}`);
      }),
  },
  {
    name: "engine now playing: a route change while the artwork downloads does not deliver the old frame's image",
    run: () =>
      withReports("np-route", "npframe?preload&slowart", FRAME_TITLE, async (key, reports, windowId) => {
        await playFrame(key, windowId);
        const state = await reported(reports, "the iframe's song is reported with its slow artwork", (now) => isPlaying(now) && !!now?.artwork?.endsWith("/art-slow.png"));
        const fetching = downloaded(key, state!.artwork!);
        await pause(200);
        const started = await evaluate(key, `mainSession(${JSON.stringify(state!.artwork)}).then((result) => post("result", JSON.stringify(result)));`, true);
        expectEqual(started, "played", "the page around the iframe plays its own song with the same artwork address, taking the route");
        expectEqual((await fetching)?.uri ?? null, null, "the old frame's artwork, finished after the route moved to the page around it");
      }),
  },
  {
    name: "engine now playing: a long artwork address is reported as a short token that downloads the image",
    run: () =>
      withReports("np-long-art", "nowplaying?longart", TITLE, async (key, reports) => {
        await startPlaying(key);
        const state = await reported(reports, "the page reports playing with its artwork", (now) => isPlaying(now) && !!now?.artwork);
        expectTrue(state!.artwork!.length <= LONGEST_REPORTED_ARTWORK, `the reported artwork is at most ${LONGEST_REPORTED_ARTWORK} characters, got ${state!.artwork!.length}`);
        expectPng(await downloaded(key, state!.artwork!), "the image the reported token downloads");
      }),
  },
];

export const checks: Check[] = port ? heldChecks : [];
