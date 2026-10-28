type Embedding = number[];

/**
 * OpenAI-backed semantic similarity for the Context game. Both the secret and
 * guesses stay server-side; only short text inputs are sent to the embeddings
 * API. Embeddings are cached for the life of the process.
 */
export class SemanticRanker {
  private readonly cache = new Map<string, Promise<Embedding>>();
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model = "text-embedding-3-small") {
    this.apiKey = apiKey;
    this.model = model;
  }

  async similarity(target: string, guess: string): Promise<number> {
    const [targetVector, guessVector] = await Promise.all([this.embedding(target), this.embedding(guess)]);
    // The API returns normalized vectors, so their dot product is cosine similarity.
    let dot = 0;
    for (let i = 0; i < targetVector.length; i += 1) dot += targetVector[i]! * guessVector[i]!;
    return Math.max(-1, Math.min(1, dot));
  }

  private embedding(text: string): Promise<Embedding> {
    const normalized = text.trim().toLocaleLowerCase("en-US");
    let pending = this.cache.get(normalized);
    if (!pending) {
      pending = this.fetchEmbedding(normalized);
      this.cache.set(normalized, pending);
      pending.catch(() => this.cache.delete(normalized));
    }
    return pending;
  }

  private async fetchEmbedding(input: string): Promise<Embedding> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input, encoding_format: "float" }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Semantic AI request failed (${response.status}): ${detail.slice(0, 240)}`);
      }
      const data = await response.json() as { data?: Array<{ embedding?: number[] }> };
      const vector = data.data?.[0]?.embedding;
      if (!vector?.length || vector.some((value) => !Number.isFinite(value))) throw new Error("Semantic AI returned an invalid embedding.");
      return vector;
    } finally {
      clearTimeout(timeout);
    }
  }
}
