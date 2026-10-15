---
name: phone-butler
description: Inspect and tidy a real Android phone over adb — storage surveys, per-app data sizes, directory listings, cache clearing, screenshots.
---

# Phone butler — working on a real Android phone over adb

`dsh-phone` gives you an Android phone as a device you can measure and clean. Everything goes
through `adb`; nothing needs root.

## What is actually reachable (measured, not assumed)

| Layer | Reachable? | Note |
|---|---|---|
| `/sdcard/**` | **yes, read + write** | includes **every** app's `/sdcard/Android/data` and `/sdcard/Android/obb` |
| `/data/data/<pkg>` | **no** | `Permission denied` without root. `run-as` refuses non-debuggable packages. This is where chat databases live. |
| Per-app data **sizes** | **yes** | `phone_scan kind=apps` reads `dumpsys diskstats`, which covers `/data/data` *and* external `Android/data` |
| Clear app **cache** only | **yes** | `pm clear --cache-only <pkg>` — keeps data |
| Clear app **data** | yes, but destroys it | not exposed here on purpose; there is no undo |

The practical consequence: "free up storage" splits into two jobs. Files on `/sdcard` you can
delete; the private layer you can only **measure** — clearing it is the app's own job
(e.g. its Settings → Storage screen). Say that out loud rather than implying you can do both.

## The tools

- **`phone_status`** — is a phone reachable at all, and what is it. Run this first.
- **`phone_scan`** — read-only. `kind=candidates` (start here for "clean my phone"),
  `apps` (which app is eating the disk), `caches`, `storage`, `big`.
- **`phone_fs`** — `ls` / `du` on `/sdcard`.
- **`phone_act`** — the only writer. `clear-cache` · `rm` · `uninstall`.
- **`phone_shot`** — screenshot to a local file.

## Rules that keep this safe

1. **Reads are free; writes are not.** `phone_act` without `confirm: true` executes nothing and
   returns the plan. Show that plan to the user, get agreement, then re-issue.
2. **Never delete what you cannot name.** If the user has not seen the list, do not delete from it.
3. **File names are private by default.** `phone_scan kind=big` reports sizes and locations, not
   names; `names: true` is an explicit request. Do not echo a private file list into summaries,
   memory entries or documents.
4. **Chat apps are not ordinary files.** A QQ/WeChat media directory is the user's own history;
   deleting it from outside can desynchronise the app's index and leave broken entries. Point the
   user at the app's own storage screen instead.
5. **There is no trash on Android.** `rm` is final.

## Connecting a phone (the part that surprises people)

There are two independent transports, and they behave differently:

| Transport | Bound to | Survives leaving Wi-Fi? |
|---|---|---|
| **Wireless debugging** (Android 11+) | **WLAN** — its own switch says "enable debugging mode after connecting to WLAN" | **No.** Turn Wi-Fi off and adbd stops listening |
| **`adb tcpip 5555`** | the adbd process, listening on `0.0.0.0:5555` | **Yes** — which is what makes remote work possible |

So for a phone that is *not* on the same network, the recipe is: once, while on the same Wi-Fi,
run `adb tcpip 5555`; after that the phone keeps listening on 5555, and anyone who can route to
its address (e.g. over a VPN such as Tailscale) can connect with
`adb connect <phone-address>:5555`. It stops listening after a phone reboot.

To find the wireless-debugging port: `adb mdns services` prints `IP:port` directly.

## Five traps that produced wrong answers

1. **`find /sdcard` silently returns nothing.** `/sdcard` is a symlink
   (`/sdcard → /storage/self/primary → /storage/emulated/0`) and toybox `find` does not follow it.
   The result is an empty list and exit code 0 — indistinguishable from a clean device.
   **Always `find -H /sdcard`.** (A "no large files, no empty directories" report once came out of
   exactly this; the phone had thousands of both.)
2. **Do not hand a double-quoted command to `adb shell` through PowerShell.** The quotes get eaten,
   the pipeline shifts, and you get a silent empty result. Pass an argv array.
3. **A script pushed to the phone needs LF line endings.** CRLF makes the shell report
   `id\r: inaccessible or not found`.
4. **A black screenshot is a locked screen**, not a broken capture — compare file sizes
   (~18 KB black vs megabytes of content), or check `dumpsys power`.
5. **Never read a path out of a screenshot.** OCR confuses `l`/`1`, `I`/`1`. Ask the device:
   `pm path <package>`.

## One more, about coexistence

If several agents share this computer, they share **one** adb server. `adb kill-server`
disconnects *everyone*. To drop your own connection only, use `adb disconnect <address>`.

## Reporting a storage survey

Lead with the split, not the total:

1. what is on `/sdcard` and how much of it is yours to delete;
2. what lives in the private layer, whose size you can only measure;
3. the safest-first order of operations, and the one item that needs the user's own decision.
