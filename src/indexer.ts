/**
 * Indexación ligera del workspace.
 * Escanea archivos, extrae exports/imports y construye un grafo de dependencias.
 * Sin embeddings: análisis estático de código fuente.
 */
import fs from "node:fs/promises";
import path from "node:path";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "coverage", ".next", ".turbo",
  "build", ".cache", "__pycache__", ".venv", "venv",
]);

const SKIP_EXTENSIONS = new Set([
  ".json", ".lock", ".png", ".jpg", ".jpeg", ".gif", ".svg",
  ".woff", ".woff2", ".ttf", ".eot", ".ico", ".webp",
  ".mp3", ".mp4", ".wav", ".ogg",
]);

const MAX_FILE_SIZE = 100_000;
const MAX_INDEX_ENTRIES = 500;

export type FileIndex = {
  rel: string;
  abs: string;
  exports: string[];
  imports: string[];
  classes: string[];
  functions: string[];
  size: number;
  lastModified: number;
};

export type WorkspaceIndex = {
  root: string;
  files: Map<string, FileIndex>;
  exportToFiles: Map<string, string[]>;
  classToFiles: Map<string, string[]>;
  functionToFiles: Map<string, string[]>;
  builtAt: number;
};

export async function buildWorkspaceIndex(root: string): Promise<WorkspaceIndex> {
  const files = new Map<string, FileIndex>();
  await walkDir(root, "", files);

  const exportToFiles = new Map<string, string[]>();
  const classToFiles = new Map<string, string[]>();
  const functionToFiles = new Map<string, string[]>();

  for (const [rel, idx] of files) {
    for (const exp of idx.exports) {
      const list = exportToFiles.get(exp) ?? [];
      list.push(rel);
      exportToFiles.set(exp, list);
    }
    for (const cls of idx.classes) {
      const list = classToFiles.get(cls) ?? [];
      list.push(rel);
      classToFiles.set(cls, list);
    }
    for (const fn of idx.functions) {
      const list = functionToFiles.get(fn) ?? [];
      list.push(rel);
      functionToFiles.set(fn, list);
    }
  }

  return { root, files, exportToFiles, classToFiles, functionToFiles, builtAt: Date.now() };
}

async function walkDir(
  absDir: string,
  relPrefix: string,
  out: Map<string, FileIndex>,
): Promise<void> {
  if (out.size >= MAX_INDEX_ENTRIES) return;

  let entries: string[];
  try {
    entries = await fs.readdir(absDir);
  } catch {
    return;
  }

  for (const name of entries) {
    if (out.size >= MAX_INDEX_ENTRIES) return;
    if (SKIP_DIRS.has(name)) continue;

    const abs = path.join(absDir, name);
    const rel = relPrefix ? `${relPrefix}/${name}` : name;

    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      await walkDir(abs, rel, out);
      continue;
    }

    const ext = path.extname(name).toLowerCase();
    if (SKIP_EXTENSIONS.has(ext)) continue;
    if (stat.size > MAX_FILE_SIZE) continue;

    try {
      const content = await fs.readFile(abs, "utf8");
      const idx = parseFile(rel, abs, content, stat.size, stat.mtimeMs);
      out.set(rel, idx);
    } catch {
      // skip files that can't be read
    }
  }
}

function parseFile(
  rel: string,
  abs: string,
  content: string,
  size: number,
  lastModified: number,
): FileIndex {
  const exports: string[] = [];
  const imports: string[] = [];
  const classes: string[] = [];
  const functions: string[] = [];

  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    // Export patterns
    const expMatch = trimmed.match(
      /export\s+(?:default\s+)?(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/,
    );
    if (expMatch?.[1]) exports.push(expMatch[1]);

    // Re-exports
    const reExportMatch = trimmed.match(/export\s+\{([^}]+)\}/);
    if (reExportMatch?.[1]) {
      for (const name of reExportMatch[1].split(",")) {
        const clean = name.trim().split(/\s+as\s+/)[0]?.trim();
        if (clean) exports.push(clean);
      }
    }

    // Import patterns
    const importMatch = trimmed.match(
      /import\s+(?:\{[^}]*\}|[\w*]+(?:\s*,\s*\{[^}]*\})?)\s+from\s+["']([^"']+)["']/,
    );
    if (importMatch?.[1]) imports.push(importMatch[1]);

    // Side-effect imports
    const sideEffectMatch = trimmed.match(/import\s+["']([^"']+)["']/);
    if (sideEffectMatch?.[1]) imports.push(sideEffectMatch[1]);

    // Class declarations
    const classMatch = trimmed.match(/(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
    if (classMatch?.[1]) classes.push(classMatch[1]);

    // Function declarations
    const fnMatch = trimmed.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
    if (fnMatch?.[1]) functions.push(fnMatch[1]);
  }

  return { rel, abs, exports, imports, classes, functions, size, lastModified };
}

export function findFilesByExport(index: WorkspaceIndex, exportName: string): string[] {
  return index.exportToFiles.get(exportName) ?? [];
}

export function findFilesByClass(index: WorkspaceIndex, className: string): string[] {
  return index.classToFiles.get(className) ?? [];
}

export function findFilesByFunction(index: WorkspaceIndex, functionName: string): string[] {
  return index.functionToFiles.get(functionName) ?? [];
}

export function findRelatedFiles(index: WorkspaceIndex, relPath: string): string[] {
  const file = index.files.get(relPath);
  if (!file) return [];

  const related = new Set<string>();

  // Files that import this file
  for (const [otherRel, otherIdx] of index.files) {
    if (otherRel === relPath) continue;
    for (const imp of otherIdx.imports) {
      if (imp === relPath || imp.endsWith("/" + relPath) || relPath.startsWith(imp)) {
        related.add(otherRel);
      }
    }
  }

  // Files imported by this file
  for (const imp of file.imports) {
    if (imp.startsWith(".")) {
      const resolved = path.resolve(path.dirname(relPath), imp);
      for (const key of index.files.keys()) {
        if (key === resolved || key.startsWith(resolved)) {
          related.add(key);
        }
      }
    }
  }

  return Array.from(related).slice(0, 10);
}

export function searchByName(index: WorkspaceIndex, query: string): string[] {
  const lower = query.toLowerCase();
  const results: Array<{ rel: string; score: number }> = [];

  for (const rel of index.files.keys()) {
    const name = path.basename(rel).toLowerCase();
    if (name.includes(lower)) {
      results.push({ rel, score: name === lower ? 2 : 1 });
    }
  }

  return results.sort((a, b) => b.score - a.score).map((r) => r.rel).slice(0, 10);
}

export function searchByContent(index: WorkspaceIndex, query: string): string[] {
  const lower = query.toLowerCase();
  const results: string[] = [];

  for (const [rel, idx] of index.files) {
    const allNames = [...idx.exports, ...idx.classes, ...idx.functions];
    for (const name of allNames) {
      if (name.toLowerCase().includes(lower)) {
        results.push(rel);
        break;
      }
    }
  }

  return results.slice(0, 10);
}

export async function readFileSnippet(abs: string, maxBytes = 5000): Promise<string> {
  try {
    const content = await fs.readFile(abs, "utf8");
    if (content.length <= maxBytes) return content;
    return content.slice(0, maxBytes) + "\n// ... (truncated)";
  } catch {
    return "";
  }
}

export async function extractPublicAPI(abs: string): Promise<string> {
  try {
    const content = await fs.readFile(abs, "utf8");
    const lines = content.split("\n");
    const api: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (
        trimmed.match(/^export\s+(?:default\s+)?(?:const|let|var|function|class|interface|type|enum)\s+/) ||
        trimmed.match(/^export\s+\{/) ||
        trimmed.match(/^(?:public|protected)\s+(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?\w+/)
      ) {
        api.push(line);
      }
    }

    if (api.length === 0) {
      // Fallback: extract first 50 lines
      return lines.slice(0, 50).join("\n");
    }

    return api.join("\n");
  } catch {
    return "";
  }
}
