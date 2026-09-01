import { extname, basename } from "node:path";

const EXT_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".cs": "csharp",
  ".php": "php",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".hpp": "cpp",
  ".swift": "swift",
  ".scala": "scala",
  ".sql": "sql",
  ".sh": "shell",
  ".r": "r",
  ".lua": "lua",
  ".dart": "dart",
  ".vue": "vue",
  ".svelte": "svelte",
};

const ASSET_EXT: Record<string, string> = {
  ".pdf": "pdf",
  ".md": "markdown",
  ".mdx": "markdown",
  ".rst": "docs",
  ".txt": "text",
  ".mp4": "video",
  ".mov": "video",
  ".mkv": "video",
  ".webm": "video",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".svg": "image",
};

export function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return EXT_LANG[ext] ?? ASSET_EXT[ext] ?? "unknown";
}

export function isAsset(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return ext in ASSET_EXT;
}

export function isCode(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return ext in EXT_LANG;
}

export function assetKind(filePath: string): string {
  return ASSET_EXT[extname(filePath).toLowerCase()] ?? "text";
}

export function displayName(filePath: string): string {
  return basename(filePath);
}
