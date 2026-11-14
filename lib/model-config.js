// Config for the visual AI-image classifier. The offscreen runner, the setup
// script and the Node evaluation script all read it.
//
// Model: haywoodsloan/ai-image-detector-deploy, a SwinV2-base fine-tuned on
// real vs AI images, Apache-2.0. The ONNX export is by SoldadoXara. We pin it
// to a commit so the weights can't change underneath us.

export const MODEL = {
  name: 'SwinV2 AI-image detector (haywoodsloan)',
  license: 'Apache-2.0',
  repo: 'SoldadoXara/ai-image-detector-deploy-ONNX',
  revision: '0df8696b5db0ab5bd72baeab571fec55d65128e7',
  variants: {
    fp16: { file: 'onnx/model_fp16.onnx', approxMB: 393 },   // WebGPU with shader-f16; matches PyTorch closely
    uint8: { file: 'onnx/model_uint8.onnx', approxMB: 199 }, // WASM/CPU fallback; small drift near threshold
  },
  localDir: 'models/ai-image-detector', // optional bundled copy (npm run setup -- --model=…)
  inputName: 'pixel_values',
  outputName: 'logits',
  size: 256,
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
  aiIndex: 0, // id2label: { 0: 'artificial', 1: 'real' }
  minSide: 160, // too small to classify reliably, so skip them
};

export const remoteUrl = (variant) =>
  `https://huggingface.co/${MODEL.repo}/resolve/${MODEL.revision}/${MODEL.variants[variant].file}`;

export const localPath = (variant) => `${MODEL.localDir}/${MODEL.variants[variant].file.split('/').pop()}`;
