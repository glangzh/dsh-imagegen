// dsh-imagegen (host half) — global image generation & understanding tools for dsh.
//
// Registers two model-facing tools:
//   · imagegen          — text2img / img2img / compose image generation & editing
//   · image_understand  — describe/analyze images through a multimodal chat model
//
// The implementation is PROVIDER-AGNOSTIC: every provider-specific value comes
// from configuration (row `config:` + the credentials domain + environment),
// with Agnes AI (OpenAI-compatible) as the default. To use another provider,
// point `apiBase` at its OpenAI-compatible endpoint and set its models/key ref.
//
// Configuration precedence (first match wins):
//   1. credentials service (Web UI settings tab writes the managed document)
//        · <apiKeyRef>  — API key (default ref IMAGE_API_KEY)
//        · <baseUrlRef> — API root, e.g. https://api.agnes-ai.cn/v1 (default IMAGE_API_BASE)
//   2. this row's `config:`                    — apiBase / models / key refs / outputDir
//   3. environment                             — IMAGE_API_KEY, IMAGE_API_BASE (+ AGNES_* legacy)
//   4. built-in defaults                       — Agnes AI CN node, 2.1 image model
//
// Notes:
//   · apiBase accepts both "https://host" and "https://host/v1" (normalized).
//   · The api-proxy only exposes settings namespaces on a hardcoded allowlist
//     (WEB_SETTINGS_NAMESPACES in @deepseek-ai/dsh-host-apiproxy), so plugin
//     namespaces are invisible to the Web client; secrets go through the
//     credentials domain instead.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import z from '@deepseek-ai/schemastery';

export const name = 'dsh-imagegen';
export const inject = ['tools', 'credentials', 'settings', 'llm'];

const DEFAULT_API_BASE = 'https://api.agnes-ai.cn';
const DEFAULT_API_KEY_REF = 'IMAGE_API_KEY';
const DEFAULT_BASE_URL_REF = 'IMAGE_API_BASE';
const DEFAULT_IMAGE_MODEL = 'agnes-image-2.1-flash';
const DEFAULT_VISION_MODEL = 'agnes-2.5-flash';
const DEFAULT_TRANSLATE_MODEL = 'agnes-2.5-flash';
/** Settings namespace holding the NON-SECRET provider configuration, so the
 * Web UI can display and edit real values (like the built-in plugin cards).
 * The API key itself stays in the credentials domain; `apiKeyEnv` names the ref. */
const CONFIG_NS = 'imagegen';
const CONFIG_PROVIDER = 'imagegen';
const MODES = ['text2img', 'img2img', 'compose'];
const SIZE_TIERS = ['1K', '2K', '3K', '4K'];
const LEGACY_SIZES = ['1024x768', '1024x1024', '768x1024'];
const RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'];
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

export function apply(ctx, config = {}) {
  // Normalize the API root so both "https://host" and "https://host/v1" (the
  // official docs' Base URL form) work: strip a trailing "/v1" and slashes,
  // then every endpoint below appends "/v1/...".
  function normalizeBase(value) {
    return String(value || '').replace(/\/v1\/?$/i, '').replace(/\/+$/, '');
  }

  // ── settings namespace + provider exposure (Web UI can display real values) ─
  const settings = ctx.get('settings');
  const llm = ctx.get('llm');
  if (settings && typeof settings.register === 'function') {
    try {
      settings.register(CONFIG_NS, z.object({
        // Credential ref holding the API key (value stays in credentials).
        apiKeyEnv: z.string().default(DEFAULT_API_KEY_REF),
        baseUrl: z.string().default(''),
        imageModel: z.string().default(''),
        visionModel: z.string().default(''),
        translateModel: z.string().default(''),
        outputDir: z.string().default(''),
        autoTranslate: z.boolean().default(false),
        // Display-only: host-maintained asterisk mask matching the real key
        // length, so the UI can show a truthful placeholder without exposing
        // the secret value.
        apiKeyMask: z.string().default(''),
        // Keeps the Models page (which lists configurable providers) calm.
        models: z.array(z.object({ id: z.string() })).default([]),
      }));
    } catch (e) {
      console.error('[imagegen] settings namespace registration failed:', (e && e.message) || e);
    }
  }
  // Expose the namespace to the Web client: the api-proxy only serves
  // namespaces owned by configurable providers (or its hardcoded allowlist),
  // so the `imagegen` namespace rides this seam. The entry is dormant (no
  // adapter route), so it never appears in model selection.
  if (llm && typeof llm.registerConfigurableProviders === 'function') {
    try {
      llm.registerConfigurableProviders([{
        provider: CONFIG_PROVIDER,
        displayName: '图像生成（imagegen）',
        settingsNs: CONFIG_NS,
        settingsPath: [],
      }]);
    } catch (e) {
      console.error('[imagegen] configurable-provider registration failed:', (e && e.message) || e);
    }
  }
  // One-time bootstrap: when the namespace has no user overrides yet, seed it
  // with the effective non-secret values so the form shows the truth (e.g. the
  // configured base URL) instead of blanks.
  if (settings && typeof settings.describe === 'function') {
    try {
      const desc = settings.describe({ redact: false }).find((d) => d.ns === CONFIG_NS);
      const userKeys = desc && desc.user ? Object.keys(desc.user).filter((k) => k !== 'apiKeyMask') : [];
      if (desc && userKeys.length === 0 && typeof settings.update === 'function') {
        const seed = {
          baseUrl: config.apiBase || process.env[config.baseUrlRef || DEFAULT_BASE_URL_REF] || DEFAULT_API_BASE,
          imageModel: config.imageModel || DEFAULT_IMAGE_MODEL,
          visionModel: config.visionModel || DEFAULT_VISION_MODEL,
          translateModel: config.translateModel || DEFAULT_TRANSLATE_MODEL,
          outputDir: config.outputDir || 'generated_images',
          autoTranslate: config.autoTranslate !== false,
        };
        settings.update(CONFIG_NS, seed).catch((e) => {
          console.error('[imagegen] config seed failed:', (e && e.message) || e);
        });
      }
    } catch (e) {
      console.error('[imagegen] config seed check failed:', (e && e.message) || e);
    }
  }
  // Keep the API-key mask in sync with the real key length (value never
  // leaves the host). Refresh on boot and whenever the credential changes.
  async function refreshKeyMask() {
    try {
      const s = settings && typeof settings.get === 'function' ? settings.get(CONFIG_NS) : undefined;
      const ref = (s && s.apiKeyEnv) || config.apiKeyRef || DEFAULT_API_KEY_REF;
      const key = await ctx.credentials.resolve(ref);
      const mask = key && key.value ? '*'.repeat(key.value.length) : '';
      if (mask !== (s && s.apiKeyMask)) {
        await settings.update(CONFIG_NS, { apiKeyMask: mask });
      }
    } catch (e) {
      // Mask is cosmetic; a failure must never disturb the tool.
    }
  }
  if (settings && typeof settings.update === 'function' && ctx.on) {
    ctx.on('credentials/updated', () => { refreshKeyMask(); });
    refreshKeyMask();
  }

  async function chatTranslate(text, signal, apiKey, base, translateModel) {
    const res = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: translateModel,
        messages: [
          { role: 'system', content: 'Translate the user message into English. Reply with ONLY the translation, no quotes and no explanation.' },
          { role: 'user', content: text },
        ],
        temperature: 0.2,
        max_tokens: 1024,
      }),
      signal,
    });
    if (!res.ok) throw new Error('translation failed: HTTP ' + res.status);
    const data = await res.json();
    const out = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!out) throw new Error('translation returned no content');
    return String(out).trim();
  }

  async function visionChat(images, prompt, signal, apiKey, base, model) {
    // images: array of data URIs or public URLs; the vision model is multimodal.
    const content = images.map((uri) => ({ type: 'image_url', image_url: { url: uri } }));
    content.push({ type: 'text', text: prompt });
    const res = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        temperature: 0.3,
        max_tokens: 4096,
      }),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error('image understanding API error ' + res.status + ': ' + text.slice(0, 500));
    }
    const data = await res.json();
    const out = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!out) throw new Error('image understanding API returned no content');
    return String(out).trim();
  }

  async function toDataUri(input, cwd) {
    if (/^https?:\/\//i.test(input) || /^data:/i.test(input)) return input;
    const p = isAbsolute(input) ? input : resolve(cwd, input);
    const buf = await readFile(p);
    const ext = extname(p).toLowerCase();
    return 'data:' + (MIME[ext] || 'image/png') + ';base64,' + buf.toString('base64');
  }

  async function saveImage(buffer, wanted) {
    const ext = extname(wanted) || '.png';
    const stem = wanted.slice(0, wanted.length - ext.length);
    for (let n = 0; ; n += 1) {
      const candidate = n === 0 ? wanted : stem + '-' + n + ext;
      try {
        await writeFile(candidate, buffer, { flag: 'wx' });
        return candidate;
      } catch (e) {
        if (!e || e.code !== 'EEXIST') throw e;
      }
    }
  }

  // Resolve the active provider configuration (read fresh on every call so
  // UI/credentials changes apply without a restart). The settings namespace
  // (user-editable in the Web UI) leads for non-secret values; the API key
  // resolves from the credentials domain through the namespace-declared ref.
  async function resolved() {
    const s = settings && typeof settings.get === 'function' ? settings.get(CONFIG_NS) : undefined;
    const apiKeyRef = (s && s.apiKeyEnv) || config.apiKeyRef || DEFAULT_API_KEY_REF;
    const baseUrlRef = config.baseUrlRef || DEFAULT_BASE_URL_REF;
    let apiKey = config.apiKey || process.env[apiKeyRef] || process.env.AGNES_API_KEY || process.env.AGNES_API_TOKEN || '';
    let base = normalizeBase((s && s.baseUrl) || config.apiBase || process.env[baseUrlRef] || process.env.AGNES_API_BASE || DEFAULT_API_BASE);
    try {
      const key = await ctx.credentials.resolve(apiKeyRef);
      if (key && key.value) apiKey = key.value;
      if (!(s && s.baseUrl)) {
        const b = await ctx.credentials.resolve(baseUrlRef);
        if (b && b.value) base = normalizeBase(b.value);
      }
    } catch (e) {
      // Credentials unavailable or ref invalid: fall back to config/env.
    }
    return {
      apiKey,
      base,
      imageModel: (s && s.imageModel) || config.imageModel || DEFAULT_IMAGE_MODEL,
      visionModel: (s && s.visionModel) || config.visionModel || DEFAULT_VISION_MODEL,
      translateModel: (s && s.translateModel) || config.translateModel || DEFAULT_TRANSLATE_MODEL,
      outputDir: (s && s.outputDir) || config.outputDir || 'generated_images',
      autoTranslate: s ? Boolean(s.autoTranslate) : config.autoTranslate !== false,
      timeoutMs: Number.isFinite(config.timeoutMs) ? config.timeoutMs : 300000,
    };
  }

  const disposeImagegen = ctx.tools.register({
    name: 'imagegen',
    description: 'Generate or edit raster images through the configured OpenAI-compatible image API (default provider: Agnes AI agnes-image-2.x-flash, free tier). Use for photos, illustrations, mockups, textures, sprites, infographics, logo concepts, style transfer, and image editing or multi-image composition. Call once per requested asset; for edits pass the source image(s) in `images` and state invariants in the prompt. Saves each result under generated_images/ and returns local paths plus remote URLs. Non-English prompts are auto-translated.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed image description or edit instruction: main subject + scene/background + style + lighting + composition + quality. For edits, state what must change and what must stay unchanged.' },
        mode: { type: 'string', enum: MODES, description: 'text2img: new image from text (default). img2img: edit or transform one image. compose: combine multiple reference images.' },
        images: { type: 'array', items: { type: 'string' }, description: 'Input image paths (absolute or relative to the workspace) or public URLs. Required for img2img/compose.' },
        size: { type: 'string', enum: SIZE_TIERS.concat(LEGACY_SIZES), description: 'Resolution tier 1K/2K/3K/4K (pair with ratio) or a legacy exact size like 1024x768. Default 1K.' },
        ratio: { type: 'string', enum: RATIOS, description: 'Aspect ratio for tiered sizes; default 1:1.' },
        output: { type: 'string', description: 'Optional destination path (relative to the workspace or absolute). Defaults to generated_images/<timestamp>.png and never overwrites an existing file.' },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          files: { type: 'array', items: { type: 'string' } },
          urls: { type: 'array', items: { type: 'string' } },
          prompt: { type: 'string' },
          translated: { type: 'boolean' },
          model: { type: 'string' },
          mode: { type: 'string' },
          size: { type: 'string' },
        },
        required: ['files', 'urls', 'prompt', 'model', 'mode', 'size'],
      },
      render: (_args, value) => {
        const lines = [];
        if (value.files && value.files.length) lines.push('Saved: ' + value.files.join(', '));
        if (value.urls && value.urls.length) lines.push('Remote URL: ' + value.urls[0]);
        lines.push('Model: ' + value.model + ' | mode: ' + value.mode + ' | size: ' + value.size);
        if (value.translated) lines.push('Note: prompt was auto-translated from non-English input.');
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    timeoutMs: 300000,
    async execute(args, exec) {
      const r = await resolved();
      if (!r.apiKey) {
        throw new Error('Image API key is not configured. Open Settings → Plugins → 图像生成 and fill the API key, or export IMAGE_API_KEY.');
      }
      const header = exec.agent && exec.agent.session && exec.agent.session.header;
      const cwd = (header && header.cwd) || process.cwd();
      const signal = exec.signal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([exec.signal, AbortSignal.timeout(r.timeoutMs)])
        : exec.signal;

      let prompt = args.prompt;
      let translated = false;
      if (r.autoTranslate && /[^\u0000-\u007F]/.test(prompt)) {
        try {
          prompt = await chatTranslate(prompt, signal, r.apiKey, r.base, r.translateModel);
          translated = true;
        } catch (e) {
          // Translation is a convenience: fall back to the original prompt.
        }
      }

      const images = [];
      if (args.images && args.images.length) {
        for (const img of args.images) images.push(await toDataUri(img, cwd));
      }

      const body = { model: r.imageModel, prompt, size: args.size || '1K' };
      if (SIZE_TIERS.indexOf(body.size) !== -1 && args.ratio) body.ratio = args.ratio;
      if (images.length) body.image = images;
      body.extra_body = { response_format: 'url' };

      const data = await fetch(r.base + '/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + r.apiKey },
        body: JSON.stringify(body),
        signal,
      }).then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error('image API error ' + res.status + ': ' + text.slice(0, 500));
        }
        return res.json();
      });

      const items = Array.isArray(data && data.data) ? data.data : [];
      const url = items[0] && items[0].url;
      if (!url) throw new Error('image API returned no image URL');

      const buffer = Buffer.from(await fetch(url, { signal }).then(async (res) => {
        if (!res.ok) throw new Error('failed to download generated image: HTTP ' + res.status);
        return res.arrayBuffer();
      }));

      const wanted = args.output
        ? (isAbsolute(args.output) ? args.output : resolve(cwd, args.output))
        : resolve(cwd, r.outputDir, 'image_' + Date.now() + '.png');
      await mkdir(dirname(wanted), { recursive: true });
      const file = await saveImage(buffer, wanted);

      return {
        files: [file],
        urls: [url],
        prompt,
        translated,
        model: r.imageModel,
        mode: args.mode || 'text2img',
        size: body.size,
      };
    },
  });

  const disposeUnderstand = ctx.tools.register({
    name: 'image_understand',
    description: 'Describe or analyze raster images through the configured multimodal chat model (default: Agnes AI agnes-2.5-flash, free tier). Use when the user asks about an image the main model cannot see: explain content, read in-image text (OCR), analyze style/composition, compare multiple images, or verify a previously generated image. Pass local file paths (absolute or relative to the workspace) or public URLs in `images`; the analysis returns as text the main model can reason over.',
    parameters: {
      type: 'object',
      properties: {
        images: { type: 'array', items: { type: 'string' }, description: 'Input image paths (absolute or relative to the workspace) or public URLs. Multiple images are analyzed together in one request (for comparison, pass a prompt that asks for the comparison).' },
        prompt: { type: 'string', description: 'What to extract or analyze: e.g. "Describe this image in detail", "Read all the text in the image verbatim", "What art style is this?", "Compare the two images". Defaults to a detailed description.' },
      },
      required: ['images'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          images: { type: 'array', items: { type: 'string' } },
          prompt: { type: 'string' },
          model: { type: 'string' },
        },
        required: ['text', 'images', 'prompt', 'model'],
      },
      render: (_args, value) => {
        const lines = ['Images: ' + value.images.join(', '), 'Model: ' + value.model];
        lines.push('Analysis:');
        lines.push(value.text);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    timeoutMs: 120000,
    async execute(args, exec) {
      const r = await resolved();
      if (!r.apiKey) {
        throw new Error('Image API key is not configured. Open Settings → Plugins → 图像生成 and fill the API key, or export IMAGE_API_KEY.');
      }
      const header = exec.agent && exec.agent.session && exec.agent.session.header;
      const cwd = (header && header.cwd) || process.cwd();
      const signal = exec.signal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([exec.signal, AbortSignal.timeout(120000)])
        : exec.signal;

      const images = [];
      for (const img of args.images) {
        const uri = await toDataUri(img, cwd);
        if (!uri) continue;
        images.push(uri);
      }
      if (!images.length) throw new Error('at least one valid image path or URL is required');

      const prompt = args.prompt && args.prompt.trim() ? args.prompt.trim() : 'Describe this image in detail.';
      const text = await visionChat(images, prompt, signal, r.apiKey, r.base, r.visionModel);

      return { text, images: [...args.images], prompt, model: r.visionModel };
    },
  });

  return () => {
    disposeUnderstand();
    disposeImagegen();
  };
}
