# Fix-all run: shared brief (read all of it before you start)

You are one of ~11 Opus engineers fixing every problem that still persists in Ardia (a browser for macOS, Linux and
Windows, built on Chromium; repo at ~/ardia). The owner asked: "fix all of em, some might be outdated so
verify / reproduce first, then fix, full send, and show me the final before vs after video, don't cut a new release".
The owner is not watching. Work end to end on your own. Do not ask questions; decide and note the decision.

You run on the owner's Mac mini (checkout ~/ardia). The work started on the owner's MacBook and was moved here:
everything the first round of agents had done (finished or not) is on branch `fixall/wip-macbook` (3 commits on top of
48fcfe342 plus one WIP commit). Start by reading the part of `git diff 48fcfe342 origin/fixall/wip-macbook` that
belongs to your area, check it, and bring what's right into this checkout's working tree (by editing files or applying
only your hunks; never apply other areas' hunks, never move HEAD). Your area and its list of problems are in your task
message, with GitHub issue and Bonzai PR numbers.

## Read first
- ~/ardia/AGENTS.md and ~/ardia/docs/agent-brief.md (architecture, test tooling,
  rules). Follow them, with the overrides below. No comments in code. Never touch /Applications/Ardia.app. Never steal
  focus: hidden instances only (`scripts/agent/ac launch …`). Never run gclient sync / gn clean / touch ~/chromium-build/out.

## Workflow, per problem
1. **Verify it is still real on current code.** The checkout is at origin/main 48fcfe342 (Nov 16). Many reports are
   older than fixes that already landed. Read the code, check `git log`, and reproduce in a hidden instance when it's
   reproducible. If it's already fixed, record "already fixed" with the commit and your evidence, and move on.
   If it's intended behaviour (a deliberate product decision in git log or docs) record that and move on.
2. **Claim the GitHub issue** (`gh issue edit <n> -R ardia-browser/ardia --add-assignee @me`) if one exists and is free.
   If none exists, open one later with the PR (`gh issue create -R ardia-browser/ardia --label bug …`, short, plain).
3. **Fix the root cause**, the smallest change that really works. Match surrounding code. Add the telemetry AGENTS.md asks
   for when a measurable path exists (counts/timings/enums only, never URLs or text).
4. **Prove it**: typecheck (`pnpm -w typecheck`), the package's tests (`pnpm -C apps/browser test`, `packages/core` tests,
   etc.), and exercise it in a hidden instance. Shared UI changes: also `pnpm -C apps/linux typecheck`, `test:graph`,
   `test:host`.
5. **Record a before/after clip** for every fix with a visible effect (see "Before and after").
6. **Deliver it as a PR** (see "Delivery"). Do not merge. The main session runs the merge gate.

## Hard limits in this run
- **No engine changes and no Chromium builds by you.** A dedicated engine agent on this Mac mini owns `engine/` and
  every Chromium build; don't edit `engine/`, and never run engine-build, autoninja or anything in ~/chromium-build. If a problem needs the engine, append a precise request to
  ~/ardia-scratch/fixall/ENGINE-REQUESTS.md (your agent name, the problem, the evidence, the exact files
  and change you propose, how to prove it) and tell the main session in your final message; it relays it to the engine agent.
  Keep going with everything else.
- **No releases**, no version bumps, no site deploys, no Discord or social posts.
- Don't edit files another area obviously owns. Shared files (settings.ts, commands.ts, App.tsx, theme.ts, MainMenu.swift,
  ArdiaInternal.h, podspec, acceptance.mjs, ArdiaCore.h, expo-module.config.json): re-read right before each edit, keep
  edits small and additive, never undo someone else's lines. Other agents edit this same working tree right now. Never run
  `git checkout -- <file>`, `git restore`, `git stash`, `git reset`, `git switch`, `git rebase` or anything that moves HEAD
  or rewrites other people's files.

## Builds and instances
- **Baseline ("before") app**: ~/ardia/apps/browser/build-fixbase/Build/Products/Debug/Ardia.app (built
  from 48fcfe342). Don't build into build-fixbase; copy nothing into it.
- **Metro**: :8081 serves the shared working tree (everyone's live edits). :8091 serves a frozen copy of 48fcfe342
  (the "before" JS). Don't start or kill either.
- **JS-only fix**: no build needed. After = baseline app with `--js pinned` (default, pins :8081 at launch).
  Before = baseline app with `--js localhost:8091`.
- **Native fix** (Swift/ObjC in packages/*/ios, apps/browser/macos): build your own app with
  `scripts/agent/build-app --as <your-agent-name> --force` (run_in_background; a first build compiles everything).
  ~/ardia-scratch/fixall/SETUP.md (written by the setup agent) says whether this Mac needs a signing override or an
  `ARDIACORE_FRAMEWORK` path, and gives the exact command. Add `NATIVE_API_VERSION` bumps only when JS starts needing new
  native API (agent-brief.md).
- Every instance gets its own data dir under your scratch dir: `scripts/agent/ac launch <app> --data <scratch>/data-<n>`.
  Quit your own instances when done (`ac quit`). Never `pkill`.
- Your scratch dir: ~/ardia-scratch/fixall/<your-agent-name>/ . Put everything you make there.

## Before and after
- For each visible fix, record the same steps on the before setup and the after setup, in the same state and window size.
- Capture with `screencapture -l <windowID> -o` frames, or CDP `Page.startScreencast`, or `ac.shell.devSnapshotWindow`
  stills when the screen is locked (see agent-brief.md and its glass caveat), wrapped in a 20 s timeout
  (`perl -e 'alarm 20; exec @ARGV' …`).
- Stitch into one mp4 per fix with ffmpeg: left "Before" / right "After" side by side (or one after the other), each side
  labelled with drawtext, H.264, yuv420p, ≤ 1280 px wide, ≤ 20 s. Save as
  `<scratch>/videos/<slug>.mp4`, and write `<scratch>/videos/<slug>.txt` with one plain sentence on what it shows.
- A non-visual fix (a crash, telemetry, a race) gets no video; give the reproduction log before and after instead.
- Watch your own after-frames for UI problems (clipping, overlap, unclear copy) and fix them.

## Delivery (PRs without moving the shared checkout)
- Commit your own hunks to the local `main` of this checkout, one commit per PR, following AGENTS.md's staging rules
  exactly (`git diff --cached --stat` must list only your files; blob staging for files with others' hunks; bare
  `git commit`). Author every commit as Mantra Patel:
  `GIT_AUTHOR_NAME="Mantra Patel" GIT_AUTHOR_EMAIL="87142457+mantrakp04@users.noreply.github.com" GIT_COMMITTER_NAME="Mantra Patel" GIT_COMMITTER_EMAIL="87142457+mantrakp04@users.noreply.github.com" git commit -m …`
  Messages: plain-English subject saying what users get, the why in the body, what to watch on the dashboard. No
  attribution or "Generated with" lines.
- Turn that local commit C into a PR branch based on 48fcfe342 without touching HEAD or the index:
  `t=$(git merge-tree --write-tree --merge-base=C^ 48fcfe342 C) && p=$(GIT_AUTHOR_…=… git commit-tree "$t" -p 48fcfe342 -m "$(git log -1 --format=%B C)") && git push origin "$p:refs/heads/fixall/<slug>"`
  then `gh pr create -R ardia-browser/ardia --head fixall/<slug> --base main --title … --body …` with `Closes #N`
  for every issue it fixes, one line on how you proved it, and the before/after video path noted as "video attached in
  the session report". Group closely related fixes in one PR; keep unrelated ones apart. Aim for few, coherent PRs.
- **Bonzai PRs** in your list: take over the PR's own branch (no new branch). `git fetch origin pull/<n>/head`, read its
  diff, check it against the problem, apply what's right to the working tree, fix what's wrong, prove it, commit locally
  as C, then build the branch commit on the PR's head instead of 48fcfe342
  (`t=$(git merge-tree --write-tree --merge-base=C^ <pr-head> C)`, `commit-tree -p <pr-head>`) and push to the PR's
  branch name. If the Bonzai PR is wrong or obsolete, say so in your report; don't close it.
- Don't watch, babysit or merge PRs. The main session does that.

## Your final message
1. A table: each problem → status (fixed / already fixed on main / intended / needs engine / can't reproduce / external
   blocker) with one line of evidence.
2. PRs: URL, head SHA, issues closed.
3. Videos: absolute paths of each mp4 and its one-line caption.
4. Anything the main session must know (other areas' files you touched, a needed engine change, risks).
Last line: PR <URL>, head <SHA>, checks and reviews <state> (one per PR).
