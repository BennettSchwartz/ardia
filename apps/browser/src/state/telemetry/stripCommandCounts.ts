let refused = 0;

export const noteTabStripCommandRefused = () => void refused++;

export function takeStripCommandCounts() {
  const taken = { tab_strip_commands_refused: refused };
  refused = 0;
  return taken;
}
