// Dependency-free metadata extraction for AI-provenance signals.
// JPEG, PNG and WebP get proper parsers. Everything else (AVIF, HEIC, MP4, MOV,
// WebM, partial downloads) falls back to scanning the raw bytes.
//
// NOTE: C2PA manifests are parsed here, not cryptographically verified. If you
// need signature validation, add the official C2PA SDK (see README).

const UTF8 = new TextDecoder('utf-8', { fatal: false });
const LATIN1 = new TextDecoder('latin1', { fatal: false });

const XMP_NS = 'http://ns.adobe.com/xap/1.0/\0';
const MAX_TEXT = 50_000;
const MAX_SCAN = 32 * 1024 * 1024;

const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const uniq = (arr) => [...new Set(arr.filter(Boolean))];
const clip = (s, n = MAX_TEXT) => (s && s.length > n ? s.slice(0, n) + '…' : s);

function ascii(b, s, e) {
  let o = '';
  for (let i = s; i < e && i < b.length; i++) o += String.fromCharCode(b[i]);
  return o;
}

function startsWith(b, str, off = 0) {
  if (off + str.length > b.length) return false;
  for (let i = 0; i < str.length; i++) if (b[off + i] !== str.charCodeAt(i)) return false;
  return true;
}

export function sniffFormat(b) {
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  if (startsWith(b, '\x89PNG')) return 'png';
  if (startsWith(b, 'RIFF') && startsWith(b, 'WEBP', 8)) return 'webp';
  if (startsWith(b, 'GIF8')) return 'gif';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (startsWith(b, 'ftyp', 4)) {
    const brand = ascii(b, 8, 12);
    if (/^avi[fs]/.test(brand)) return 'avif';
    if (/^(hei[cx]|mif1|msf1)/.test(brand)) return 'heic';
    if (/^qt/.test(brand)) return 'mov';
    return 'mp4';
  }
  return 'unknown';
}

/**
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {{partial?: boolean}} [opts] partial = bytes are head/tail fragments of a larger file
 */
export async function extractMetadata(bytes, opts = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const md = {
    format: sniffFormat(b),
    bytesRead: b.length,
    partial: !!opts.partial,
    exif: {},
    xmp: null,
    xmpFields: {},
    text: {},
    comment: null,
    c2pa: null,
    warnings: [],
  };
  const jumbf = [];

  try {
    if (md.format === 'jpeg') parseJpeg(b, md, jumbf);
    else if (md.format === 'png') await parsePng(b, md, jumbf);
    else if (md.format === 'webp') parseWebp(b, md, jumbf);
  } catch (e) {
    md.warnings.push(`parse error: ${e.message}`);
  }

  // Generic byte scans for containers we don't parse (video, AVIF, HEIC) and
  // anything the structured parsers missed.
  let latin = null;
  const scanStr = () => (latin ??= LATIN1.decode(b.length > MAX_SCAN ? b.subarray(0, MAX_SCAN) : b));
  if (!md.xmp) md.xmp = scanXmp(b, scanStr());
  if (!jumbf.length) {
    const j = scanJumbf(b, scanStr());
    if (j) jumbf.push(j);
  }
  if (jumbf.length) md.c2pa = parseC2pa(concat(jumbf));
  if (md.xmp) {
    md.xmpFields = parseXmp(md.xmp);
    md.xmp = clip(md.xmp, 20_000);
  }
  if (md.format === 'mp4' || md.format === 'mov') md.encoder = scanMp4Encoder(scanStr());
  return md;
}

// ---------------------------------------------------------------- JPEG

function parseJpeg(b, md, jumbf) {
  const n = b.length;
  let i = 2;
  while (i + 4 <= n) {
    if (b[i] !== 0xff) break;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m === 0xda || m === 0xd9) break; // start of scan / end of image
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) break;
    const seg = b.subarray(i + 4, Math.min(n, i + 2 + len));
    if (m === 0xe1) {
      if (startsWith(seg, 'Exif\0\0')) Object.assign(md.exif, parseTiff(seg.subarray(6)));
      else if (startsWith(seg, XMP_NS) && !md.xmp) md.xmp = UTF8.decode(seg.subarray(XMP_NS.length));
    } else if (m === 0xeb && startsWith(seg, 'JP') && seg.length > 16) {
      // JPEG-XT box: CI(2) En(2) Z(4) then box; continuation segments repeat LBox+TBox.
      const seq = u32be(seg, 4);
      jumbf.push(seq <= 1 ? seg.subarray(8) : seg.subarray(16));
    } else if (m === 0xfe) {
      md.comment = clip(UTF8.decode(seg).replace(/\0+$/, ''), 2000);
    }
    i += 2 + len;
  }
}

// ---------------------------------------------------------------- TIFF / EXIF

const IFD0 = {
  0x010e: 'ImageDescription', 0x010f: 'Make', 0x0110: 'Model', 0x0131: 'Software',
  0x0132: 'DateTime', 0x013b: 'Artist', 0x8298: 'Copyright',
};
const EXIF_IFD = {
  0x9003: 'DateTimeOriginal', 0x9286: 'UserComment', 0xa430: 'CameraOwnerName',
  0xa433: 'LensMake', 0xa434: 'LensModel',
};

export function parseTiff(t) {
  const out = {};
  if (t.length < 8) return out;
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return out;
  const u16 = (o) => (o + 2 > t.length ? 0 : le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]);
  const u32 = (o) => (o + 4 > t.length ? 0 : le ? u32le(t, o) : u32be(t, o));
  const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 7: 1 };

  const readIfd = (off, names, depth) => {
    if (!off || off + 2 > t.length || depth > 2) return;
    const count = Math.min(u16(off), 512);
    for (let k = 0; k < count; k++) {
      const e = off + 2 + k * 12;
      if (e + 12 > t.length) break;
      const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
      if (tag === 0x8769) { readIfd(u32(e + 8), EXIF_IFD, depth + 1); continue; }
      const name = names[tag];
      if (!name || !SIZES[type]) continue;
      if (type === 3) { out[name] = u16(e + 8); continue; }
      if (type === 4) { out[name] = u32(e + 8); continue; }
      const size = cnt * SIZES[type];
      const vo = size <= 4 ? e + 8 : u32(e + 8);
      if (vo + size > t.length || size > MAX_TEXT * 2) continue;
      const raw = t.subarray(vo, vo + size);
      const val = name === 'UserComment' ? decodeUserComment(raw) : UTF8.decode(raw).replace(/\0+$/, '').trim();
      if (val) out[name] = clip(val);
    }
  };
  readIfd(u32(4), IFD0, 0);
  return out;
}

function decodeUserComment(raw) {
  if (raw.length < 8) return '';
  const prefix = ascii(raw, 0, 8);
  const body = raw.subarray(8);
  let s;
  if (prefix.startsWith('UNICODE')) {
    // Writers disagree on byte order, so take whichever decodes to more ASCII.
    const be = new TextDecoder('utf-16be').decode(body);
    const le = new TextDecoder('utf-16le').decode(body);
    const asciiCount = (x) => (x.slice(0, 200).match(/[\x20-\x7e]/g) || []).length;
    s = asciiCount(be) >= asciiCount(le) ? be : le;
  } else {
    s = UTF8.decode(body);
  }
  return s.replace(/\0+/g, '').trim();
}

// ---------------------------------------------------------------- PNG

async function parsePng(b, md, jumbf) {
  let i = 8;
  while (i + 12 <= b.length) {
    const len = u32be(b, i);
    const type = ascii(b, i + 4, i + 8);
    const ds = i + 8, de = ds + len;
    if (de > b.length) break;
    const d = b.subarray(ds, de);
    switch (type) {
      case 'tEXt': {
        const z = d.indexOf(0);
        if (z > 0) md.text[LATIN1.decode(d.subarray(0, z))] = clip(LATIN1.decode(d.subarray(z + 1)));
        break;
      }
      case 'zTXt': {
        const z = d.indexOf(0);
        if (z > 0) {
          try { md.text[LATIN1.decode(d.subarray(0, z))] = clip(LATIN1.decode(await inflate(d.subarray(z + 2)))); }
          catch { md.warnings.push('bad zTXt chunk'); }
        }
        break;
      }
      case 'iTXt': {
        const z = d.indexOf(0);
        if (z <= 0) break;
        const key = LATIN1.decode(d.subarray(0, z));
        const compressed = d[z + 1] === 1;
        const z2 = d.indexOf(0, z + 3);            // end of language tag
        const z3 = z2 < 0 ? -1 : d.indexOf(0, z2 + 1); // end of translated keyword
        if (z3 < 0) break;
        let body = d.subarray(z3 + 1);
        if (compressed) {
          try { body = await inflate(body); } catch { md.warnings.push('bad iTXt chunk'); break; }
        }
        const text = UTF8.decode(body);
        if (key === 'XML:com.adobe.xmp') md.xmp ??= text;
        else md.text[key] = clip(text);
        break;
      }
      case 'eXIf': Object.assign(md.exif, parseTiff(d)); break;
      case 'caBX': jumbf.push(d); break;
      case 'IEND': return;
    }
    i = de + 4; // skip CRC
  }
}

async function inflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------------------------------------------------------------- WebP

function parseWebp(b, md, jumbf) {
  let i = 12;
  while (i + 8 <= b.length) {
    const id = ascii(b, i, i + 4);
    const len = u32le(b, i + 4);
    const d = b.subarray(i + 8, Math.min(b.length, i + 8 + len));
    if (id === 'EXIF') Object.assign(md.exif, parseTiff(startsWith(d, 'Exif\0\0') ? d.subarray(6) : d));
    else if (id === 'XMP ') md.xmp ??= UTF8.decode(d);
    else if (id === 'C2PA') jumbf.push(d);
    i += 8 + len + (len & 1);
  }
}

// ---------------------------------------------------------------- Generic scans

function scanXmp(b, s) {
  const start = s.indexOf('<x:xmpmeta');
  if (start < 0) return null;
  const endTag = '</x:xmpmeta>';
  const end = s.indexOf(endTag, start);
  if (end < 0) return null;
  return UTF8.decode(b.subarray(start, end + endTag.length));
}

/** Find a C2PA JUMBF superbox: [LBox]['jumb'][LBox]['jumd'][uuid 16][toggles][label "c2pa"] */
function scanJumbf(b, s) {
  let idx = s.indexOf('jumd');
  while (idx >= 0) {
    const start = idx - 12;
    if (start >= 0 && s.slice(start + 4, start + 8) === 'jumb' && s.slice(idx, idx + 64).includes('c2pa')) {
      const len = u32be(b, start);
      const end = len > 8 ? Math.min(b.length, start + len) : b.length;
      return b.subarray(start, end);
    }
    idx = s.indexOf('jumd', idx + 4);
  }
  return null;
}

function scanMp4Encoder(s) {
  // ©too / ©swr atoms carry the encoder/tool name in many MP4/MOV files.
  const m = s.match(/\xa9(?:too|swr)[\s\S]{0,20}?data[\s\S]{8}([\x20-\x7e]{2,120})/);
  return m ? m[1].trim() : null;
}

function concat(parts) {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------------------------------------------------------------- C2PA (best-effort parse)

// IPTC Digital Source Type vocabulary. We match an explicit list because C2PA
// stores strings as length-prefixed CBOR with no terminator. A greedy [A-Za-z]+
// would swallow the next CBOR header byte, since 0x61 to 0x7a are letters.
const SOURCE_TYPE_RE = /digitalsourcetype\/(compositeWithTrainedAlgorithmicMedia|trainedAlgorithmicMedia|algorithmicallyEnhanced|algorithmicMedia|compositeSynthetic|compositeCapture|computationalCapture|digitalCapture|digitalArt|dataDrivenMedia|minorHumanEdits|humanEdits|negativeFilm|positiveFilm|print|screenCapture|virtualRecording|composite)/gi;
const sourceTypes = (s) => uniq([...s.matchAll(SOURCE_TYPE_RE)].map((m) => m[1]));

const C2PA_ACTIONS =/c2pa\.(created|edited|opened|placed|converted|cropped|resized|filtered|color_adjustments|drawing|orientation|transcoded|repackaged|published|removed|redacted|produced|watermarked|unknown)\b/g;

function readCborText(b, o) {
  const hd = b[o];
  let len;
  if (hd >= 0x60 && hd <= 0x77) { len = hd - 0x60; o += 1; }
  else if (hd === 0x78) { len = b[o + 1]; o += 2; }
  else if (hd === 0x79) { len = (b[o + 1] << 8) | b[o + 2]; o += 3; }
  else return null;
  if (o + len > b.length) return null;
  return UTF8.decode(b.subarray(o, o + len));
}

/** Pull X.509 attribute strings (e.g. O = 2.5.4.10, CN = 2.5.4.3) out of embedded DER certificates. */
function derStrings(b, oidLast) {
  const out = [];
  for (let i = 0; i + 7 < b.length; i++) {
    if (b[i] === 0x06 && b[i + 1] === 0x03 && b[i + 2] === 0x55 && b[i + 3] === 0x04 && b[i + 4] === oidLast) {
      const tag = b[i + 5], len = b[i + 6];
      if ((tag === 0x0c || tag === 0x13 || tag === 0x16 || tag === 0x14) && len < 128 && i + 7 + len <= b.length) {
        out.push(UTF8.decode(b.subarray(i + 7, i + 7 + len)));
      }
    }
  }
  return uniq(out);
}

export function parseC2pa(buf) {
  const s = LATIN1.decode(buf);
  const out = {
    present: true,
    manifestBytes: buf.length,
    claimGenerator: null,
    generatorInfo: [],
    sourceTypes: sourceTypes(s),
    actions: uniq([...s.matchAll(C2PA_ACTIONS)].map((m) => m[0])),
    certOrganizations: derStrings(buf, 0x0a),
    certCommonNames: derStrings(buf, 0x03),
    signatureVerified: false,
  };
  const KEY = 'claim_generator';
  let i = s.indexOf(KEY);
  while (i >= 0) {
    const after = i + KEY.length;
    if (s.startsWith('_info', after)) {
      const n = s.indexOf('name', after);
      if (n >= 0 && n - after < 64) {
        const v = readCborText(buf, n + 4);
        if (v) out.generatorInfo.push(v);
      }
    } else if (!out.claimGenerator) {
      out.claimGenerator = readCborText(buf, after);
    }
    i = s.indexOf(KEY, after);
  }
  out.generatorInfo = uniq(out.generatorInfo);
  return out;
}

// ---------------------------------------------------------------- XMP

const XMP_FIELDS = {
  CreatorTool: 'xmp:CreatorTool',
  Credit: 'photoshop:Credit',
  Source: 'photoshop:Source',
  Creator: 'dc:creator',
  Title: 'dc:title',
  Description: 'dc:description',
  CreateDate: 'xmp:CreateDate',
  Make: 'tiff:Make',
  Model: 'tiff:Model',
};

function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function xmpField(x, name) {
  let m = x.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`));
  if (m) return decodeEntities(m[1]).trim() || null;
  m = x.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  if (m) {
    const t = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return t ? decodeEntities(t) : null;
  }
  m = x.match(new RegExp(`<${name}\\s[^>]*rdf:resource="([^"]*)"`));
  return m ? m[1] : null;
}

export function parseXmp(x) {
  const out = {};
  for (const [k, tag] of Object.entries(XMP_FIELDS)) {
    const v = xmpField(x, tag);
    if (v) out[k] = clip(v, 2000);
  }
  out.sourceTypes = sourceTypes(x);
  out.softwareAgents = uniq([...x.matchAll(/stEvt:softwareAgent\s*=\s*"([^"]*)"/g)].map((m) => decodeEntities(m[1])));
  return out;
}
