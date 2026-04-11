export interface OllamaHealthCacheOptions {
  healthUrl: string;
  cacheMs: number;
}

export class OllamaHealthCache {
  private lastCheckedAt = 0;
  private lastHealthy = false;

  constructor(private readonly options: OllamaHealthCacheOptions) {}

  async isHealthy(): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastCheckedAt < this.options.cacheMs) {
      return this.lastHealthy;
    }

    this.lastCheckedAt = now;
    try {
      const response = await fetch(this.options.healthUrl);
      this.lastHealthy = response.ok;
    } catch {
      this.lastHealthy = false;
    }

    return this.lastHealthy;
  }
}
