export type MessageTemplate = readonly [id: string, text: string];

const PLACEHOLDER = "{}";

type Compiled = { template: MessageTemplate; parts: string[] };

const compiledLists = new WeakMap<readonly MessageTemplate[], Compiled[]>();

const fixedLength = (parts: string[]) => parts.reduce((sum, part) => sum + part.length, 0);

function compile(templates: readonly MessageTemplate[]): Compiled[] {
  return templates.map((template) => ({ template, parts: template[1].split(PLACEHOLDER) })).sort((a, b) => fixedLength(b.parts) - fixedLength(a.parts));
}

function fits(text: string, parts: string[]): boolean {
  const first = parts[0]!;
  if (parts.length === 1) return text === first;
  const last = parts.at(-1)!;
  const end = text.length - last.length;
  if (end < first.length || !text.startsWith(first) || !text.endsWith(last)) return false;
  let at = first.length;
  for (const part of parts.slice(1, -1)) {
    const found = text.indexOf(part, at);
    if (found < 0 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
}

export function matchTemplate(text: string, templates: readonly MessageTemplate[]): MessageTemplate | null {
  let compiled = compiledLists.get(templates);
  if (!compiled) compiledLists.set(templates, (compiled = compile(templates)));
  return compiled.find(({ parts }) => fits(text, parts))?.template ?? null;
}
