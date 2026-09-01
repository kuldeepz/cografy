import { LocalEmbeddingProvider, type EmbeddingProvider } from "./embeddings.js";

/**
 * Optional high-quality embedding provider backed by a local ONNX sentence model
 * via @huggingface/transformers (no API key, no server). Loaded dynamically so
 * the package stays optional; if it isn't installed or fails to load, callers
 * fall back to the built-in local provider.
 */
export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly dim: number;
  private modelId: string;
  private extractor: any | null = null;
  private loading: Promise<void> | null = null;

  constructor(modelId = "Xenova/all-MiniLM-L6-v2", dim = 384) {
    this.modelId = modelId;
    this.dim = dim;
  }

  private async ensure(): Promise<void> {
    if (this.extractor) return;
    if (!this.loading) {
      this.loading = (async () => {
        // Dynamic specifier avoids static resolution of this optional dependency.
        const pkg = "@huggingface/transformers";
        const mod: any = await import(/* @vite-ignore */ pkg);
        this.extractor = await mod.pipeline("feature-extraction", this.modelId);
      })();
    }
    await this.loading;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    await this.ensure();
    const out: Float32Array[] = [];
    // Process in modest batches to bound memory.
    const batch = 32;
    for (let i = 0; i < texts.length; i += batch) {
      const slice = texts.slice(i, i + batch);
      const res = await this.extractor(slice, { pooling: "mean", normalize: true });
      // res is a Tensor of shape [n, dim]; res.data is a flat Float32Array.
      const data: Float32Array = res.data;
      for (let r = 0; r < slice.length; r++) {
        out.push(data.slice(r * this.dim, (r + 1) * this.dim));
      }
    }
    return out;
  }
}

export type ProviderKind = "local" | "transformers" | "ollama";

/**
 * Select an embedding provider. Env `COGRAFY_EMBED_PROVIDER` = local |
 * transformers | ollama (default: local, for zero-download startup). Returns a
 * provider plus a signature used to detect provider changes and re-embed.
 */
export async function createEmbeddingProvider(
  localDim: number,
  preferred?: ProviderKind,
): Promise<{ provider: EmbeddingProvider; signature: string }> {
  const kind = (process.env.COGRAFY_EMBED_PROVIDER ?? preferred ?? "local").toLowerCase() as ProviderKind;

  if (kind === "transformers") {
    try {
      const model = process.env.COGRAFY_EMBED_MODEL ?? "Xenova/all-MiniLM-L6-v2";
      const provider = new TransformersEmbeddingProvider(model, 384);
      // Warm-load to confirm availability; fall back if it throws.
      await provider.embed(["warmup"]);
      return { provider, signature: `transformers:${model}` };
    } catch {
      // fall through to local
    }
  }

  if (kind === "ollama") {
    const model = process.env.COGRAFY_EMBED_MODEL ?? "nomic-embed-text";
    const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
    try {
      const provider = new OllamaEmbeddingProvider(host, model);
      await provider.embed(["warmup"]);
      return { provider, signature: `ollama:${model}` };
    } catch {
      // fall through to local
    }
  }

  return { provider: new LocalEmbeddingProvider(localDim), signature: `local:${localDim}` };
}

/** Local Ollama daemon embeddings via /api/embed. */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly dim = 768;
  constructor(
    private host: string,
    private model: string,
  ) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    const res = await fetch(`${this.host}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const data = (await res.json()) as { embeddings: number[][] };
    return data.embeddings.map((v) => {
      const f = new Float32Array(v.length);
      let sum = 0;
      for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
      const norm = Math.sqrt(sum) || 1;
      for (let i = 0; i < v.length; i++) f[i] = v[i] / norm;
      return f;
    });
  }
}
