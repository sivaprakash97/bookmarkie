import type { Embedder } from '@/core/embed';
import type { WorkerRequest, WorkerResponse } from './embed.worker';
import EmbedWorker from './embed.worker.ts?worker';

export class ModelMissingError extends Error {}

/** Talks to the embedding worker; the worker and model load on first use. */
export class WorkerEmbedder implements Embedder {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new EmbedWorker();
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if ('vectors' in e.data) p.resolve(e.data.vectors);
      else p.reject(e.data.missingModel ? new ModelMissingError(e.data.error) : new Error(e.data.error));
    };
    worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'The AI model failed to load.'));
      this.pending.clear();
      this.dispose();
    };
    this.worker = worker;
    return worker;
  }

  embed(texts: string[]): Promise<Float32Array[]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ensureWorker().postMessage({ id, texts } satisfies WorkerRequest);
    });
  }

  /** Frees the model's memory (about 100 MB) when Clean up is done with it. */
  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
