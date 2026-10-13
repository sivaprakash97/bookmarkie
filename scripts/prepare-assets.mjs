// Puts the on-device AI files into public/ so they ship inside the extension:
//  - the ONNX WebAssembly runtime, copied from node_modules (Transformers.js would
//    otherwise fetch it from a CDN at runtime)
//  - the all-MiniLM-L6-v2 embedding model (~23 MB), downloaded once from Hugging Face.
// Never fails the install: without the model, only the "not about my topics" cleanup is off.
//
// BOOKMARKIE_MODEL_SRC=/path/to/Xenova/all-MiniLM-L6-v2 copies the model from a local folder instead.
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const MODEL = 'Xenova/all-MiniLM-L6-v2';
const modelDir = path.join(root, 'public/models', MODEL);
const ortDir = path.join(root, 'public/ort');

const ORT_FILES = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];
const MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];

async function nonEmpty(file) {
  try {
    return (await stat(file)).size > 0;
  } catch {
    return false;
  }
}

async function copyOrt() {
  const candidates = [
    'node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist',
    'node_modules/onnxruntime-web/dist',
  ].map((p) => path.join(root, p));
  const src = candidates.find((d) => existsSync(path.join(d, ORT_FILES[1])));
  if (!src) throw new Error('onnxruntime-web is not installed; run npm install');
  await mkdir(ortDir, { recursive: true });
  for (const f of ORT_FILES) await copyFile(path.join(src, f), path.join(ortDir, f));
}

async function getModel() {
  const local = process.env.BOOKMARKIE_MODEL_SRC;
  if (local) {
    for (const f of [...MODEL_FILES, 'onnx/model.onnx']) {
      if (!existsSync(path.join(local, f))) continue;
      await mkdir(path.dirname(path.join(modelDir, f)), { recursive: true });
      await copyFile(path.join(local, f), path.join(modelDir, f));
    }
    return;
  }
  for (const f of MODEL_FILES) {
    const dest = path.join(modelDir, f);
    if (await nonEmpty(dest)) continue;
    const url = `https://huggingface.co/${MODEL}/resolve/main/${f}`;
    process.stdout.write(`bookmarkie: downloading ${f}… `);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    console.log('done');
  }
}

try {
  await copyOrt();
} catch (err) {
  console.warn(`bookmarkie: couldn't copy the AI runtime: ${err.message}`);
}
try {
  await getModel();
} catch (err) {
  console.warn(
    `\nbookmarkie: couldn't download the AI model (${err.message}).\n` +
      'Everything else works. Connect to the internet and run "npm run build" again to enable topic cleanup.\n',
  );
}
