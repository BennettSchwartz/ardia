import { hostCall } from "../engine/host";
import { expectEqual, expectTrue, type Check } from "./check";
import { LOAD_MS, SETTLE_MS, port } from "./engineAutoplayKit";
import { evaluate, listed, pause, until } from "./engineSleep";
import { FRAME_TITLE, TITLE, downloaded, expectPng, isPlaying, playFrame, reported, startPlaying, withReports, type Image } from "./engineNowPlayingKit";

const ROTATIONS = 10;
const DOWNLOADS_SETTLE_MS = 15000;
const LONGEST_REPORTED_ARTWORK = 2048;
const BROWSER_FETCH = "none";

const artHits = async (key: string, reset = false) => Number(await evaluate(key, `fetch("/art-hits${reset ? "?reset" : ""}", { cache: "no-store" }).then((r) => r.text()).then((t) => post("result", JSON.stringify(Number(t))));`));

type ArtRequest = { site: string; cookie: string };

async function artRequests(key: string): Promise<ArtRequest[]> {
  const seen = await evaluate(key, 'fetch("/art-cookies?reset", { cache: "no-store" }).then((r) => r.text()).then((t) => post("result", JSON.stringify(t)));');
  if (typeof seen !== "string") throw new Error(`the page server's record of artwork requests could not be read (${JSON.stringify(seen)})`);
  return seen
    .split("|")
    .filter(Boolean)
    .map((entry) => {
      const space = entry.indexOf(" ");
      return { site: entry.slice(0, space), cookie: entry.slice(space + 1) };
    });
}

async function setCookies(key: string, windowId: string) {
  for (const host of ["127.0.0.1", "localhost"]) {
    const page = `self-check-np-cookie-${host}`;
    try {
      await hostCall("tab.create", { key: page, url: `http://${host}:${port}/set-cookie`, profile: "" }, windowId);
      await until(`the cookie page on ${host} loads`, LOAD_MS, () => listed(page), (tab) => tab?.title === "cookie set" && tab.loading === false);
      await evaluate(page, 'fetch("/art-cookie.png", { cache: "no-store" }).then(() => post("result", "true"), () => post("result", "false"));');
    } finally {
      await hostCall("tab.close", { key: page }).catch(() => null);
    }
  }
  const firstParty = await artRequests(key);
  expectTrue(firstParty.length === 2 && firstParty.every((request) => request.cookie.includes("np")), `each host now has a cookie its own pages send with a request for the artwork (${JSON.stringify(firstParty)})`);
}

function sentNoCookie(requests: ArtRequest[], what: string) {
  const browser = requests.filter((request) => request.site === BROWSER_FETCH);
  console.info(`[ardia windows] self-check note: artwork requests for ${what}: ${JSON.stringify(requests)}`);
  expectTrue(browser.length > 0 && browser.every((request) => request.cookie === "none"), `${what}: the browser's own artwork fetch (Sec-Fetch-Site: none) arrives, with no Cookie header (${JSON.stringify(requests)})`);
}

const artworkChecks: Check[] = [
  {
    name: "engine now playing: artwork, from the page and from a cross-site iframe, is fetched by the browser with no Cookie header",
    run: async () => {
      await withReports("np-cookie-main", "nowplaying?cookieart", TITLE, async (key, reports, windowId) => {
        await setCookies(key, windowId);
        await startPlaying(key);
        const state = await reported(reports, "the page reports its cookie artwork", (now) => isPlaying(now) && !!now?.artwork?.endsWith("/art-cookie.png"));
        expectPng(await downloaded(key, state!.artwork!), "the page's artwork");
        sentNoCookie(await artRequests(key), "the page's artwork");
      });
      await withReports("np-cookie-frame", "npframe?cookieart", FRAME_TITLE, async (key, reports, windowId) => {
        await artRequests(key);
        await playFrame(key, windowId);
        const state = await reported(reports, "the iframe reports its cookie artwork", (now) => isPlaying(now) && !!now?.artwork?.endsWith("/art-cookie.png"));
        expectPng(await downloaded(key, state!.artwork!), "the cross-site iframe's artwork");
        sentNoCookie(await artRequests(key), "the cross-site iframe's artwork");
      });
    },
  },
  {
    name: "engine now playing: an artwork image over 2 MiB is refused",
    run: () =>
      withReports("np-big-art", "nowplaying?bigart", TITLE, async (key, reports) => {
        await startPlaying(key);
        const state = await reported(reports, "the page reports its large artwork", (now) => isPlaying(now) && !!now?.artwork?.endsWith("/art-big.png"));
        expectEqual((await downloaded(key, state!.artwork!))?.uri ?? null, null, "a valid 3 MiB PNG, over the 2 MiB cap");
      }),
  },
  {
    name: "engine now playing: artwork rotated ten times quickly completes downloads, and the newest artwork is the one that arrives",
    run: () =>
      withReports("np-rotate", "nowplaying?long", TITLE, async (key, reports) => {
        await startPlaying(key);
        await reported(reports, "the page reports playing", isPlaying);
        await artHits(key, true);
        const answers: Promise<Image | null>[] = [];
        for (let i = 0; i < ROTATIONS; i++) {
          await evaluate(key, `rotate(${i}); post("result", "true");`);
          const state = await reported(reports, `the artwork ${i} is reported`, (now) => !!now?.artwork?.endsWith(`/art-wait.png?r=${i}`));
          answers.push(downloaded(key, state!.artwork!).catch(() => null));
        }
        const images = await Promise.race([Promise.all(answers), pause(DOWNLOADS_SETTLE_MS).then(() => null)]);
        expectTrue(images !== null, `every download asked for answers within ${DOWNLOADS_SETTLE_MS} ms`);
        const hits = await artHits(key);
        console.info(`[ardia windows] self-check note: ${hits} artwork downloads completed for ${ROTATIONS} rotations`);
        expectPng(images![ROTATIONS - 1]!, "the newest artwork");
        expectEqual(images!.slice(0, -1).filter((image) => image?.uri).length, 0, "no earlier artwork arrives once it was replaced");
        expectTrue(hits >= 1 && hits < ROTATIONS, `downloads completed (${hits}), and fewer than one per rotation`);
      }),
  },
  {
    name: "engine now playing: a route change to a frame declaring the same artwork still shows it",
    run: () =>
      withReports("np-route", "npframe?preload&slowart", FRAME_TITLE, async (key, reports, windowId) => {
        await playFrame(key, windowId);
        const state = await reported(reports, "the iframe's song is reported with its slow artwork", (now) => isPlaying(now) && !!now?.artwork?.endsWith("/art-slow.png"));
        const fetching = downloaded(key, state!.artwork!);
        await pause(200);
        const started = await evaluate(key, `mainSession(${JSON.stringify(state!.artwork)}).then((result) => post("result", JSON.stringify(result)));`, true);
        expectEqual(started, "played", "the page around the iframe plays its own song with the same artwork address, taking the route");
        await until("the route moves to the page around the iframe", SETTLE_MS, reports.latest, (now) => now?.title === "Main Song");
        expectPng(await fetching, "the artwork, still declared after the route moved");
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

export const checks: Check[] = port ? artworkChecks : [];
