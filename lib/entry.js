/**
 * dsh-phone — treat an Android phone as a device the agent can inspect and tidy up over adb.
 *
 * Five tools, deliberately few: every schema is priced into every request.
 *   phone_status  device + transport overview
 *   phone_scan    a read-only cleanup survey (caches, usage, big files, empty dirs)
 *   phone_fs      directory listings and sizes
 *   phone_act     the ONLY tool that writes: clear a cache, delete, uninstall — each gated
 *   phone_shot    screenshot to a local file
 *
 * Two more reads worth knowing about: `phone_scan kind=apps` reports per-app private data
 * sizes from `dumpsys diskstats` (it covers /data/data, which is unreachable without root),
 * and `phone_scan kind=candidates` produces a risk-graded cleanup list.
 *
 * ZERO DSH imports, on purpose. Measured 2026-10-15: a `link:`-installed plugin whose real
 * path lives outside the profile cannot resolve `@deepseek-ai/*` packages, and one such
 * import makes the whole entry fail to load. So this file talks to `ctx.tools` / `ctx.skills`
 * directly and declares parameters as the raw JSON Schema those helpers would have produced.
 *
 * Safety stance, spelled out because it is the point of the plugin:
 *   - reads never modify anything;
 *   - writes require `confirm: true` explicitly, otherwise the tool returns the plan it
 *     WOULD have executed and does nothing;
 *   - `rm` refuses any path outside /sdcard;
 *   - scans report sizes and locations, not file names — a file list out of someone's
 *     Download folder is private by default, and a survey rarely needs the names.
 */
import { mkdir, readFile, appendFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PhoneEngine, fmtBytes, fmtKb } from './adb.js';

export const name = 'dsh-phone';

/** The tool registry is a hard dependency; the skill registry is optional. */
export const inject = ['tools'];

/** Registration diagnostics: a plugin can report `applied` while every register call failed. */
function pluginLog(line) {
  const dir = process.env.DSH_HOME || join(homedir(), '.dsh');
  const file = join(dir, 'phone', '_plugin.log');
  return (async () => {
    try {
      await mkdir(join(dir, 'phone'), { recursive: true });
      await appendFile(file, `${new Date().toISOString()} ${line}\n`, 'utf8');
      // Keep it bounded: a plugin that logs on every apply would otherwise grow without limit.
      const st = await stat(file).catch(() => null);
      if (st && st.size > 64 * 1024) {
        const kept = (await readFile(file, 'utf8')).split('\n').slice(-200).join('\n');
        await writeFile(file, kept, 'utf8');
      }
    } catch { /* logging must never break the plugin */ }
  })();
}

function describeError(error) {
  if (!error) return 'unknown error';
  const name = error.name ?? 'Error';
  const message = error.message ?? String(error);
  const stack = typeof error.stack === 'string' ? error.stack.split('\n').slice(1, 3).join(' | ') : '';
  return `${name}: ${message}${stack ? ` @ ${stack}` : ''}`;
}

/* ------------------------------------------------------------------ *
 * The bundled skill
 * ------------------------------------------------------------------ */

const SKILL_NAME = 'phone-butler';
const SKILL_URL = new URL(`../skills/${SKILL_NAME}/SKILL.md`, import.meta.url);
const SKILL_DIR = fileURLToPath(new URL(`../skills/${SKILL_NAME}/`, import.meta.url));
const SKILL_PROVIDER = 'dsh-phone';
const SKILL_INVOCATION = { modelInvocable: true, userInvocable: true };
const SKILL_RANK = 600;

const SKILL_SUMMARY = {
  name: SKILL_NAME,
  description:
    'Work on a real Android phone over adb through the dsh-phone tools (phone_status / phone_scan / phone_fs / ' +
    'phone_act / phone_shot): free up storage, find what is eating the disk, list and measure directories, ' +
    'clear an app cache without touching its data, uninstall, or grab a screenshot. Use it whenever a task ' +
    'concerns the user\'s phone rather than this computer.',
  whenToUse: 'The user asks about their phone: storage is full, clean this up, which app is so big, where did my files go, take a screenshot.',
};

const skillProvider = {
  name: SKILL_PROVIDER,
  list: () => Promise.resolve([{
    ...SKILL_SUMMARY,
    invocation: SKILL_INVOCATION,
    provider: SKILL_PROVIDER,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: SKILL_DIR },
    rank: SKILL_RANK,
    locator: SKILL_URL,
  }]),
  async get(candidate) {
    const locator = candidate?.locator instanceof URL ? candidate.locator : SKILL_URL;
    return {
      name: SKILL_SUMMARY.name,
      description: SKILL_SUMMARY.description,
      whenToUse: SKILL_SUMMARY.whenToUse,
      invocation: SKILL_INVOCATION,
      provider: SKILL_PROVIDER,
      source: 'bundled',
      resourceBase: { kind: 'directory', path: SKILL_DIR },
      content: stripFrontmatter(await readFile(locator, 'utf8')),
    };
  },
};

function stripFrontmatter(value) {
  if (!value.startsWith('---\n')) return value;
  const end = value.indexOf('\n---\n', 4);
  return end === -1 ? value : value.slice(end + 5);
}

/* ------------------------------------------------------------------ *
 * Wire safety
 * ------------------------------------------------------------------ */

/**
 * Make a value representable on the wire: no undefined, NaN, Infinity, -0, class instances,
 * array holes or cycles. Measured 2026-10-15: a single `undefined` in a tool result makes the
 * whole call fail with `returned invalid output: value is not lossless JSON`.
 */
function lossless(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return Array.from(value, (entry) => lossless(entry === undefined ? null : entry));
  if (typeof value !== 'object') return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return typeof value.toString === 'function' ? String(value) : null;
  }
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    out[key] = lossless(entry);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Text rendering
 * ------------------------------------------------------------------ */

const text = (s) => [{ type: 'text', text: s }];

function renderStatus(v) {
  if (!v.serial) {
    const lines = ['No adb device is reachable.'];
    if (v.transports?.length) {
      lines.push('Transports adb knows about:');
      for (const t of v.transports) lines.push(`  ${t.serial}  state=${t.state}`);
    } else {
      lines.push('adb sees nothing at all. Check, in order:');
      lines.push('  1. the cable is in, or the phone is on the same Wi-Fi with wireless debugging on');
      lines.push('  2. the phone authorised this computer (a prompt appears on screen)');
      lines.push('  3. for a remote phone over a VPN: `adb tcpip 5555` once while on the same network,');
      lines.push('     then `adb connect <phone-vpn-ip>:5555`');
    }
    if (v.error) lines.push('detail: ' + v.error);
    return lines.join('\n');
  }
  const d = v.device ?? {};
  return [
    `serial    ${v.serial}${v.transportKind ? `  (${v.transportKind})` : ''}`,
    `device    ${d.model ?? '?'} (${d.brand ?? '?'})`,
    `android   ${d.android ?? '?'} (SDK ${d.sdk ?? '?'})`,
    `storage   ${d.storage ?? '?'}`,
    `battery   ${d.batteryPercent ?? '?'}%`,
    `wireless  ${d.wirelessDebugging ? 'on' : 'off'}`,
    d.uptime ? `uptime    ${d.uptime}` : null,
    v.available?.length > 1 ? `other transports: ${v.available.filter((s) => s !== v.serial).join(', ')}` : null,
  ].filter(Boolean).join('\n');
}

function renderScan(v) {
  const out = [];
  if (v.kind === 'apps') {
    out.push(`Per-app data (private /data/data + external Android/data), ${v.apps.rows.length} shown`);
    out.push(`total ${fmtBytes(v.apps.totalBytes)}, of which cache ${fmtBytes(v.apps.cacheBytes)}`);
    out.push('');
    out.push('       data      cache  package');
    for (const r of v.apps.rows) out.push(`  ${fmtBytes(r.dataBytes).padStart(9)}  ${fmtBytes(r.cacheBytes).padStart(8)}  ${r.package}`);
    out.push('');
    out.push('This layer is unreachable without root — only the app itself can clear it');
    out.push('(e.g. a chat app\'s own Settings → Storage screen). Clearing files from outside');
    out.push('can desynchronise its index and make old media show as broken.');
    return out.join('\n');
  }
  if (v.kind === 'caches') {
    out.push(`App cache directories, ${v.caches.rows.length} shown — total ${fmtKb(v.caches.totalKb)}`);
    out.push('Risk: low. A cache is rebuilt on demand.');
    for (const r of v.caches.rows) out.push(`  ${fmtKb(r.kb).padStart(10)}  ${r.package}`);
    out.push('');
    out.push('Clear one with phone_act action=clear-cache package=<name> confirm=true');
    return out.join('\n');
  }
  if (v.kind === 'big') {
    out.push(`${v.big.count} file(s) at or above ${v.big.minMb} MB — total ${fmtBytes(v.big.bytes)}`);
    out.push('Names are withheld by default. Locations:');
    for (const d of v.big.byDirectory) out.push(`  ${String(d.count).padStart(4)} file(s)  ${d.dir}/`);
    if (v.big.paths?.length) {
      out.push('');
      out.push('Explicitly requested listing (this is private data — do not repeat it casually):');
      for (const p of v.big.paths) out.push(`  ${fmtBytes(p.bytes).padStart(9)}  ${p.path}`);
    }
    return out.join('\n');
  }
  if (v.kind === 'storage') {
    out.push(`${v.storage.path} — children by size (total ${fmtKb(v.storage.totalKb)})`);
    for (const r of v.storage.rows) out.push(`  ${fmtKb(r.kb).padStart(10)}  ${r.target}`);
    return out.join('\n');
  }
  // candidates: the whole survey
  out.push('READ-ONLY CLEANUP SURVEY — nothing was modified.');
  out.push('');
  out.push(`【A · app caches】${v.scan.caches.rows.length} shown, total ${fmtKb(v.scan.caches.totalKb)} — risk: low`);
  for (const r of v.scan.caches.rows.slice(0, 10)) out.push(`  ${fmtKb(r.kb).padStart(10)}  ${r.package}`);
  out.push('');
  out.push(`【B · top-level usage】total ${fmtKb(v.scan.storage.totalKb)} — risk: your call`);
  for (const r of v.scan.storage.rows) out.push(`  ${fmtKb(r.kb).padStart(10)}  ${r.target}`);
  out.push('');
  out.push(`【C · files ≥500MB】${v.scan.bigFiles.count}, total ${fmtBytes(v.scan.bigFiles.bytes)} — risk: high`);
  for (const d of v.scan.bigFiles.byDirectory) out.push(`  ${String(d.count).padStart(4)} file(s)  ${d.dir}/`);
  out.push('');
  out.push(`【D · empty directories】${v.scan.emptyDirs} — risk: minimal`);
  out.push('');
  for (const w of v.scan.warnings) out.push('note: ' + w);
  return out.join('\n');
}

function renderFs(v) {
  if (v.op === 'ls') {
    if (v.error) return `ls ${v.path} failed: ${v.error}`;
    return [`${v.path}:`, ...v.lines].join('\n');
  }
  if (v.op === 'du') {
    const out = [`${v.path} — children by size (total ${fmtKb(v.totalKb)})`];
    for (const r of v.rows) out.push(`  ${fmtKb(r.kb).padStart(10)}  ${r.target}`);
    if (!v.rows.length) out.push('  (nothing — path missing, or empty)');
    return out.join('\n');
  }
  return JSON.stringify(v);
}

function renderAct(v) {
  if (v.dryRun) {
    return [
      'DRY RUN — nothing was executed.',
      `would run: ${v.action ?? v.error ?? '(nothing)'}`,
      'Re-issue the same call with confirm=true to actually do it.',
    ].join('\n');
  }
  if (v.error && !v.performed) return `refused: ${v.error}`;
  if (v.action === 'clear-cache') {
    return v.ok
      ? `cache cleared for ${v.package} (app data preserved)`
      : `clear-cache reported: ${v.output ?? v.error ?? 'unknown'}${v.timedOut ? ' (timed out)' : ''}`;
  }
  if (v.action === 'rm') {
    const lines = ['deletion results:'];
    for (const r of v.results ?? []) lines.push(`  ${r.removed ? 'removed' : 'STILL PRESENT'}  ${r.path}${r.error ? '  ' + r.error : ''}`);
    return lines.join('\n');
  }
  if (v.action === 'uninstall') return v.ok ? `uninstalled (user 0): ${v.package}` : `uninstall reported: ${v.output ?? 'unknown'}`;
  return JSON.stringify(v);
}

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

function registerTool(ctx, definition) {
  const run = definition.execute;
  const scrubbed = {
    ...definition,
    async execute(args, exec) {
      return lossless(await run(args, exec));
    },
  };
  ctx.effect(() => {
    try {
      const dispose = ctx.tools.register(scrubbed);
      pluginLog(`${definition.name}: registered`);
      return dispose;
    } catch (error) {
      pluginLog(`${definition.name}: REGISTER FAILED ${describeError(error)}`);
      throw error;
    }
  }, `dsh-phone: ${definition.name}`);
}

/**
 * @param {object} ctx - plugin context (typed by cordis; deliberately not imported).
 * @param {object} [config] - optional overrides; environment variables fill the same fields.
 */
export function apply(ctx, config) {
  const engine = new PhoneEngine(config ?? {});

  try {
    const keys = Object.keys(ctx).filter((k) => !k.startsWith('_')).join(',');
    // Do not read ctx.skills from here: without an `inject(['skills'])` in force, cordis throws on
    // property access — which filled the log with a failure that proved nothing.
    pluginLog(`apply: tools.register=${typeof ctx.tools?.register} keys=[${keys}]`);
  } catch (error) {
    pluginLog(`apply: introspection failed ${describeError(error)}`);
  }

  ctx.inject(['skills'], (skillsCtx) => {
    pluginLog('skills: inject fired');
    try {
      skillsCtx.effect(() => {
        try {
          const dispose = skillsCtx.skills.registerProvider(() => skillProvider);
          pluginLog('skills: provider registered');
          return dispose;
        } catch (error) {
          pluginLog(`skills: PROVIDER FAILED ${describeError(error)}`);
          throw error;
        }
      }, 'dsh-phone: phone-butler skill');
    } catch (error) {
      pluginLog(`skills: inject callback failed ${describeError(error)}`);
    }
  });

  const withDevice = (args) => {
    const picked = engine.pick(args?.device);
    return { picked, serial: picked.serial };
  };

  /* ----------------------------- phone_status ----------------------------- */
  registerTool(ctx, {
    name: 'phone_status',
    description:
      'Check whether an Android phone is reachable over adb and report the basics: model, Android version, ' +
      'storage, battery, whether wireless debugging is on, and every transport adb currently knows about. ' +
      'Call this first — the other phone tools need a reachable device, and this one says why when there is none.',
    parameters: {
      type: 'object',
      properties: {
        device: { type: 'string', description: 'Optional adb serial to use (e.g. "192.168.1.5:5555"). Defaults to the best available transport.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(renderStatus(value)),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const transports = engine.transports();
      const { picked, serial } = withDevice(args);
      if (!serial) {
        return { serial: null, transports, available: picked.available, error: transports.some((t) => t.state === 'unauthorized') ? 'device is unauthorised: accept the debugging prompt on the phone' : null };
      }
      const kind = /^\d+\.\d+\.\d+\.\d+:\d+$/.test(serial) ? 'wireless' : /^[0-9a-f]{6,}$/i.test(serial) ? 'usb' : 'wireless(mdns)';
      return { serial, transportKind: kind, available: picked.available, transports, device: engine.status(serial) };
    },
  });

  /* ------------------------------ phone_scan ------------------------------ */
  registerTool(ctx, {
    name: 'phone_scan',
    description:
      'Read-only scan of a phone. kind=candidates gives a risk-graded cleanup survey (caches, top-level usage, ' +
      'large files by location, empty directories) — start here when asked to free up space. kind=apps lists ' +
      'per-app private data sizes, including the /data/data that is unreachable without root, which is how you ' +
      'answer "which app is eating the disk". kind=caches ranks cache directories, kind=storage ranks a ' +
      'directory\'s children, kind=big finds large files. Nothing is ever modified by this tool. File names are ' +
      'withheld unless names=true is passed explicitly, because they are the user\'s private data.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['candidates', 'apps', 'caches', 'storage', 'big'], description: 'Which scan to run (default candidates).' },
        path: { type: 'string', description: 'For kind=storage: the directory to measure (default /sdcard).' },
        minMb: { type: 'number', description: 'For kind=big: minimum file size in MB (default 500).' },
        names: { type: 'boolean', description: 'Include actual file names for kind=big. Defaults to false: a list out of a Download folder is private.' },
        top: { type: 'number', description: 'How many rows to return (default 25 for apps, 15 elsewhere).' },
        device: { type: 'string', description: 'Optional adb serial.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(renderScan(value)),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const { serial } = withDevice(args);
      if (!serial) return { kind: args?.kind ?? 'candidates', error: 'no adb device reachable — run phone_status first' };
      const kind = args?.kind ?? 'candidates';
      if (kind === 'apps') return { kind, apps: engine.apps(serial, args?.top ?? 25) };
      if (kind === 'caches') return { kind, caches: engine.caches(serial, args?.top ?? 15) };
      if (kind === 'storage') return { kind, storage: engine.du(serial, args?.path ?? '/sdcard', args?.top ?? 15) };
      if (kind === 'big') {
        const found = engine.big(serial, args?.minMb ?? 500, 50);
        const byDir = new Map();
        for (const p of found.paths) {
          const dir = p.path.split('/').slice(0, 3).join('/');
          byDir.set(dir, (byDir.get(dir) || 0) + 1);
        }
        return {
          kind,
          big: {
            minMb: found.minMb,
            count: found.count,
            bytes: found.paths.reduce((a, b) => a + (b.bytes || 0), 0),
            byDirectory: [...byDir.entries()].map(([dir, n]) => ({ dir, count: n })).sort((a, b) => b.count - a.count),
            paths: args?.names === true ? found.paths : [],
          },
        };
      }
      return { kind: 'candidates', scan: engine.scan(serial, 12) };
    },
  });

  /* ------------------------------- phone_fs ------------------------------- */
  registerTool(ctx, {
    name: 'phone_fs',
    description:
      'Look at the phone\'s shared storage (/sdcard) over adb: op=ls lists a directory, op=du ranks its children by ' +
      'size. Read-only. Note what this CAN see: /sdcard in full, including every app\'s Android/data and ' +
      'Android/obb. What it cannot see: /data/data (app-private), which needs root — use phone_scan kind=apps ' +
      'for a size view of that layer instead.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['ls', 'du'], description: 'Operation (default ls).' },
        path: { type: 'string', description: 'Target path (default /sdcard).' },
        top: { type: 'number', description: 'For op=du: how many children to return (default 15).' },
        device: { type: 'string', description: 'Optional adb serial.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(renderFs(value)),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const { serial } = withDevice(args);
      const op = args?.op ?? 'ls';
      const path = args?.path ?? '/sdcard';
      if (!serial) return { op, path, error: 'no adb device reachable — run phone_status first' };
      if (op === 'du') return { op, ...engine.du(serial, path, args?.top ?? 15) };
      return { op: 'ls', ...engine.ls(serial, path) };
    },
  });

  /* ------------------------------ phone_act ------------------------------- */
  registerTool(ctx, {
    name: 'phone_act',
    description:
      'The only dsh-phone tool that CHANGES the phone. Without confirm=true it performs nothing and returns the ' +
      'plan instead — show that plan to the user and get their agreement first. action=clear-cache clears one ' +
      'app\'s cache while preserving its data (safe, reversible by the app). action=rm deletes paths and only ' +
      'accepts locations under /sdcard (deletion is not recoverable — there is no trash). action=uninstall ' +
      'removes a package for the current user only.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['clear-cache', 'rm', 'uninstall'], description: 'What to do.' },
        package: { type: 'string', description: 'For clear-cache / uninstall: the package name.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'For rm: absolute paths under /sdcard.' },
        confirm: { type: 'boolean', description: 'Must be true to actually execute. Anything else returns a dry run.' },
        device: { type: 'string', description: 'Optional adb serial.' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(renderAct(value)),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const { serial } = withDevice(args);
      const action = args?.action;
      if (!serial) return { action, error: 'no adb device reachable — run phone_status first' };
      if (action === 'clear-cache') {
        return { action, package: args?.package, ...engine.clearCache(serial, args?.package, args?.confirm === true) };
      }
      if (action === 'rm') {
        return { action, ...engine.rm(serial, args?.paths, args?.confirm === true) };
      }
      if (action === 'uninstall') {
        return { action, package: args?.package, ...engine.uninstall(serial, args?.package, args?.confirm === true) };
      }
      return { action, error: 'unknown action: ' + String(action) };
    },
  });

  /* ------------------------------ phone_shot ------------------------------ */
  registerTool(ctx, {
    name: 'phone_shot',
    description:
      'Take a screenshot on the phone and save it to a file on this computer, returning the path. Use it to see ' +
      'what is on the phone\'s screen. A black image with a tiny file size usually means the screen is off or ' +
      'locked, not that capture failed.',
    parameters: {
      type: 'object',
      properties: {
        out: { type: 'string', description: 'Absolute path to write the PNG to. Defaults to ~/phone-shots/<timestamp>.png.' },
        device: { type: 'string', description: 'Optional adb serial.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(value.ok ? `screenshot saved: ${value.path}` : `screenshot failed: ${value.error}`),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const { serial } = withDevice(args);
      if (!serial) return { ok: false, error: 'no adb device reachable — run phone_status first' };
      const out = args?.out || join(homedir(), 'phone-shots', `phone-${Date.now()}.png`);
      await mkdir(join(homedir(), 'phone-shots'), { recursive: true }).catch(() => {});
      return engine.shot(serial, out);
    },
  });
}
