import { resolve, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import type { CografyConfig, Profile } from "./types.js";

export const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/.next/**",
  "**/coverage/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
  "**/.cografy/**",
  "**/*.min.js",
  "**/*.map",
];

export const DEFAULT_INCLUDES = ["**/*"];

export const CONFIG_FILENAME = "cografy.config.json";

/** User-editable config file shape (all fields optional). */
export interface CografyFileConfig {
  profile?: Profile;
  resolver?: CografyConfig["resolver"];
  search?: CografyConfig["search"];
  parsing?: CografyConfig["parsing"];
  viewer?: CografyConfig["viewer"];
  embeddings?: CografyConfig["embeddings"];
  embeddingDim?: number;
  tokenBudget?: number;
  include?: string[];
  exclude?: string[];
  maxFileBytes?: number;
}

export function loadFileConfig(root: string): CografyFileConfig {
  const path = join(root, CONFIG_FILENAME);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CografyFileConfig;
  } catch {
    return {};
  }
}

export function resolveConfig(
  root: string,
  overrides: Partial<CografyConfig> = {},
): CografyConfig {
  const absRoot = resolve(root);
  const file = loadFileConfig(absRoot);

  const pick = <T>(o: T | undefined, f: T | undefined, d: T): T =>
    o !== undefined ? o : f !== undefined ? f : d;

  return {
    root: absRoot,
    dbPath: overrides.dbPath ?? join(absRoot, ".cografy", "graph.db"),
    include: pick(overrides.include, file.include, DEFAULT_INCLUDES),
    exclude: pick(overrides.exclude, file.exclude, DEFAULT_EXCLUDES),
    maxFileBytes: pick(overrides.maxFileBytes, file.maxFileBytes, 1_500_000),
    embeddingDim: pick(overrides.embeddingDim, file.embeddingDim, 256),
    tokenBudget: pick(overrides.tokenBudget, file.tokenBudget, 8000),
    profile: pick(overrides.profile, file.profile, "auto"),
    resolver: pick(overrides.resolver, file.resolver, "auto"),
    search: pick(overrides.search, file.search, "auto"),
    parsing: pick(overrides.parsing, file.parsing, "auto"),
    viewer: pick(overrides.viewer, file.viewer, "inline"),
    embeddings: pick(overrides.embeddings, file.embeddings, "local"),
  };
}

/**
 * Resolve `auto` behaviors to concrete ones given the repo size. `monorepo`
 * (or a large repo under `auto`) turns on the scale features: gated search and
 * worker parsing. Incremental resolution is always used on the watcher path.
 */
export function effectiveModes(
  config: CografyConfig,
  fileCount: number,
): { search: "brute" | "gated"; parsing: "single" | "workers" } {
  const big =
    config.profile === "monorepo" || (config.profile === "auto" && fileCount > 2500);
  return {
    search: config.search === "auto" ? (big ? "gated" : "brute") : config.search,
    parsing:
      config.parsing === "auto" ? (fileCount > 1500 ? "workers" : "single") : config.parsing,
  };
}
