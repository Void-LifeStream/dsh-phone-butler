/**
 * dsh-phone — adb plumbing.
 *
 * Plain Node, zero DSH imports: both the tool entry and test/selftest.mjs drive this module
 * directly, so the engine can be tested without restarting the harness.
 *
 * Two rules are baked in here, and both were paid for in a single long evening:
 *
 *  1. Every adb call passes an **argv array** — never a shell string. On Windows, handing a
 *     command that contains double quotes to `adb shell` through PowerShell lets the shell eat
 *     the quotes; the pipeline then shifts and the command silently returns nothing. That is how
 *     a scan "proved" a phone had no large files and no empty directories when it had thousands.
 *
 *  2. Recursive scans use `find -H <path>`. On Android `/sdcard` is a symlink
 *     (`/sdcard -> /storage/self/primary -> /storage/emulated/0`) and toybox `find` does not
 *     follow it by default — so `find /sdcard ...` returns **empty, with no error**, which reads
 *     exactly like a clean device.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/* ------------------------------------------------------------------ *
 * Locating adb
 * ------------------------------------------------------------------ */

/** Candidate adb binaries, in priority order. DSH_PHONE_ADB wins; `adb` on PATH is the fallback. */
export function adbCandidates(env = process.env, home = homedir()) {
  const out = [];
  if (env.DSH_PHONE_ADB) out.push(env.DSH_PHONE_ADB);
  if (env.ANDROID_HOME) out.push(join(env.ANDROID_HOME, 'platform-tools', 'adb.exe'));
  if (env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe'));
  out.push(join(home, 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'));
  out.push(join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb'));   // macOS
  out.push(join(home, 'Android', 'Sdk', 'platform-tools', 'adb'));              // Linux
  out.push('/usr/bin/adb');
  out.push('adb');
  return out;
}

/** First existing candidate; falls back to the bare name so a PATH lookup can still succeed. */
export function resolveAdb(env = process.env, exists = existsSync) {
  for (const c of adbCandidates(env)) {
    if (c === 'adb') return c;
    try { if (exists(c)) return c; } catch { /* keep looking */ }
  }
  return 'adb';
}

/* ------------------------------------------------------------------ *
 * The engine
 * ------------------------------------------------------------------ */

export class PhoneEngine {
  constructor(config = {}, env = process.env) {
    /** An explicit path always wins and is never re-resolved. */
    this.configAdb = config.adbPath || null;
    this.env = env;
    this._adb = null;
    this.defaultTimeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 240000;
  }

  /**
   * adb is resolved **lazily, and re-probed while nothing has been found yet**.
   *
   * A plugin instance lives for the whole harness session, so resolving once in the constructor
   * would freeze a miss: install platform-tools (or point DSH_PHONE_ADB at a binary) after
   * startup and the session would keep reporting "no device" until a restart. Measured
   * 2026-10-16 — that is exactly what happened on the first live run.
   */
  get adb() {
    if (this.configAdb) return this.configAdb;
    if (!this._adb || this._adb === 'adb') {
      const found = resolveAdb(this.env);
      if (found !== 'adb') this._adb = found;
      return found;
    }
    return this._adb;
  }

  /** Run one adb invocation. Returns {code, out, err, timedOut} and never throws. */
  raw(args, { timeout } = {}) {
    const r = spawnSync(this.adb, args, {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: Number(timeout) > 0 ? Number(timeout) : this.defaultTimeoutMs,
      windowsHide: true,
    });
    return {
      code: r.status,
      out: (r.stdout || '').replace(/\s+$/, ''),
      err: (r.stderr || '').replace(/\s+$/, ''),
      timedOut: Boolean(r.error && r.error.code === 'ETIMEDOUT'),
      spawnError: r.error ? String(r.error.message || r.error) : null,
    };
  }

  /** Every transport adb currently knows about. */
  transports() {
    const r = this.raw(['devices']);
    return r.out
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\s+/);
        return { serial: parts[0], state: parts[1] };
      });
  }

  /**
   * Pick one device. USB (an 8-hex serial) ranks above wireless, because a cable is the one
   * transport that does not care about Wi-Fi, sleep, or which network the phone is on.
   */
  pick(explicit) {
    const ready = this.transports().filter((t) => t.state === 'device');
    if (explicit) return { serial: explicit, available: ready.map((t) => t.serial) };
    if (!ready.length) return { serial: null, available: [] };
    const rank = (s) => (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s) ? 2 : /^[0-9a-f]{6,}$/i.test(s) ? 3 : 1);
    const sorted = ready.slice().sort((a, b) => rank(b.serial) - rank(a.serial));
    return { serial: sorted[0].serial, available: sorted.map((t) => t.serial) };
  }

  /**
   * Run one command on the device. The whole command is a single argv entry.
   *
   * Argument order is **(command, serial)** — command first. Every call site in this file reads
   * `this.shell('<command>', serial)`. A ported call site that had the two backwards produced
   * `adb: device 'echo MODEL=$(getprop …)' not found`, and it only surfaced against a real
   * device: the offline assertions were all about refusing, and none of them reached this line.
   * test/selftest.mjs now asserts the argv order directly.
   */
  shell(command, serial, opts) {
    return this.raw(['-s', serial, 'shell', command], opts);
  }

  /* ---------------------------------------------------------------- *
   * Read-only commands — these return data, never text to print.
   * ---------------------------------------------------------------- */

  /** Device overview: model, Android version, storage, battery. */
  status(serial) {
    const script = [
      'echo MODEL=$(getprop ro.product.model)',
      'echo BRAND=$(getprop ro.product.brand)',
      'echo RELEASE=$(getprop ro.build.version.release)',
      'echo SDK=$(getprop ro.build.version.sdk)',
      'echo STORAGE=$(df -h /sdcard | tail -1)',
      'echo BATTERY=$(dumpsys battery | grep -m1 level | tr -dc 0-9)',
      'echo WIFI_ADB=$(settings get global adb_wifi_enabled)',
      'echo UPTIME=$(uptime | tr -d ",")',
    ].join('; ');
    const r = this.shell(script, serial);
    const kv = {};
    for (const line of r.out.split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
    }
    return {
      ok: r.code === 0 || Boolean(kv.MODEL),
      model: kv.MODEL || null,
      brand: kv.BRAND || null,
      android: kv.RELEASE || null,
      sdk: kv.SDK || null,
      storage: kv.STORAGE || null,
      batteryPercent: kv.BATTERY ? Number(kv.BATTERY) : null,
      wirelessDebugging: kv.WIFI_ADB === '1',
      uptime: kv.UPTIME || null,
      error: r.code === 0 ? null : (r.err || r.out || 'adb exited non-zero'),
    };
  }

  /** Directory listing (raw `ls -la` output, one entry per line). */
  ls(serial, path) {
    const r = this.shell(`ls -la ${quote(path)} 2>&1`, serial);
    return { path, lines: r.out.split(/\r?\n/).filter(Boolean), error: r.code === 0 ? null : r.err };
  }

  /** Immediate children of a path with their sizes (KB / bytes). */
  du(serial, path = '/sdcard', top = 15) {
    const r = this.shell(`du -s ${quote(path)}/* 2>/dev/null | sort -rn | head -${clampInt(top, 1, 200, 15)}`, serial);
    const rows = parseDu(r.out);
    return { path, rows, totalKb: rows.reduce((a, b) => a + b.kb, 0) };
  }

  /** Files above a size threshold. `find -H` is load-bearing — see the header. */
  big(serial, minMb = 200, top = 40) {
    const bytes = Math.round(clampInt(minMb, 1, 1000000, 200) * 1024 * 1024);
    const r = this.shell(`find -H /sdcard -type f -size +${bytes}c 2>/dev/null | head -${clampInt(top, 1, 500, 40)}`, serial);
    const paths = r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return { minMb, count: paths.length, paths: withSizes(this, serial, paths) };
  }

  /** Per-app external cache directories, largest first. */
  caches(serial, top = 15) {
    const r = this.shell(`du -s /sdcard/Android/data/*/cache 2>/dev/null | sort -rn | head -${clampInt(top, 1, 200, 15)}`, serial);
    const rows = parseDu(r.out).map((row) => {
      const m = row.target.match(/\/Android\/data\/([^/]+)\/cache$/);
      return { kb: row.kb, package: m ? m[1] : row.target, path: row.target };
    });
    return { rows, totalKb: rows.reduce((a, b) => a + b.kb, 0) };
  }

  /**
   * Per-app private data sizes, straight out of `dumpsys diskstats`.
   *
   * This is the one read the platform hands to a shell that a file manager cannot get:
   * the reported `App Data Sizes` covers **both** `/data/data/<pkg>` (unreachable without root)
   * and the app's external `Android/data` directory — so an agent can finally answer
   * "which app is eating the phone" without root.
   */
  apps(serial, top = 25) {
    const r = this.shell('dumpsys diskstats', serial, { timeout: 120000 });
    const names = parseStatsArray(r.out, 'Package Names');
    const data = parseStatsArray(r.out, 'App Data Sizes');
    const cache = parseStatsArray(r.out, 'Cache Sizes');
    if (!names.length) {
      return { rows: [], totalBytes: 0, cacheBytes: 0, error: 'dumpsys diskstats did not expose the package array on this device' };
    }
    const rows = names.map((pkg, i) => ({
      package: pkg,
      dataBytes: Number(data[i] || 0),
      cacheBytes: Number(cache[i] || 0),
    })).sort((a, b) => b.dataBytes - a.dataBytes);
    return {
      rows: rows.slice(0, clampInt(top, 1, 545, 25)),
      totalBytes: rows.reduce((a, b) => a + b.dataBytes, 0),
      cacheBytes: rows.reduce((a, b) => a + b.cacheBytes, 0),
      error: null,
    };
  }

  /** A read-only cleanup survey: caches, top-level usage, big files, empty directories. */
  scan(serial, top = 12) {
    const caches = this.caches(serial, top);
    const storage = this.du(serial, '/sdcard', top);
    const bigResult = this.big(serial, 500, 50);
    const emptyRaw = this.shell('find -H /sdcard -type d -empty 2>/dev/null | wc -l', serial);
    const emptyDirs = Number((emptyRaw.out || '0').trim()) || 0;

    // Report *where* the big files are, not their names: a file list from someone's Download
    // folder is private by default, and a survey rarely needs the names to be actionable.
    const byDir = new Map();
    for (const p of bigResult.paths) {
      const dir = p.path.split('/').slice(0, 3).join('/');
      byDir.set(dir, (byDir.get(dir) || 0) + 1);
    }
    return {
      caches,
      storage,
      bigFiles: { minMb: 500, count: bigResult.count, bytes: bigResult.paths.reduce((a, b) => a + (b.bytes || 0), 0), byDirectory: [...byDir.entries()].map(([dir, n]) => ({ dir, count: n })).sort((a, b) => b.count - a.count) },
      emptyDirs,
      warnings: [
        'Only /sdcard is visible here. App-private data (/data/data, where chat databases live) needs root and is NOT reachable.',
        'A zero count for big files or empty dirs means the scan worked only if it used `find -H`; see lib/adb.js.',
      ],
    };
  }

  /* ---------------------------------------------------------------- *
   * Write commands — each one is gated by an explicit confirm flag.
   * ---------------------------------------------------------------- */

  /** Clear one app's cache only (data is preserved). Verifies the package exists first. */
  clearCache(serial, pkg, confirm) {
    if (!pkg) return { ok: false, error: 'package name required' };
    const exists = this.shell(`pm path ${quote(pkg)} 2>/dev/null`, serial);
    if (!/^package:/m.test(exists.out)) {
      // Measured: `pm clear --cache-only` on a package that does not exist hangs forever.
      return { ok: false, error: `package not found: ${pkg} (refusing to run clear, which would hang)`, performed: false };
    }
    if (confirm !== true) return { ok: false, performed: false, dryRun: true, action: `pm clear --cache-only ${pkg}` };
    const r = this.shell(`pm clear --cache-only ${quote(pkg)}`, serial, { timeout: 60000 });
    return {
      ok: /Success/.test(r.out),
      performed: true,
      action: `pm clear --cache-only ${pkg}`,
      output: r.out || r.err,
      timedOut: r.timedOut,
    };
  }

  /** Delete paths under /sdcard only. Refuses anything outside it, on purpose. */
  rm(serial, paths, confirm) {
    const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
    if (!list.length) return { ok: false, error: 'at least one path required' };
    const outside = list.filter((p) => !String(p).startsWith('/sdcard/'));
    if (outside.length) return { ok: false, error: `refusing paths outside /sdcard: ${outside.join(', ')}`, performed: false };
    if (confirm !== true) return { ok: false, performed: false, dryRun: true, action: `rm -rf ${list.join(' ')}` };
    const results = list.map((p) => {
      const r = this.shell(`rm -rf ${quote(p)}`, serial);
      const check = this.shell(`ls -d ${quote(p)} 2>/dev/null`, serial);
      return { path: p, removed: check.out.trim() === '', error: r.err || null };
    });
    return { ok: results.every((r) => r.removed), performed: true, results };
  }

  /** Uninstall for the current user only (recoverable by reinstalling). */
  uninstall(serial, pkg, confirm) {
    if (!pkg) return { ok: false, error: 'package name required' };
    if (confirm !== true) return { ok: false, performed: false, dryRun: true, action: `pm uninstall --user 0 ${pkg}` };
    const r = this.shell(`pm uninstall --user 0 ${quote(pkg)}`, serial, { timeout: 120000 });
    return { ok: /Success/.test(r.out), performed: true, output: r.out || r.err };
  }

  /** Capture the screen to a local file and return its path. */
  shot(serial, outs) {
    const remote = `/sdcard/.dsh-phone-shot-${Date.now()}.png`;
    const cap = this.shell(`screencap -p ${remote}`, serial);
    if (cap.code !== 0) return { ok: false, error: cap.err || cap.out };
    const pull = this.raw(['-s', serial, 'pull', remote, outs]);
    this.shell(`rm -f ${remote}`, serial);
    return { ok: /1 file pulled/.test(pull.out), path: outs, error: pull.err || null };
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Wrap a path in single quotes for the device shell. */
export function quote(p) {
  return "'" + String(p).replace(/'/g, "'\\''") + "'";
}

export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** `du -s` output ("12345\t/path") to rows. */
export function parseDu(out) {
  return String(out)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^(\d+)\s+(.*)$/);
      return m ? { kb: Number(m[1]), target: m[2] } : null;
    })
    .filter(Boolean);
}

/** One field of `dumpsys diskstats`, which stores parallel arrays as `Name: [a,b,c]`. */
export function parseStatsArray(raw, field) {
  const m = String(raw).match(new RegExp('^' + field + ':\\s*\\[(.*)\\]\\s*$', 'm'));
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
}

export function fmtKb(kb) {
  const n = Number(kb) || 0;
  if (n < 1024) return n + ' KB';
  const mb = n / 1024;
  if (mb < 1024) return mb.toFixed(1) + ' MB';
  return (mb / 1024).toFixed(2) + ' GB';
}

export function fmtBytes(b) {
  const n = Number(b) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/** Attach byte sizes to a list of paths with a single `ls -l` round-trip. */
function withSizes(engine, serial, paths) {
  if (!paths.length) return [];
  const out = engine.shell(`ls -l ${paths.map(quote).join(' ')} 2>/dev/null | awk '{print $5, $NF}'`, serial);
  const sizes = new Map();
  for (const line of out.out.split(/\r?\n/)) {
    const m = line.match(/^(\d+)\s+(.*)$/);
    if (m) sizes.set(m[2], Number(m[1]));
  }
  return paths.map((p) => ({ path: p, bytes: sizes.get(p) ?? null }));
}
