// Runs the embedding model off the main thread so the page stays responsive.
// Everything is loaded from inside the extension; nothing is fetched from the internet.
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { EMBED_MODEL } from '@/core/embed';

export type WorkerRequest = { id: number; texts: string[] };
export type WorkerResponse =
  | { id: number; vectors: Float32Array[] }
  | { id: number; error: string; missingModel?: boolean };

const origin = self.location.origin;
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = `${origin}/models/`;
env.useBrowserCache = false;
// Otherwise the runtime's loader is re-imported from a blob: URL, which the extension's CSP blocks.
env.useWasmCache = false;
const wasm = env.backends.onnx.wasm!;
wasm.wasmPaths = { mjs: `${origin}/ort/ort-wasm-simd-threaded.jsep.mjs`, wasm: `${origin}/ort/ort-wasm-simd-threaded.jsep.wasm` };
// Threads need cross-origin isolation, which extension pages don't have.
wasm.numThreads = 1;

let extractor: Promise<FeatureExtractionPipeline> | null = null;

async function exists(file: string): Promise<boolean> {
  try {
    return (await fetch(`${env.localModelPath}${EMBED_MODEL}/${file}`, { method: 'HEAD' })).ok;
  } catch {
    return false;
  }
}

async function load(): Promise<FeatureExtractionPipeline> {
  // The install script ships the small quantized model; a full-size copy also works.
  const dtype = (await exists('onnx/model_quantized.onnx')) ? 'q8' : (await exists('onnx/model.onnx')) ? 'fp32' : null;
  if (!dtype) throw Object.assign(new Error('The AI model is not installed.'), { missingModel: true });
  return pipeline('feature-extraction', EMBED_MODEL, { dtype, device: 'wasm', local_files_only: true });
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { id, texts } = e.data;
  try {
    extractor ??= load();
    const run = await extractor;
    const output = await run(texts, { pooling: 'mean', normalize: true });
    const [rows, dims] = output.dims as [number, number];
    const data = output.data as Float32Array;
    const vectors = Array.from({ length: rows }, (_, i) => data.slice(i * dims, (i + 1) * dims));
    self.postMessage({ id, vectors } satisfies WorkerResponse, { transfer: vectors.map((v) => v.buffer) });
  } catch (err) {
    extractor = null;
    const missingModel = !!(err as { missingModel?: boolean }).missingModel;
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err), missingModel } satisfies WorkerResponse);
  }
};
