export const MAX_PROVIDER_TITLE_LENGTH = 120;

export function sanitizeProviderTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const firstLine = stripAnsi(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return null;
  const normalized = firstLine
    .replace(/^(?:#{1,6}|[-*•])\s+/, "")
    .replace(/^>\s*/, "")
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  const characters = Array.from(normalized);
  if (characters.length <= MAX_PROVIDER_TITLE_LENGTH) return normalized;
  return `${characters.slice(0, MAX_PROVIDER_TITLE_LENGTH - 1).join("")}…`;
}

function stripAnsi(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 27 && value[index + 1] === "[") {
      index += 2;
      while (index < value.length) {
        const marker = value.charCodeAt(index);
        if (marker >= 0x40 && marker <= 0x7e) break;
        index += 1;
      }
      continue;
    }
    if (code === 27 && value[index + 1] === "]") {
      index += 2;
      while (index < value.length) {
        if (value.charCodeAt(index) === 7) break;
        if (value.charCodeAt(index) === 27 && value[index + 1] === "\\") {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) continue;
    if (code === 127) continue;
    result += value[index];
  }
  return result;
}
