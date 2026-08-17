/**
 * Motor de análisis de contexto.
 * Detecta archivos relevantes, compresión inteligente y caché.
 * Patrón OpenCode: pasar contexto automático sin intervenir al usuario.
 */
import path from "node:path";
import type { WorkspaceIndex } from "./indexer.js";
import {
  buildWorkspaceIndex,
  extractPublicAPI,
  findRelatedFiles,
  readFileSnippet,
  searchByContent,
  searchByName,
} from "./indexer.js";

const MAX_CONTEXT_BYTES = 30_000;
const MAX_FILES_IN_CONTEXT = 8;

export type ContextEntry = {
  rel: string;
  content: string;
  reason: string;
  priority: number;
};

export type ContextResult = {
  entries: ContextEntry[];
  totalBytes: number;
  truncated: boolean;
};

export type FileCache = Map<string, { content: string; timestamp: number }>;

export class ContextManager {
  private index: WorkspaceIndex | null = null;
  private indexBuiltAt = 0;
  private indexTTL = 30_000;
  private fileCache: FileCache = new Map();
  private fileCacheTTL = 60_000;

  constructor(private root: string) {}

  async ensureIndex(): Promise<WorkspaceIndex> {
    if (this.index && Date.now() - this.indexBuiltAt < this.indexTTL) {
      return this.index;
    }
    this.index = await buildWorkspaceIndex(this.root);
    this.indexBuiltAt = Date.now();
    return this.index;
  }

  async getCachedFile(abs: string): Promise<string | null> {
    const cached = this.fileCache.get(abs);
    if (cached && Date.now() - cached.timestamp < this.fileCacheTTL) {
      return cached.content;
    }
    return null;
  }

  setCachedFile(abs: string, content: string): void {
    this.fileCache.set(abs, { content, timestamp: Date.now() });
  }

  async buildContext(
    requirement: string,
    explicitRefs: string[],
  ): Promise<ContextResult> {
    const index = await this.ensureIndex();
    const candidates: ContextEntry[] = [];

    // 1. Explicit @refs get highest priority
    for (const ref of explicitRefs) {
      const abs = path.resolve(this.root, ref);
      const cached = await this.getCachedFile(abs);
      const content = cached ?? await readFileSnippet(abs, 8000);
      if (content) {
        this.setCachedFile(abs, content);
        candidates.push({ rel: ref, content, reason: "explicit-ref", priority: 100 });
      }
    }

    // 2. Detect files mentioned by name in the requirement
    const mentioned = this.detectMentionedFiles(requirement, index);
    for (const rel of mentioned) {
      if (candidates.some((c) => c.rel === rel)) continue;
      const file = index.files.get(rel);
      if (!file) continue;
      const content = await this.readFileOrSnippet(file.abs, 5000);
      candidates.push({ rel, content, reason: "mentioned-in-query", priority: 80 });
    }

    // 3. Detect class/function names mentioned
    const nameHits = this.detectMentionedNames(requirement, index);
    for (const rel of nameHits) {
      if (candidates.some((c) => c.rel === rel)) continue;
      const file = index.files.get(rel);
      if (!file) continue;
      const content = await this.readFileOrSnippet(file.abs, 5000);
      candidates.push({ rel, content, reason: "name-reference", priority: 60 });
    }

    // 4. Find related files to already-found candidates
    const foundRels = new Set(candidates.map((c) => c.rel));
    for (const rel of foundRels) {
      const related = findRelatedFiles(index, rel);
      for (const r of related) {
        if (foundRels.has(r)) continue;
        if (candidates.some((c) => c.rel === r)) continue;
        const file = index.files.get(r);
        if (!file) continue;
        const content = await this.readFileOrSnippet(file.abs, 3000);
        candidates.push({ rel: r, content, reason: `related-to-${rel}`, priority: 40 });
        foundRels.add(r);
        if (candidates.length >= MAX_FILES_IN_CONTEXT * 2) break;
      }
      if (candidates.length >= MAX_FILES_IN_CONTEXT * 2) break;
    }

    // 5. Sort by priority and truncate by byte budget
    candidates.sort((a, b) => b.priority - a.priority);

    const entries: ContextEntry[] = [];
    let totalBytes = 0;
    let truncated = false;

    for (const c of candidates) {
      if (entries.length >= MAX_FILES_IN_CONTEXT) {
        truncated = true;
        break;
      }
      const entryBytes = c.content.length + c.rel.length + 50;
      if (totalBytes + entryBytes > MAX_CONTEXT_BYTES) {
        truncated = true;
        continue;
      }
      entries.push(c);
      totalBytes += entryBytes;
    }

    return { entries, totalBytes, truncated };
  }

  detectMentionedFiles(text: string, index: WorkspaceIndex): string[] {
    const results: string[] = [];

    // Look for path-like patterns: src/foo.ts, ./lib/bar.js
    const pathPattern = /(?:^|\s)((?:\.\/|\.\.\/|[\w-]+\/)*[\w-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|css|scss|html|md))\b/g;
    let match: RegExpExecArray | null;
    while ((match = pathPattern.exec(text))) {
      const raw = match[1];
      if (raw) {
        const found = searchByName(index, path.basename(raw));
        results.push(...found);
      }
    }

    // Look for quoted file references
    const quotePattern = /["']([^"']+\.(?:ts|tsx|js|jsx|py|go|rs|java|css|scss|html|md))["']/g;
    while ((match = quotePattern.exec(text))) {
      const raw = match[1];
      if (raw) {
        const found = searchByName(index, path.basename(raw));
        results.push(...found);
      }
    }

    return [...new Set(results)].slice(0, 5);
  }

  detectMentionedNames(text: string, index: WorkspaceIndex): string[] {
    const results: string[] = [];
    const words = text.split(/\s+/).filter((w) => w.length > 2);

    for (const word of words) {
      // Skip common words
      if (STOP_WORDS.has(word.toLowerCase())) continue;

      // Look for PascalCase (likely class names)
      if (/^[A-Z][a-zA-Z0-9]+$/.test(word)) {
        const byClass = searchByContent(index, word);
        results.push(...byClass);
      }

      // Look for camelCase (likely function names)
      if (/^[a-z][a-zA-Z0-9]+$/.test(word)) {
        const byFn = searchByContent(index, word);
        results.push(...byFn);
      }
    }

    return [...new Set(results)].slice(0, 5);
  }

  private async readFileOrSnippet(abs: string, maxBytes: number): Promise<string> {
    const cached = await this.getCachedFile(abs);
    if (cached) return cached.slice(0, maxBytes);

    const content = await readFileSnippet(abs, maxBytes);
    if (content) this.setCachedFile(abs, content);
    return content;
  }

  clearCache(): void {
    this.fileCache.clear();
    this.index = null;
    this.indexBuiltAt = 0;
  }
}

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "need", "must",
  "this", "that", "these", "those", "it", "its",
  "el", "la", "los", "las", "un", "una", "unos", "unas",
  "es", "son", "está", "están", "ser", "estar", "haber",
  "para", "por", "con", "sin", "sobre", "entre", "hasta",
  "como", "cuando", "donde", "que", "cual", "quien",
  "create", "make", "add", "fix", "update", "delete", "remove",
  "file", "files", "function", "class", "component", "module",
]);

export function formatContextForPrompt(result: ContextResult): string {
  if (result.entries.length === 0) return "";

  const parts: string[] = ["\n--- workspace context ---"];
  for (const entry of result.entries) {
    parts.push(`\n// ${entry.rel} (${entry.reason})\n${entry.content}`);
  }
  if (result.truncated) {
    parts.push("\n// ... (more files available via @ref)");
  }
  parts.push("--- end context ---\n");

  return parts.join("\n");
}
