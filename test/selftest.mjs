/**
 * dsh-phone self-test — runs with plain Node, no harness and no phone required.
 *
 * The point is not coverage for its own sake. Both halves of this plugin had a failure mode
 * that produced *plausible* output while doing nothing:
 *   - a scan that returned "no large files" because `find` did not follow a symlink;
 *   - a tool that registered "successfully" while every registration had actually failed.
 * So the assertions below are mostly about refusing, refusing loudly, and reporting shape.
 *
 *   node test/selftest.mjs            # offline checks only
 *   node test/selftest.mjs --device   # also run read-only calls against a real phone
 */
import { PhoneEngine, adbCandidates, resolveAdb, quote, parseDu, parseStatsArray, clampInt, fmtKb, fmtBytes } from '../lib/adb.js';
import { apply } from '../lib/entry.js';

let passed = 0;
let failed = 0;
const failures = [];

function ok(label, condition, detail) {
  if (condition) { passed++; return; }
  failed++;
  failures.push(label + (detail ? '  -> ' + detail : ''));
}

function eq(label, actual, expected) {
  ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ------------------------------ pure helpers ------------------------------ */

eq('quote wraps in single quotes', quote('/sdcard/a b'), "'/sdcard/a b'");
eq('quote escapes an embedded quote', quote("/sdcard/it's"), "'/sdcard/it'\\''s'");

eq('clampInt falls back on nonsense', clampInt('abc', 1, 10, 7), 7);
eq('clampInt clamps high', clampInt(999, 1, 10, 7), 10);
eq('clampInt clamps low', clampInt(-5, 1, 10, 7), 1);
eq('clampInt truncates', clampInt(3.9, 1, 10, 7), 3);

eq('parseDu reads one row', parseDu('1234\t/sdcard/DCIM').length, 1);
eq('parseDu keeps the number', parseDu('1234\t/sdcard/DCIM')[0].kb, 1234);
eq('parseDu drops junk lines', parseDu('total 10\n\nabc /x').length, 0);
eq('parseDu handles many rows', parseDu('1\ta\n2\tb\n3\tc').length, 3);

const stats = 'Package Names: ["com.a","com.b"]\nApp Data Sizes: [100,200]\nCache Sizes: [1,2]\n';
eq('parseStatsArray names', parseStatsArray(stats, 'Package Names').join(','), 'com.a,com.b');
eq('parseStatsArray numbers', parseStatsArray(stats, 'App Data Sizes').join(','), '100,200');
eq('parseStatsArray missing field', parseStatsArray(stats, 'Nope').length, 0);

eq('fmtKb small', fmtKb(500), '500 KB');
eq('fmtKb megabytes', fmtKb(2048), '2.0 MB');
eq('fmtKb gigabytes', fmtKb(1024 * 1024 * 3), '3.00 GB');
eq('fmtBytes bytes', fmtBytes(512), '512 B');
eq('fmtBytes gigabytes', fmtBytes(1024 ** 3), '1.00 GB');

/* ------------------------------ adb discovery ----------------------------- */

ok('adbCandidates is non-empty', adbCandidates().length > 0);
eq('DSH_PHONE_ADB wins when set', adbCandidates({ DSH_PHONE_ADB: 'X:/adb' })[0], 'X:/adb');
ok('resolveAdb always returns something', typeof resolveAdb() === 'string' && resolveAdb().length > 0);
ok('resolveAdb falls back to the bare name', resolveAdb({}, () => false) === 'adb');

/* --------------------------- engine safety semantics ---------------------- */

const engine = new PhoneEngine({ adbPath: 'definitely-not-adb' });

const rmOutside = engine.rm('serial', ['/data/local/tmp/x'], true);
eq('rm refuses paths outside /sdcard', rmOutside.ok, false);
ok('rm says why', /outside \/sdcard/.test(rmOutside.error || ''), rmOutside.error);
eq('rm refuses before executing anything', rmOutside.performed, false);

const rmDry = engine.rm('serial', ['/sdcard/tmp/x'], false);
eq('rm without confirm is a dry run', rmDry.dryRun, true);
eq('rm dry run performs nothing', rmDry.performed, false);
ok('rm dry run states the plan', /rm -rf/.test(rmDry.action || ''), rmDry.action);

const ccDry = engine.clearCache('serial', 'com.example.app', false);
eq('clear-cache without confirm is a dry run', ccDry.performed, false);

const unDry = engine.uninstall('serial', 'com.example.app', false);
eq('uninstall without confirm is a dry run', unDry.performed, false);
eq('uninstall dry run performs nothing', unDry.ok, false);

const ccMissing = engine.clearCache('serial', '', true);
eq('clear-cache needs a package', ccMissing.ok, false);

/* ------------------------- plugin registration shape ---------------------- */

const tools = [];
const labels = [];
const ctx = {
  tools: { register: (def) => { tools.push(def); return () => {}; } },
  effect: (fn, label) => { labels.push(label); return fn(); },
  inject: () => { /* no skills service in this environment: the tools must still register */ },
};
apply(ctx, {});

eq('registers five tools', tools.length, 5);
const names = tools.map((t) => t.name).sort().join(',');
eq('tool names are the documented ones', names, 'phone_act,phone_fs,phone_scan,phone_shot,phone_status');
ok('every tool declares parameters', tools.every((t) => t.parameters && t.parameters.type === 'object'));
ok('every tool renders text', tools.every((t) => t.output && typeof t.output.render === 'function'));
ok('every tool has a description', tools.every((t) => typeof t.description === 'string' && t.description.length > 40));
ok('phone_act is not marked concurrency safe', tools.find((t) => t.name === 'phone_act').isConcurrencySafe() === false);
ok('read-only tools are concurrency safe', ['phone_status', 'phone_scan', 'phone_fs', 'phone_shot'].every((n) => tools.find((t) => t.name === n).isConcurrencySafe() === true));
ok('registration went through ctx.effect', labels.length >= 5, 'labels=' + labels.length);
ok('phone_act requires an action', Array.isArray(tools.find((t) => t.name === 'phone_act').parameters.required));

/* --------------------- argv order (a real bug, once) ---------------------- */
// A backwards (serial, command) signature reached a real phone as
// `adb: device 'echo MODEL=$(getprop …)' not found`. Offline assertions did not catch it
// because they never got past the refusal paths. These do.

const probe = new PhoneEngine({ adbPath: 'x' });
const calls = [];
probe.raw = (args) => {
  calls.push(args);
  if (String(args[3] ?? '').startsWith('echo MODEL=')) {
    return { code: 0, out: 'MODEL=Test\nBRAND=T\nRELEASE=14\nSDK=34\nSTORAGE=/x 1 1 1 1\nBATTERY=88\nWIFI_ADB=1\nUPTIME=up 1 day', err: '' };
  }
  return { code: 0, out: '1\t/a\n2\t/b\n', err: '' };
};

probe.status('SERIAL');
eq('status passes -s <serial>', calls[0] && calls[0][1], 'SERIAL');
eq('status sends `shell` in argv[2]', calls[0] && calls[0][2], 'shell');
ok('status sends the command as argv[3]', String(calls[0] && calls[0][3]).startsWith('echo MODEL='), JSON.stringify(calls[0]));
eq('status parses the model back out', probe.status('SERIAL').model, 'Test');

calls.length = 0;
probe.ls('SERIAL', '/sdcard');
eq('ls passes -s <serial>', calls[0] && calls[0][1], 'SERIAL');
ok('ls quotes the path', String(calls[0] && calls[0][3]).includes("'/sdcard'"), JSON.stringify(calls[0] && calls[0][3]));

calls.length = 0;
probe.du('SERIAL', '/sdcard', 3);
eq('du passes -s <serial>', calls[0] && calls[0][1], 'SERIAL');
ok('du asks for a sorted head', String(calls[0] && calls[0][3]).includes('sort -rn'), JSON.stringify(calls[0] && calls[0][3]));

calls.length = 0;
probe.big('SERIAL', 500, 3);
ok('big uses `find -H` (never bare find)', String(calls[0] && calls[0][3]).includes('find -H /sdcard'), JSON.stringify(calls[0] && calls[0][3]));

calls.length = 0;
probe.apps('SERIAL', 3);
ok('apps reads dumpsys diskstats', String(calls[0] && calls[0][3]).includes('dumpsys diskstats'), JSON.stringify(calls[0] && calls[0][3]));

/* ------------------------------- live device ------------------------------ */

if (process.argv.includes('--device')) {
  const live = new PhoneEngine({});
  const picked = live.pick();
  if (!picked.serial) {
    console.log('--device requested but no adb device is reachable; skipping live checks.');
  } else {
    console.log('live device: ' + picked.serial);
    const st = live.status(picked.serial);
    ok('live status reports a model', Boolean(st.model), JSON.stringify(st).slice(0, 160));
    const du = live.du(picked.serial, '/sdcard', 5);
    ok('live du returns rows', du.rows.length > 0, 'rows=' + du.rows.length);
    const scan = live.big(picked.serial, 500, 5);
    ok('live big returns a shape', typeof scan.count === 'number');
    const ls = live.ls(picked.serial, '/sdcard');
    ok('live ls lists something', ls.lines.length > 0, 'lines=' + ls.lines.length);
  }
}

/* --------------------------------- report -------------------------------- */

console.log(`dsh-phone selftest: ${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(1);
}
