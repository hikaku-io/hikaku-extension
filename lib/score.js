// Metadata weights rank signals; they aren't probabilities. Keep file
// declarations separate from the model's estimate.

// IPTC Digital Source Type vocabulary (used by both IPTC/XMP and C2PA).
const SOURCE_TYPES = {
  trainedalgorithmicmedia: { kind: 'ai', strength: 0.97, label: 'AI-generated' },
  compositewithtrainedalgorithmicmedia: { kind: 'ai-edited', strength: 0.9, label: 'Edited with generative AI' },
  algorithmicmedia: { kind: 'ai', strength: 0.6, label: 'Algorithmically generated' },
  compositesynthetic: { kind: 'ai-edited', strength: 0.6, label: 'Composite with synthetic elements' },
  digitalcapture: { kind: 'capture', label: 'Captured by a camera' },
  computationalcapture: { kind: 'capture', label: 'Computational camera capture' },
  negativefilm: { kind: 'capture', label: 'Scanned film negative' },
  positivefilm: { kind: 'capture', label: 'Scanned film' },
  print: { kind: 'capture', label: 'Scanned print' },
  minorhumanedits: { kind: 'capture', label: 'Capture with minor human edits' },
  compositecapture: { kind: 'capture', label: 'Composite of captures' },
  humanedits: { kind: 'info', label: 'Human-edited' },
  digitalart: { kind: 'info', label: 'Human-made digital art' },
  datadrivenmedia: { kind: 'info', label: 'Data-driven media' },
};

// Matched only against *tool/generator* fields (never free-text descriptions or
// artist names) to avoid flagging e.g. a photo captioned "OpenAI's office".
export const GENERATOR_RE = /\b(midjourney|dall[\s·-]?e|openai|chatgpt|gpt[\s-]?image|sora|adobe firefly|firefly|stable[\s_-]?diffusion|sdxl|comfyui|automatic1111|invokeai|novelai|leonardo\.ai|ideogram|imagen|gemini|google ai|nano[\s-]?banana|black forest labs|flux(?:\.1)?|krea|playground ?ai|runwayml|dreamstudio|nightcafe|bing image creator|image creator from microsoft|grok|recraft|seedream|dreamina|kling|hailuo|pixverse|meta ai|imagine with meta|craiyon)\b/i;

// Visual-model thresholds on P(AI). They lean toward precision, since a false
// "AI" flag on a real photo is worse than a miss. Recalibrate on your own eval set.
export const CLASSIFIER = { likely: 0.9, uncertain: 0.7 };

const AI_PHRASE_RE = /\b(made|created|generated|edited)\s+(with|by|using)\s+(?:[\w.]+\s+){0,3}ai\b|\bai[-\s]generated\b/i;

const truncate = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

export function evaluate(md, classifier = null) {
  const signals = [];
  const add = (s) => {
    if (!signals.some((x) => x.label === s.label && x.source === s.source)) signals.push({ strength: 0, ...s });
  };
  const addSourceType = (t, source, prefix, bonus) => {
    const st = SOURCE_TYPES[t.toLowerCase()];
    if (!st) return;
    const scored = st.kind === 'ai' || st.kind === 'ai-edited';
    add({
      source, kind: st.kind,
      strength: scored ? Math.min(0.99, st.strength + bonus) : 0,
      label: `${prefix}: ${st.label}`,
      declaration: scored,
      detail: `digitalSourceType = ${t}`,
    });
  };

  // 1. C2PA Content Credentials
  const c = md.c2pa;
  if (c) {
    for (const t of c.sourceTypes) addSourceType(t, 'c2pa', 'Content Credentials', 0.01);
    for (const g of uniq([c.claimGenerator, ...c.generatorInfo])) {
      const m = g.match(GENERATOR_RE);
      if (m) add({ source: 'c2pa', kind: 'ai', strength: 0.85, declaration: true, label: `Content Credentials generator: ${m[0]}`, detail: g });
    }
    if (!signals.some((s) => s.source === 'c2pa')) {
      add({ source: 'c2pa', kind: 'info', label: 'Content Credentials present (no AI declaration)', detail: c.claimGenerator || '' });
    }
  }

  // 2. IPTC / XMP
  const xf = md.xmpFields || {};
  for (const t of xf.sourceTypes || []) addSourceType(t, 'xmp', 'IPTC source type', -0.02);

  // 3. Tool / generator names in tool fields
  const toolFields = [
    ['XMP CreatorTool', xf.CreatorTool, 'xmp'],
    ...(xf.softwareAgents || []).map((a) => ['XMP edit history', a, 'xmp']),
    ['EXIF Software', md.exif?.Software, 'exif'],
    ['EXIF Make', md.exif?.Make, 'exif'],
    ['EXIF Model', md.exif?.Model, 'exif'],
    ['PNG Software', md.text?.Software, 'png'],
    ['PNG Source', md.text?.Source, 'png'],
    ['Video encoder tag', md.encoder, 'video'],
  ];
  for (const [where, val, source] of toolFields) {
    if (typeof val !== 'string') continue;
    const m = val.match(GENERATOR_RE);
    if (m) add({ source, kind: 'ai', strength: 0.85, declaration: true, label: `${m[0]} named in ${where}`, detail: truncate(val, 160) });
  }

  // 4. Self-declared "AI generated" phrases (e.g. Google's "Made with Google AI" credit)
  const phraseFields = [
    ['XMP Credit', xf.Credit, 'xmp'],
    ['PNG Title', md.text?.Title, 'png'],
    ['PNG Description', md.text?.Description, 'png'],
    ['EXIF ImageDescription', md.exif?.ImageDescription, 'exif'],
  ];
  for (const [where, val, source] of phraseFields) {
    if (typeof val === 'string' && AI_PHRASE_RE.test(val)) {
      add({ source, kind: 'ai', strength: where === 'XMP Credit' ? 0.93 : 0.75, label: `AI declared in ${where}`, detail: truncate(val, 160) });
    }
  }

  // 5. Embedded generation parameters from local diffusion tools
  const params = md.text?.parameters || md.exif?.UserComment;
  if (typeof params === 'string' && /\bSteps:\s*\d+/.test(params) && /\b(Sampler|CFG scale|Seed):/.test(params)) {
    add({ source: md.text?.parameters ? 'png' : 'exif', kind: 'ai', strength: 0.95, label: 'Stable Diffusion generation parameters embedded', detail: truncate(params, 200) });
  }
  const comfy = md.text?.prompt || md.text?.workflow;
  if (typeof comfy === 'string' && /"class_type"|"nodes"\s*:/.test(comfy)) {
    add({ source: 'png', kind: 'ai', strength: 0.95, declaration: true, label: 'ComfyUI workflow embedded', detail: truncate(comfy, 200) });
  }
  if (md.text?.invokeai_metadata || md.text?.['sd-metadata'] || md.text?.Dream) {
    add({ source: 'png', kind: 'ai', strength: 0.93, label: 'InvokeAI generation metadata embedded' });
  }
  if (typeof md.text?.Comment === 'string' && /"(steps|sampler|uc|scale|n_samples)"\s*:/.test(md.text.Comment)) {
    add({ source: 'png', kind: 'ai', strength: 0.9, label: 'Diffusion settings embedded in PNG comment', detail: truncate(md.text.Comment, 200) });
  }

  // 6. Visual classifier. Weaker evidence than provenance: on its own it can
  // only reach "likely AI", and only above a high threshold.
  const validScore = (c) => c?.status === 'ok' && Number.isFinite(c.score) && c.score >= 0 && c.score <= 1 ? c.score : null;
  const primary = validScore(classifier), secondary = validScore(classifier?.secondary);
  const p = primary;
  if (p != null) {
    add({
      source: 'classifier',
      kind: p >= CLASSIFIER.uncertain ? 'ai' : 'info',
      strength: p >= CLASSIFIER.uncertain ? p * 0.9 : 0,
      label: `Visual model: ${Math.round(p * 100)}% AI-like${classifier.frames ? ` (${classifier.frames} ${classifier.animated ? 'animation' : 'video'} frames)` : ''}`,
      detail: [classifier.model, classifier.variant && `${classifier.variant} on ${classifier.backend}`, classifier.inferenceMs != null && `${classifier.inferenceMs} ms`].filter(Boolean).join(' · '),
    });
  }

  if (secondary != null) add({
    source: 'secondary-classifier', kind: secondary >= CLASSIFIER.uncertain ? 'ai' : 'info',
    strength: secondary >= CLASSIFIER.uncertain ? secondary * 0.9 : 0,
    label: `Second model: ${Math.round(secondary * 100)}% AI-like (uncalibrated score)`,
    detail: classifier.secondary.model,
  });

  // EXIF, XMP and C2PA often repeat the same claim. Count the strongest one
  // instead of adding them up. Model scores don't tell us an image's edit history.
  const ai = signals.filter((s) => s.kind === 'ai' || s.kind === 'ai-edited');
  const metadataSignals = ai.filter((s) => !['classifier', 'secondary-classifier'].includes(s.source));
  const strongest = Math.max(0, ...metadataSignals.map((s) => s.strength));
  const declarations = metadataSignals.filter((s) => s.strength >= 0.85);
  const modelScore = primary != null || secondary != null ? Math.max(primary ?? 0, secondary ?? 0) : null;
  const score = declarations.length ? strongest : modelScore != null ? modelScore : strongest;
  let verdict;
  if (declarations.length) verdict = declarations.some((s) => s.kind === 'ai-edited') ? 'ai-edited' : 'ai';
  else if (modelScore >= CLASSIFIER.likely || strongest >= 0.6) verdict = 'likely-ai';
  else if (modelScore >= CLASSIFIER.uncertain) verdict = 'uncertain';
  else if (!ai.length) verdict = signals.some((s) => s.kind === 'capture') ? 'captured' : 'none';
  else verdict = 'uncertain';

  signals.sort((a, b) => b.strength - a.strength);
  return {
    verdict, score: Math.round(score * 100) / 100, signals,
    evidence: declarations.length ? 'metadata-declaration' : modelScore != null ? 'model-estimate' : 'metadata-only',
    // The lightweight parser does not verify signatures or asset binding.
    verified: false,
  };
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}
