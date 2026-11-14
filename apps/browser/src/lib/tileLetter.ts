import { displayHostOf } from "./url";

const LETTER = /\p{L}/u;

const firstLetter = (text: string): string | null => {
  for (const char of text) if (LETTER.test(char)) return char.toLocaleUpperCase();
  return null;
};

export function tileLetterOf(url: string, title: string): string {
  const host = url ? displayHostOf(url) : "";
  const fromHost = host && LETTER.test([...host][0] ?? "") ? firstLetter(host) : null;
  return fromHost ?? firstLetter(title) ?? "•";
}
