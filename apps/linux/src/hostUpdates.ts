import type { UpdateChannel, UpdaterState } from "../../../packages/shell/src/updater";
import type { ArdiaHost } from "./host";
import { hostSupports, invokeHost } from "./host.ts";
import { SELF_UPDATE_METHODS } from "./hostCapabilities.ts";
import { hostLaunchConfig } from "./hostLaunchConfig.ts";
import { channelOf, compareVersions, isAppVersion, linuxReleases, newestRelease, type Release } from "./updateReleases.ts";
import {
  noteUpdateCheck,
  noteUpdateDownloadFailed,
  noteUpdateDownloadFinished,
  noteUpdateDownloadStarted,
  noteUpdateInstallFailed,
  noteUpdateInstalled,
  noteUpdatePageOpened,
  noteUpdateRestart,
  type UpdateInstallKind,
} from "../../browser/src/state/telemetry/updateCounts.ts";
import { consentToken, type ConsentToken } from "../../browser/src/state/telemetry/consentPeriod";

export const UPDATE_METHODS = ["updaterState", "checkForUpdates", "setAutomaticUpdateChecks", "setAutomaticUpdateDownloads", "setUpdateChannel"] as const;
export const RELEASES_METHOD = "ArdiaUpdates.releases";
export const [INSTALL_KIND_METHOD, DOWNLOAD_METHOD, INSTALL_METHOD, RESTART_METHOD] = SELF_UPDATE_METHODS;
export const KILL_SWITCHES_METHOD = "ArdiaShell.fetchKillSwitches";
export const UPDATE_PREFERENCES = "linux-updates.json";
export const RELEASES_PAGE = "https://github.com/ardia-browser/ardia/releases";
export const FIRST_CHECK_AFTER_MS = 30_000;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
export const UPDATE_CHECK_LOCK = "ardia.linux.update-checks";
export const UPDATE_INSTALL_LOCK = "ardia.linux.update-install";
export const UPDATE_WORK_STALE_MS = 30 * 60 * 1000;
export const AUR_UPDATE_COMMAND = "yay -Syu ardia-bin";

export type InstallKind = UpdateInstallKind | "managed" | "unsupported";
type Work = { version: string; phase: "downloading" | "installing"; at: number };
type Preferences = {
  automaticChecks: boolean;
  automaticDownloads: boolean;
  lastCheck: number | null;
  channel: UpdateChannel | null;
  notified: string | null;
  installed: string | null;
  failed: string | null;
  work: Work | null;
};
type Fetched = { status: number; body: string };
type SwitchCheck = NonNullable<Extract<UpdaterState, { available: true }>["switchCheck"]>;
type Outcome = { ok: true } | { ok: false; reason: unknown };
type FallbackFrom = "asked" | "automatic" | "accepted";

export type UpdateLocks = {
  request(name: string, options: { ifAvailable: true }, callback: (lock: unknown) => Promise<unknown>): Promise<unknown>;
};

export type UpdateDeps = {
  host: ArdiaHost;
  appVersion: () => string | null;
  read: (name: string) => string | null;
  write: (name: string, contents: string) => unknown;
  refresh?: (name: string) => Promise<unknown>;
  ask: (release: Release, current: string, failed: boolean) => Promise<boolean>;
  tell: (title: string, message: string) => Promise<void>;
  offer: (release: Release, failed: boolean) => void;
  offerInstall: (release: Release, install: () => void) => void;
  ready: (version: string, restart: () => void) => void;
  managed: (release: Release, current: string, asked: boolean) => Promise<void>;
  open: (url: string) => void;
  locks?: UpdateLocks;
  now?: () => number;
};

const DEFAULTS: Preferences = { automaticChecks: true, automaticDownloads: true, lastCheck: null, channel: null, notified: null, installed: null, failed: null, work: null };
const INSTALLABLE: ReadonlySet<string> = new Set<UpdateInstallKind>(["deb", "tarball", "appimage"]);

export const installs = (kind: InstallKind | null | undefined): kind is UpdateInstallKind => !!kind && INSTALLABLE.has(kind);

export function readInstallKind(line: unknown): InstallKind {
  return line === "managed" || (typeof line === "string" && INSTALLABLE.has(line)) ? (line as InstallKind) : "unsupported";
}

const knownKinds = new WeakMap<ArdiaHost, InstallKind>();
export const installsUpdates = (host: ArdiaHost | undefined) => !!host && installs(knownKinds.get(host));
export const selfUpdateAvailable = (host: ArdiaHost) => SELF_UPDATE_METHODS.every((method) => hostSupports(method, host));

function readWork(work: unknown): Work | null {
  if (!work || typeof work !== "object") return null;
  const { version, phase, at } = work as Partial<Work>;
  return isAppVersion(version) && (phase === "downloading" || phase === "installing") && typeof at === "number" ? { version, phase, at } : null;
}

function readPreferences(read: UpdateDeps["read"]): Preferences {
  try {
    const saved = JSON.parse(read(UPDATE_PREFERENCES) ?? "null") as Partial<Preferences> | null;
    if (!saved || typeof saved !== "object") return { ...DEFAULTS };
    return {
      automaticChecks: typeof saved.automaticChecks === "boolean" ? saved.automaticChecks : true,
      automaticDownloads: typeof saved.automaticDownloads === "boolean" ? saved.automaticDownloads : true,
      lastCheck: typeof saved.lastCheck === "number" ? saved.lastCheck : null,
      channel: saved.channel === "stable" || saved.channel === "nightly" ? saved.channel : null,
      notified: typeof saved.notified === "string" ? saved.notified : null,
      installed: isAppVersion(saved.installed) ? saved.installed : null,
      failed: isAppVersion(saved.failed) ? saved.failed : null,
      work: readWork(saved.work),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

const succeeded = (answer: unknown): Outcome => {
  if (answer && typeof answer === "object" && (answer as { ok?: unknown }).ok === true) return { ok: true };
  const reason = answer && typeof answer === "object" ? (answer as { reason?: unknown }).reason : undefined;
  return { ok: false, reason: typeof reason === "string" ? reason : "other" };
};

export function readyToRestart(saved: Pick<Preferences, "installed">, current: string | null): string | null {
  return saved.installed && current && compareVersions(saved.installed, current) > 0 ? saved.installed : null;
}

export const readyToRestartIn = (read: UpdateDeps["read"], current: string | null) => readyToRestart(readPreferences(read), isAppVersion(current) ? current : null);

export function linuxUpdater(deps: UpdateDeps) {
  const now = deps.now ?? Date.now;
  let checking = false;
  let switchCheck: SwitchCheck | null = null;
  let readyShown: string | null = null;
  let kindLookup: Promise<InstallKind | null> | null = null;
  let saving: Promise<unknown> = Promise.resolve();
  let downloadStarts: (() => void) | null = null;
  const preferences = async () => {
    await deps.refresh?.(UPDATE_PREFERENCES).catch(() => {});
    return readPreferences(deps.read);
  };
  const remember = (patch: Partial<Preferences>): Promise<void> => {
    const saved = saving.then(async () => {
      await deps.write(UPDATE_PREFERENCES, JSON.stringify({ ...(await preferences()), ...patch }));
    });
    saving = saved.catch(() => {});
    return saved;
  };
  const version = () => {
    const current = deps.appVersion();
    return isAppVersion(current) ? current : null;
  };
  const channel = (saved: Preferences, current: string | null): UpdateChannel => saved.channel ?? (current ? channelOf(current) : "stable");
  const workUnderWay = (saved: Preferences, current: string | null) =>
    saved.work && now() - saved.work.at < UPDATE_WORK_STALE_MS && (!current || compareVersions(saved.work.version, current) > 0) ? saved.work : null;

  const installKind = (): Promise<InstallKind | null> =>
    (kindLookup ??= !selfUpdateAvailable(deps.host)
      ? Promise.resolve(null)
      : invokeHost<unknown>(INSTALL_KIND_METHOD, { args: [] }, deps.host).then(
          (line) => {
            const kind = readInstallKind(line);
            if (!installs(kind)) console.info(`[ardia linux] Ardia doesn't update itself here: ${typeof line === "string" ? line : "no answer"}`);
            knownKinds.set(deps.host, kind);
            return kind;
          },
          (error: unknown) => {
            console.info(`[ardia linux] Ardia couldn't tell how it was installed: ${String(error)}`);
            knownKinds.set(deps.host, "unsupported");
            return "unsupported" as const;
          },
        ));

  async function restart(consent: ConsentToken | null) {
    noteUpdateRestart(consent);
    await invokeHost(RESTART_METHOD, { args: [] }, deps.host).catch((error: unknown) => console.info(`[ardia linux] Ardia couldn't restart: ${String(error)}`));
  }
  const restartToUpdate = () => void restart(consentToken());

  const showReady = (wanted: UpdateChannel, ready: string, again: boolean) => {
    switchCheck = { phase: "ready", channel: wanted, version: ready };
    if (readyShown === ready && !again) return;
    readyShown = ready;
    deps.ready(ready, restartToUpdate);
  };

  async function newest(wanted: UpdateChannel): Promise<Release | null> {
    const fetched = await invokeHost<Fetched>(RELEASES_METHOD, { args: [] }, deps.host);
    if (!fetched || fetched.status !== 200 || typeof fetched.body !== "string") throw new Error(`GitHub answered ${fetched?.status ?? 0}`);
    return newestRelease(linuxReleases(fetched.body), wanted);
  }

  async function offeredOnce(release: Release) {
    if ((await preferences()).notified === release.version) return false;
    await remember({ notified: release.version });
    return true;
  }

  async function exclusively(run: () => Promise<boolean>): Promise<boolean | "busy"> {
    if (!deps.locks) return run();
    return (await deps.locks.request(UPDATE_INSTALL_LOCK, { ifAvailable: true }, (lock) => (lock ? run() : Promise.resolve("busy" as const)))) as boolean | "busy";
  }

  async function downloadAndInstall(release: Release, kind: UpdateInstallKind, wanted: UpdateChannel, consent: ConsentToken | null): Promise<boolean> {
    const target = release.version;
    const ready = readyToRestart(await preferences(), version());
    if (ready && compareVersions(ready, target) >= 0) return true;
    try {
      switchCheck = { phase: "downloading", channel: wanted, version: target };
      await remember({ work: { version: target, phase: "downloading", at: now() } });
      downloadStarts?.();
      noteUpdateDownloadStarted(consent);
      const downloaded = succeeded(await invokeHost<unknown>(DOWNLOAD_METHOD, { args: [target] }, deps.host).catch(() => null));
      if (!downloaded.ok) {
        noteUpdateDownloadFailed(downloaded.reason, consent);
        console.info(`[ardia linux] the update to ${target} didn't download: ${String(downloaded.reason)}`);
        return false;
      }
      noteUpdateDownloadFinished(consent);
      switchCheck = { phase: "installing", channel: wanted, version: target };
      await remember({ work: { version: target, phase: "installing", at: now() } });
      const installed = succeeded(await invokeHost<unknown>(INSTALL_METHOD, { args: [target] }, deps.host).catch(() => null));
      if (!installed.ok) {
        noteUpdateInstallFailed(installed.reason, consent);
        console.info(`[ardia linux] the update to ${target} didn't install: ${String(installed.reason)}`);
        return false;
      }
      noteUpdateInstalled(kind, consent);
      await remember({ installed: target, notified: target, work: null });
      return true;
    } finally {
      if ((await preferences()).work) await remember({ work: null });
    }
  }

  async function fallBack(release: Release, current: string, from: FallbackFrom, wanted: UpdateChannel, consent: ConsentToken | null) {
    switchCheck = { phase: "found", channel: wanted, version: release.version };
    if (from === "asked") {
      if (await deps.ask(release, current, true)) {
        noteUpdatePageOpened(consent);
        deps.open(release.url);
      }
      return;
    }
    await remember({ notified: release.version, failed: release.version });
    deps.offer(release, true);
  }

  async function selfUpdate(release: Release, current: string, kind: UpdateInstallKind, from: FallbackFrom, wanted: UpdateChannel, consent: ConsentToken | null) {
    const outcome = await exclusively(() => downloadAndInstall(release, kind, wanted, consent));
    if (outcome === "busy") return;
    if (!outcome) return fallBack(release, current, from, wanted, consent);
    const ready = readyToRestart(await preferences(), current) ?? release.version;
    showReady(wanted, ready, from !== "automatic");
  }

  async function deliver(release: Release, current: string, asked: boolean, saved: Preferences, wanted: UpdateChannel, consent: ConsentToken | null) {
    const kind = await installKind();
    if (kind === "managed") {
      if (asked) return deps.managed(release, current, true);
      if (await offeredOnce(release)) await deps.managed(release, current, false);
      return;
    }
    if (installs(kind)) {
      const ready = readyToRestart(await preferences(), current);
      if (ready && compareVersions(ready, release.version) >= 0) return showReady(wanted, ready, asked);
      if (!asked && saved.failed === release.version) return;
      if (asked || saved.automaticDownloads) return selfUpdate(release, current, kind, asked ? "asked" : "automatic", wanted, consent);
      if (await offeredOnce(release)) deps.offerInstall(release, () => installOffered(release, wanted));
      return;
    }
    if (asked) {
      if (await deps.ask(release, current, false)) {
        noteUpdatePageOpened(consent);
        deps.open(release.url);
      }
      return;
    }
    if (await offeredOnce(release)) deps.offer(release, false);
  }

  async function check(asked: boolean, taken?: ConsentToken | null): Promise<void> {
    const consent = taken === undefined ? consentToken() : taken;
    const current = version();
    if (checking || !current) return;
    checking = true;
    let wanted: UpdateChannel = channelOf(current);
    try {
      const saved = await preferences();
      if (!asked && !saved.automaticChecks) return;
      if (workUnderWay(saved, current) && installs(await installKind())) return;
      wanted = channel(saved, current);
      switchCheck = { phase: "checking", channel: wanted };
      let release: Release | null;
      try {
        release = await newest(wanted);
        await remember({ lastCheck: now() });
      } catch (error) {
        noteUpdateCheck(asked, "failed", consent);
        switchCheck = { phase: "failed", channel: wanted };
        console.info(`[ardia linux] the update check failed: ${String(error)}`);
        if (asked) await deps.tell("Ardia couldn't check for updates", `Try again later, or see ${RELEASES_PAGE}.`);
        return;
      }
      const newer = !!release && compareVersions(release.version, current) > 0;
      noteUpdateCheck(asked, newer ? "found" : "upToDate", consent);
      switchCheck = newer ? { phase: "found", channel: wanted, version: release!.version } : { phase: "upToDate", channel: wanted };
      if (!newer) {
        if (asked) await deps.tell("Ardia is up to date", `You have Ardia ${current}, the newest ${wanted === "nightly" ? "Nightly" : "Stable"} build for Linux.`);
        return;
      }
      await deliver(release!, current, asked, saved, wanted, consent).catch((error: unknown) => console.info(`[ardia linux] the update to ${release!.version} stopped: ${String(error)}`));
    } finally {
      checking = false;
    }
  }

  async function acceptOffer(release: Release, wanted: UpdateChannel, consent: ConsentToken | null) {
    const current = version();
    if (checking || !current) return;
    checking = true;
    try {
      const kind = await installKind();
      if (installs(kind)) await selfUpdate(release, current, kind, "accepted", wanted, consent);
    } catch (error) {
      console.info(`[ardia linux] the update to ${release.version} stopped: ${String(error)}`);
    } finally {
      checking = false;
    }
  }
  const installOffered = (release: Release, wanted: UpdateChannel) => void acceptOffer(release, wanted, consentToken());

  const untilDownloadStarts = (run: () => Promise<void>) =>
    new Promise<void>((resolve) => {
      downloadStarts = resolve;
      void run().finally(() => {
        if (downloadStarts === resolve) downloadStarts = null;
        resolve();
      });
    });

  async function checkOrRestart(consent: ConsentToken | null) {
    const pending = readyToRestart(await preferences(), version());
    if (pending && installs(await installKind())) return restart(consent);
    return check(true, consent);
  }

  const methods = {
    updaterState: async (): Promise<UpdaterState> => {
      const current = version();
      const saved = await preferences();
      const selfUpdates = !!current && installs(await installKind());
      const wanted = channel(saved, current);
      const ready = selfUpdates ? readyToRestart(saved, current) : null;
      const elsewhere = selfUpdates && !checking ? workUnderWay(saved, current) : null;
      const shown: SwitchCheck | null = checking && switchCheck
        ? switchCheck
        : ready
          ? { phase: "ready", channel: wanted, version: ready }
          : elsewhere
            ? { phase: elsewhere.phase, channel: wanted, version: elsewhere.version }
            : switchCheck;
      return {
        available: true,
        configured: !!current,
        automaticChecks: saved.automaticChecks,
        automaticDownloads: selfUpdates && saved.automaticDownloads,
        canCheck: !checking && !elsewhere,
        sessionInProgress: checking || !!elsewhere,
        feedURL: RELEASES_PAGE,
        lastCheck: saved.lastCheck,
        version: current ?? deps.appVersion() ?? "",
        channel: wanted,
        buildChannel: current ? channelOf(current) : "stable",
        switchCheck: shown,
      };
    },
    checkForUpdates: () => {
      const consent = consentToken();
      return untilDownloadStarts(() => checkOrRestart(consent));
    },
    setAutomaticUpdateChecks: async (on: unknown) => remember({ automaticChecks: on === true }),
    setAutomaticUpdateDownloads: async (on: unknown) => remember({ automaticDownloads: on === true }),
    setUpdateChannel: async (next: unknown) => {
      await remember({ channel: next === "nightly" ? "nightly" : "stable", notified: null });
      await untilDownloadStarts(() => check(true));
    },
  };

  const checksByItself = async () => {
    const launch = hostLaunchConfig(deps.host);
    return !!version() && !launch.background && !launch.isolated && (await preferences()).automaticChecks;
  };

  return { methods, check, checksByItself, installKind };
}

export type LinuxUpdater = ReturnType<typeof linuxUpdater>;

export function scheduleUpdateChecks(updater: LinuxUpdater, options: { locks?: { request(name: string, callback: () => Promise<void>): Promise<unknown> }; timers?: { setTimeout: typeof setTimeout; setInterval: typeof setInterval } }) {
  const timers = options.timers ?? globalThis;
  const run = () => void updater.checksByItself().then((checks) => {
    if (checks) return updater.check(false);
  });
  const lead = () => new Promise<void>(() => {
    timers.setTimeout(run, FIRST_CHECK_AFTER_MS);
    timers.setInterval(run, CHECK_EVERY_MS);
  });
  if (!options.locks) return;
  void options.locks.request(UPDATE_CHECK_LOCK, lead).catch(() => {});
}

export const updatesAvailable = (host: ArdiaHost) => hostSupports(RELEASES_METHOD, host);
export const killSwitchesAvailable = (host: ArdiaHost) => hostSupports(KILL_SWITCHES_METHOD, host);

export function linuxSwitchesFetch(host: ArdiaHost, original: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== "https://ardia.dev/switches.json") return original(input, init);
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const fetched = await invokeHost<Fetched>(KILL_SWITCHES_METHOD, { args: [] }, host);
    if (!fetched || !fetched.status || typeof fetched.body !== "string") throw new TypeError("Failed to fetch");
    return new Response(fetched.body, { status: fetched.status });
  };
}
