/**
 * Syntax highlighting ligero para el editor TUI.
 * Tokeniza líneas de código y asigna colores por token.
 * Soporta: TS/JS/JSX/TSX, Python, Go, Rust, CSS, HTML, Markdown.
 */

export type TokenKind =
  | "keyword"
  | "string"
  | "number"
  | "comment"
  | "function"
  | "type"
  | "operator"
  | "punctuation"
  | "property"
  | "boolean"
  | "decorator"
  | "tag"
  | "attr"
  | "text";

export type Token = {
  kind: TokenKind;
  value: string;
};

const TS_KEYWORDS = new Set([
  "import", "export", "from", "default", "const", "let", "var",
  "function", "return", "if", "else", "for", "while", "do",
  "switch", "case", "break", "continue", "class", "extends",
  "implements", "interface", "type", "enum", "namespace", "module",
  "declare", "abstract", "as", "async", "await", "yield",
  "new", "delete", "typeof", "instanceof", "in", "of",
  "try", "catch", "finally", "throw", "static", "get", "set",
  "readonly", "public", "private", "protected", "override",
  "satisfies", "keyof", "infer", "is", "never", "unknown", "any",
  "void", "null", "undefined", "true", "false",
]);

const PYTHON_KEYWORDS = new Set([
  "import", "from", "def", "class", "return", "if", "elif", "else",
  "for", "while", "break", "continue", "pass", "raise", "try",
  "except", "finally", "with", "as", "yield", "lambda", "and",
  "or", "not", "in", "is", "None", "True", "False", "self",
  "global", "nonlocal", "assert", "del", "print",
]);

const GO_KEYWORDS = new Set([
  "package", "import", "func", "return", "if", "else", "for",
  "range", "switch", "case", "default", "break", "continue",
  "go", "chan", "select", "defer", "var", "const", "type",
  "struct", "interface", "map", "make", "new", "len", "cap",
  "append", "copy", "delete", "panic", "recover", "error",
  "true", "false", "nil",
]);

const RUST_KEYWORDS = new Set([
  "fn", "let", "mut", "const", "static", "struct", "enum",
  "impl", "trait", "type", "pub", "use", "mod", "crate",
  "self", "super", "return", "if", "else", "for", "while",
  "loop", "match", "break", "continue", "move", "ref",
  "async", "await", "where", "as", "in", "true", "false",
  "Some", "None", "Ok", "Err", "Self",
]);

const CSS_KEYWORDS = new Set([
  "import", "media", "keyframes", "font-face", "supports",
  "charset", "namespace",
]);

const BOOL_LITERALS = new Set([
  "true", "false", "null", "undefined", "nil", "None", "True", "False",
  "NaN", "Infinity",
]);

const MULTI_CHAR_OPS = new Set([
  "===", "!==", ">>>", "<<=", ">>=", "**=", "&&=", "||=", "??=",
  "==", "!=", "<=", ">=", "&&", "||", "??", "=>", "+=", "-=",
  "*=", "/=", "**", ">>", "<<", "++", "--", "?.",
]);

export type Lang = "auto" | "ts" | "py" | "go" | "rs" | "css" | "html" | "md" | "json" | "yaml";

function getKeywords(lang: Lang): Set<string> {
  switch (lang) {
    case "py": return PYTHON_KEYWORDS;
    case "go": return GO_KEYWORDS;
    case "rs": return RUST_KEYWORDS;
    case "css": return CSS_KEYWORDS;
    default: return TS_KEYWORDS;
  }
}

function at(line: string, i: number): string {
  return i < line.length ? line[i] ?? "" : "";
}

function tokenize(line: string, lang: Lang): Token[] {
  const tokens: Token[] = [];
  const keywords = getKeywords(lang);
  let i = 0;
  const len = line.length;

  while (i < len) {
    const ch = at(line, i);
    const next = at(line, i + 1);

    // Line comment
    if (ch === "/" && next === "/") {
      tokens.push({ kind: "comment", value: line.slice(i) });
      break;
    }

    // Hash comment (Python, YAML)
    if (ch === "#" && (lang === "py" || lang === "yaml")) {
      tokens.push({ kind: "comment", value: line.slice(i) });
      break;
    }

    // Block comment start
    if (ch === "/" && next === "*") {
      const end = line.indexOf("*/", i + 2);
      if (end !== -1) {
        tokens.push({ kind: "comment", value: line.slice(i, end + 2) });
        i = end + 2;
        continue;
      }
      tokens.push({ kind: "comment", value: line.slice(i) });
      break;
    }

    // HTML comment
    if (ch === "<" && next === "!" && at(line, i + 2) === "-" && at(line, i + 3) === "-") {
      tokens.push({ kind: "comment", value: line.slice(i) });
      break;
    }

    // Strings
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < len) {
        const cj = at(line, j);
        if (cj === "\\") { j += 2; continue; }
        if (cj === quote) { j++; break; }
        j++;
      }
      tokens.push({ kind: "string", value: line.slice(i, j) });
      i = j;
      continue;
    }

    // Numbers
    const isDigit = /\d/.test(ch);
    const isDotDigit = ch === "." && /\d/.test(next);
    if (isDigit || isDotDigit) {
      let j = i;
      const c0 = at(line, j);
      const c1 = at(line, j + 1);
      if (c0 === "0" && (c1 === "x" || c1 === "X")) {
        j += 2;
        while (j < len && /[0-9a-fA-F]/.test(at(line, j))) j++;
      } else if (c0 === "0" && (c1 === "b" || c1 === "B")) {
        j += 2;
        while (j < len && /[01]/.test(at(line, j))) j++;
      } else {
        while (j < len && /[\d.]/.test(at(line, j))) j++;
        const ce = at(line, j);
        if (ce === "e" || ce === "E") {
          j++;
          const cs = at(line, j);
          if (cs === "+" || cs === "-") j++;
          while (j < len && /\d/.test(at(line, j))) j++;
        }
      }
      if (at(line, j) === "n") j++;
      tokens.push({ kind: "number", value: line.slice(i, j) });
      i = j;
      continue;
    }

    // Decorators
    if (ch === "@") {
      let j = i + 1;
      while (j < len && /[\w.]/.test(at(line, j))) j++;
      tokens.push({ kind: "decorator", value: line.slice(i, j) });
      i = j;
      continue;
    }

    // Words (identifiers, keywords)
    if (/[a-zA-Z_$]/.test(ch)) {
      let j = i;
      while (j < len && /[\w$]/.test(at(line, j))) j++;
      const word = line.slice(i, j);

      if (BOOL_LITERALS.has(word)) {
        tokens.push({ kind: "boolean", value: word });
        i = j;
        continue;
      }

      if (keywords.has(word)) {
        tokens.push({ kind: "keyword", value: word });
        i = j;
        continue;
      }

      if (/^[A-Z]/.test(word) && word.length > 1) {
        tokens.push({ kind: "type", value: word });
        i = j;
        continue;
      }

      // Check if it's a function call (word followed by '(')
      let k = j;
      while (k < len && at(line, k) === " ") k++;
      if (at(line, k) === "(") {
        tokens.push({ kind: "function", value: word });
        i = j;
        continue;
      }

      // Check if it's a property (preceded by '.')
      if (i > 0 && at(line, i - 1) === ".") {
        tokens.push({ kind: "property", value: word });
        i = j;
        continue;
      }

      tokens.push({ kind: "text", value: word });
      i = j;
      continue;
    }

    // Operators
    if (/[=+\-*/<>!&|^~%?:]/.test(ch)) {
      const two = line.slice(i, i + 2);
      const three = line.slice(i, i + 3);
      let j = i + 1;
      if (MULTI_CHAR_OPS.has(three)) {
        j = i + 3;
      } else if (MULTI_CHAR_OPS.has(two)) {
        j = i + 2;
      }
      tokens.push({ kind: "operator", value: line.slice(i, j) });
      i = j;
      continue;
    }

    // Punctuation
    if (/[{}()\[\];,.]/.test(ch)) {
      tokens.push({ kind: "punctuation", value: ch });
      i++;
      continue;
    }

    // Whitespace
    if (/\s/.test(ch)) {
      let j = i;
      while (j < len && /\s/.test(at(line, j))) j++;
      tokens.push({ kind: "text", value: line.slice(i, j) });
      i = j;
      continue;
    }

    // Anything else
    tokens.push({ kind: "text", value: ch });
    i++;
  }

  return tokens;
}

export function tokenizeLine(line: string, lang: Lang = "auto"): Token[] {
  const detected = lang === "auto" ? detectLang(line) : lang;
  return tokenize(line, detected);
}

function detectLang(line: string): Lang {
  const t = line.trim();
  if (t.startsWith("```")) return "ts";
  if (/^\s*#/.test(line) && !t.startsWith("#!")) return "py";
  if (t.startsWith("<") && (t.includes(">") || t.includes("/>"))) return "html";
  if (/^\s*-\s+\w+:/g.test(t)) return "yaml";
  return "ts";
}

export type ColoredSegment = {
  text: string;
  color: string;
};

const TOKEN_COLORS: Record<TokenKind, string> = {
  keyword: "#c792ea",
  string: "#c3e88d",
  number: "#f78c6c",
  comment: "#546e7a",
  function: "#82aaff",
  type: "#ffcb6b",
  operator: "#89ddff",
  punctuation: "#89ddff",
  property: "#f07178",
  boolean: "#ff5370",
  decorator: "#c792ea",
  tag: "#f07178",
  attr: "#ffcb6b",
  text: "#d6deeb",
};

export function colorizeLine(line: string, lang: Lang = "auto"): ColoredSegment[] {
  const tokens = tokenizeLine(line, lang);
  return tokens.map((t) => ({
    text: t.value,
    color: TOKEN_COLORS[t.kind] ?? TOKEN_COLORS.text,
  }));
}

export function langFromExt(filename: string): Lang {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "ts";
    case "py":
    case "pyw":
      return "py";
    case "go":
      return "go";
    case "rs":
      return "rs";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "htm":
    case "xml":
    case "svg":
      return "html";
    case "md":
    case "mdx":
      return "md";
    case "json":
      return "json";
    case "yaml":
    case "yml":
      return "yaml";
    default:
      return "ts";
  }
}
