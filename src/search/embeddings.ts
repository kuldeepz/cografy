/**
 * Embedding providers. The default provider is fully local and dependency-free:
 * it hashes token/char n-grams into a fixed-dimensional bag-of-features vector
 * and L2-normalizes it. This yields useful lexical-semantic similarity with no
 * API key or network. A real model provider can be plugged in via the same
 * interface for higher-quality semantic search.
 */
export interface EmbeddingProvider {
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  constructor(readonly dim = 256) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): Float32Array {
    const vec = new Float32Array(this.dim);
    const tokens = tokenize(text);
    for (const tok of tokens) {
      // whole-token feature
      addFeature(vec, tok, 1.0, this.dim);
      // char trigrams for subword robustness
      for (let i = 0; i < tok.length - 2; i++) {
        addFeature(vec, tok.slice(i, i + 3), 0.5, this.dim);
      }
    }
    normalize(vec);
    return vec;
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    // split camelCase and snake_case
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]/g, " ")
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function addFeature(vec: Float32Array, feature: string, weight: number, dim: number): void {
  let h = 2166136261;
  for (let i = 0; i < feature.length; i++) {
    h ^= feature.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const idx = Math.abs(h) % dim;
  const sign = (h & 1) === 0 ? 1 : -1;
  vec[idx] += weight * sign;
}

function normalize(vec: Float32Array): void {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot; // vectors are pre-normalized
}

export function textForEmbedding(name: string, signature?: string, snippet?: string): string {
  return [name, signature ?? "", snippet ?? ""].join("\n").slice(0, 2000);
}
