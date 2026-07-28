const HEADER_TAG_PATTERN = /^\[([A-Za-z][A-Za-z0-9_-]*):([^\]]*)\]\s*$/u;

export function validateLanguageMetadata(parsed, source) {
  const meta = parsed?.meta && typeof parsed.meta === "object" ? parsed.meta : {};
  const primaryLanguage = typeof meta.lang === "string" ? meta.lang.trim() : "";
  const languages = Array.isArray(meta.langs)
    ? meta.langs
      .filter((language) => typeof language === "string")
      .map((language) => language.trim())
      .filter(Boolean)
    : [];
  const errors = [];

  if (!primaryLanguage) {
    errors.push({ message: "Missing non-empty [lang:] header", line: findHeaderLine(source, "lang") });
  }
  if (languages.length === 0) {
    errors.push({ message: "Missing non-empty [langs:] header", line: findHeaderLine(source, "langs") });
  }

  if (languages.length > 0) {
    const requiredLanguages = new Map();
    if (primaryLanguage) {
      requiredLanguages.set(normalizeLanguageTag(primaryLanguage), primaryLanguage);
    }

    if (Array.isArray(parsed?.lines)) {
      for (const line of parsed.lines) {
        if (!Array.isArray(line?.translations)) continue;
        for (const translation of line.translations) {
          if (typeof translation?.lang !== "string" || translation.lang.trim() === "") continue;
          const language = translation.lang.trim();
          requiredLanguages.set(normalizeLanguageTag(language), language);
        }
      }
    }

    const declaredLanguages = new Set(languages.map(normalizeLanguageTag));
    const missingLanguages = [...requiredLanguages]
      .filter(([normalized]) => !declaredLanguages.has(normalized))
      .map(([, language]) => language);

    if (missingLanguages.length > 0) {
      errors.push({
        message: `[langs:] must include [lang:] and every inline translation language; missing: ${missingLanguages.join(", ")}`,
        line: findHeaderLine(source, "langs")
      });
    }
  }

  return errors;
}

// Read the managed fields from the leading header block.
export function readHeaders(source) {
  const headers = { ar: "", ti: "", length: "", lang: "", langs: "" };
  for (const line of source.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    const match = line.match(HEADER_TAG_PATTERN);
    if (!match) break;
    const key = (match[1] ?? "").toLowerCase();
    if (key in headers) headers[key] = match[2] ?? "";
  }
  return headers;
}

// Replace (or insert) one header line in place, leaving the lyric body untouched.
export function patchHeader(source, key, value) {
  const lines = source.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  let lastHeader = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") {
      if (lastHeader >= 0) break;
      continue;
    }
    const match = lines[i].match(HEADER_TAG_PATTERN);
    if (!match) break;
    lastHeader = i;
    if ((match[1] ?? "").toLowerCase() === key) {
      lines[i] = `[${key}:${value}]`;
      return lines.join("\n");
    }
  }
  lines.splice(lastHeader + 1, 0, `[${key}:${value}]`);
  return lines.join("\n");
}

export function findHeaderLine(source, header) {
  const lines = source.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === "") continue;
    const match = lines[index].match(HEADER_TAG_PATTERN);
    if (!match) break;
    if ((match[1] ?? "").toLowerCase() === header) return index + 1;
  }
  return 0;
}

function normalizeLanguageTag(language) {
  return language.toLowerCase();
}
