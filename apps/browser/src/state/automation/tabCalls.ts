const outstanding = new Set<string>();
const late = new Map<string, string>();

export const isTabBusy = (tabId: string) => outstanding.has(tabId);

export function awaitLate(tabId: string, work: Promise<string>) {
  outstanding.add(tabId);
  void work
    .catch(() => "failed")
    .then((outcome) => {
      outstanding.delete(tabId);
      late.set(tabId, outcome);
    });
}

export function takeLateOutcomes(): Record<string, string> | null {
  if (!late.size) return null;
  const taken = Object.fromEntries(late);
  late.clear();
  return taken;
}
