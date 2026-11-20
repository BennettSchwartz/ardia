export async function syncNowThrough(call: () => Promise<unknown>, stillWanted: () => void): Promise<boolean> {
  stillWanted();
  return (await call()) !== false;
}
