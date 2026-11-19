const SYSTEM_ROOTS = new Set(["/", "/Applications", "/Library", "/System", "/Users", "/Volumes", "/bin", "/cores", "/dev", "/etc", "/opt", "/private", "/private/etc", "/private/tmp", "/private/var", "/sbin", "/tmp", "/usr", "/usr/local", "/var"]);
const SYSTEM_TREES = ["/System/", "/bin/", "/dev/", "/etc/", "/private/etc/", "/sbin/", "/usr/bin/", "/usr/lib/", "/usr/libexec/", "/usr/sbin/", "/usr/share/"];

export function folderProblem(folder: string): string | null {
  if (!folder.startsWith("/")) return "folder is an absolute path to an unpacked extension (the folder holding manifest.json).";
  if (folder.includes("\0") || folder.split("/").some((part) => part === "." || part === "..")) return "folder is a plain absolute path, without . or .. in it.";
  const trimmed = folder.length > 1 ? folder.replace(/\/+$/, "") : folder;
  const home = /^\/Users\/[^/]+$/.test(trimmed);
  if (SYSTEM_ROOTS.has(trimmed) || home || SYSTEM_TREES.some((tree) => `${trimmed}/`.startsWith(tree))) return `${folder} is a system or home folder, not an extension's own folder.`;
  return null;
}
