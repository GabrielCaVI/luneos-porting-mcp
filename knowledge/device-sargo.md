# Device: sargo (Google Pixel 3a) — the GSI pilot

Google Pixel 3a (`sargo`), Qualcomm SDM670, Tier B on its stock Android 12.1 vendor: the GSI pilot, running LuneOS on the Halium 14.0 and 16.0 GSIs.

The device the whole GSI/GKI architecture was proven on. **One generic rootfs (`MACHINE=halium-arm64`, no kernel, no GSI baked in) boots sargo on both the Halium 14.0 and 16.0 GSIs over its stock Android 12.1 vendor** — `systemctl is-system-running = running`, 0 failed units, full UI, 32 audio sinks, working nyx, sensorfwd, bluebinder, bluetooth and ofono. The same build serves both GSIs.

## Platform facts

| Fact | Value |
|---|---|
| SoC | Qualcomm (Adreno) — the best-trodden libhybris path |
| Launched | Android 9; official updates through **Android 12** (final OTA May 2022) → can present vendor API level 28, 29, 30, 31 on one device |
| Kernel | 4.9.124 device kernel (**pre-GKI** — Tier B forever), LineageOS `bonito` defconfig, built by `linux-google-sargo` |
| A/B | yes (`androidboot.slot_suffix`) — exercises the initramfs A/B path |
| Dynamic partitions | **Retrofit** from Android 11: `BOARD_SUPER_PARTITION_METADATA_DEVICE := system`, block devices `system vendor` — **no partition named `super`, ever**, extents span two block devices |
| Old per-device image | `halium-luneos-9.0-*-sargo` tarballs — the thing the GSI work deletes |

## Why sargo mattered (and what it proved)

- **The control experiment**: same device, same 4.9 kernel, same Android 9 vendor, same LuneOS build — swap only `/android` from the sargo device image to a generic `halium_arm64` GSI. This proved the per-device Android build unnecessary.
- The android-headers version must **track the GSI, not the vendor** (libhybris gates Android 16 support on `ANDROID_VERSION_MAJOR >= 16` from that package). Verified ABI-safe: gralloc/hwcomposer2/hardware/lights headers byte-identical 11.0↔16.0; `audio_hw_device` unchanged member order with fields appended.
- The Tier-0 "derive, don't ship" adaptation principle: four sargo problems (33 vendor HALs never started, init blocked forever, 50 sysfs EACCES, compositor racing the HAL) each solved by deriving from the device's own rc files / HAL registry instead of shipping per-device files.

## The seven Android 16 blockers (each only visible after the previous one)

| Problem | Fix | Where |
|---|---|---|
| `***missing tool metalava***` at 86% | lunch `bp4a`, not `trunk_staging` (codename PLATFORM_VERSION builds `api_fingerprint`) | build config |
| VNDK 32 absent vs a 12.1 vendor | ship the v32 snapshot | halium device tree |
| `/init` aborts on kernel 4.9 | `MADV_WIPEONFORK` non-fatal (needs ≥4.14) | `hybris-patches` `herrie/h16-fixes` |
| `.capex` never mounted | `PRODUCT_COMPRESSED_APEX := false` | device tree |
| TLS abort in every getprop/setprop | Android 16 libhybris adaptation | `Herrie82/libhybris` `herrie/android16-tls` |
| GPU driver not found | `/vendor/lib{,64}/egl` on default LD paths | same branch |
| Boot splash never cleared | create `/dev/ashmem<boot_id>` on the host | `mount-android.sh` |

The last one is the one to remember: 0 failed units, working audio, no display — evidence only in the container's logcat (libcutils → libfmq → HIDL composer command queue).

## Retrofit dynamic partitions

`mount-android.sh` (ported from Droidian, run as `ExecStartPre` of `android-system.service`, NOT from the initramfs) + `parse-android-dynparts`, both fixed for the retrofit case: no `super` partition, LP metadata on `system`, extents spanning `system`+`vendor` (upstream parse-android-dynparts refused multi-device layouts). Covered by `tests/loopback-retrofit-test.sh` — 22 assertions on loop devices with real device-mapper; also pins the Android 9 no-metadata behaviour (exit 0, no dm nodes). Retrofit is a device *class* (most phones upgraded to 10/11 rather than launched on it), not a sargo quirk. Converting sargo to a real `super` is impossible/pointless (GPT fixed by bootloader; bad flash = EDL brick).

## The wrynose baseline (what makes sargo a usable control)

All GSI work targets `Herrie82/meta-smartphone` → `herrie/wrynose`; `MACHINE=sargo . ./setup-env` in `$BUILD_DIR`. sargo builds and boots on wrynose as of 2026-08-16. Key commits:

| Commit | Why it matters |
|---|---|
| `20949047` | 4.9 host tools vs C23 (`constexpr` in unifdef.c) — pin the host C standard; also documents the corrupt `20240307-1` vendor.img |
| `17abddfa` | `wait-for-android.sh` no longer requires LineageOS's `livedisplay`; accepts hwcomposer/gralloc/`sys.init_boot_completed`, bounded wait with services logged on timeout — a generic GSI ships no livedisplay |
| `23edbee8` | `mdev-partlabel.sh` parses uevent instead of sourcing it (bash 5.3 can't source sysfs) — restores `/dev/disk/by-partlabel`, which is what lets the stock vendor mount by name |
| `dde5391a`+`0b37a1ae` | UNPACKDIR sweep — new recipes must use `${UNPACKDIR}`, not `${WORKDIR}` |
| `810e2c57`, `03508c3e`, `28615726` | dynparts port + retrofit fix + loopback test |
| `9b32def7` | lxc: arch from TARGET_ARCH, `lxc.uts.name=android`, binderfs, APEX via `mount-apexes.py` |

`android-system-image-sargo.bb` selects device vs GSI image via `SARGO_ANDROID_SYSTEM ?= "gsi"` and the generation via `SARGO_GSI_TARBALL`/`SARGO_GSI_SHA256`. GSI tarballs in DL_DIR: 11.0, 13.0, 14.0, 16.0 (`halium-luneos-<ver>-<date>-N-halium_arm64.tar.bz2`) — **publishing them is an open action**; published releases exist for 9.0/10.0/11.0 on `webOS-ports/halium-images`.

## Known sargo-specific traps

- `init.<board>.rc` gates `post-fs-data` on `wait_for_prop vendor.qcom.time.set true` — set by `time_daemon`, which Halium doesn't run. See debugging.md §2.1; this single property unblocked modem/vibrator/sensors and cut EACCES 50→1.
- Its vendor rc gates carry **no quotes** — sargo will never catch the quoted-property bug that wedged mindphone.
- The RIL crash `Missing path for slot slot2` proved the plugin enumerates slots from the HAL, not from `ril_subscription.conf` → the committed `ofono-conf/sargo/*` files are Tier 2 debt, to be replaced by derivation.
- Shipped-placeholder rule was learned here: `luna-platform.conf` shipped `DPI=445` and the generator read it back as a fallback — a plausible constant silently wrong on every device without an adaptation. Placeholders must be obviously invalid.
- The PMIC RTC **cannot be written** - SPMI refuses it even with the device tree flipped - so the clock starts at 1970 every boot and RTC alarms are armed ~56 years out. See the RTC section below.
- 4.9 kernel has **no `CONFIG_OVERLAY_FS`** → adaptation overlays must fall back to bind-mounts on sargo.
- Atlas browser UI scaling: no LuneOS-side config fixes it — both fixes (CSS zoom, collapsing toolbar) belong in Atlas itself.

## The RTC cannot be written, and no kernel change fixes it (25 Sep 2026)

sargo boots with its hardware clock reading **1970-02-14** and nothing can correct
it. Measured, in the order that establishes it:

- `/sys/class/rtc/rtc0/date` reads 1970-02-14 while the system clock is right —
  they legitimately disagree, because `sntp`/ntpd set the *system* clock and
  nothing writes the RTC (see nyx-modules.md: nyx has no set-RTC call, and
  meta-luneos removes timesyncd on purpose).
- `hwclock -w` first fails with EBUSY, because **sleepd holds `/dev/rtc0`
  exclusively for its whole life** — the char device admits one opener, so any
  writer, and `nyx-test-system`, must have sleepd stopped first.
- With sleepd stopped it fails with **EINVAL**: `pm660.dtsi` carries
  `qcom,qpnp-rtc-write = <0>`, and qpnp-rtc only installs `qpnp_rtc_rw_ops` when
  that is true. The read-only table (`qpnp_rtc_ro_ops`) has `read_time`,
  `set_alarm`, `read_alarm` and `alarm_irq_enable` but **no `set_time`** — which is
  why alarms can be armed on this device while its clock cannot be corrected.
  (`rtc_set_time()` returns EINVAL for ops-without-set_time and ENODEV for no ops
  at all; the errno tells you which.)
- **Flipping the device tree was tried and it does not help.** A kernel with
  `&pm660_rtc { qcom,qpnp-rtc-write = <1>; }` was built and booted with
  `fastboot boot`, and `hwclock -w` then failed with ENODEV and this in dmesg:

      spmi spmi-0: error: impermissible write to peripheral sid:0 addr:0x6046
      qcom,qpnp-rtc ...: SPMI write failed
      qcom,qpnp-rtc ...: Disabling of RTC control reg failed with error:-19

  `qpnp_rtc_set_time()` did run — it got as far as disabling the RTC control
  register, which read-only ops could never reach — so the flip took effect and the
  **SPMI permission map refused the write one layer below the driver**. `0x6046` is
  the RTC control register. Qualcomm's `<0>` is not caution; it reflects who owns
  that peripheral on this platform, and only a TZ/bootloader change could alter it.
  The patch was reverted.

Consequences worth carrying to any Qualcomm port:

- **RTC alarms never fire here.** `qpnp_rtc_set_alarm()` compares the request
  against the RTC's own clock, finds a 2026 expiry comfortably in a 1970 future,
  and arms it about 56 years out. `set-alarm` succeeds and `next-alarm` round-trips
  perfectly, which makes this look like it works.
- **The `CLOCK_REALTIME_ALARM` timerfd is the only usable alarm mechanism**, since
  `CLOCK_REALTIME` is correct even when the RTC is not. That is what the watch
  added to `alarm.c` delivers, and it is why alarms now fire on sargo.
- The clock jumping mid-boot (1970 → real time, journald logging "Time jumped
  backwards, rotating") is a consequence of the same gap, so **timestamps inside a
  single sargo boot cannot be trusted** and anything using wall-clock deadlines can
  misfire across the jump.
- When testing an RTC, never judge it by comparing against the system clock alone:
  on a fresh boot both read 1970 and a delta of zero looks like success. Require a
  sane system clock first and honour `hwclock`'s exit status.

Test kit (`sargo-nyx-system`) — `test-rtc-write.sh` (the above, with the
three outcomes named), `test-system-alarm.sh` (13 passed / 0 failed / 4 skipped on
25 Sep, the skips all being these device properties), and `install.sh` with adb or
ssh transport and a `--revert`.

## Idle-health triage (12 Sep 2026)

10 h idle on a charger, alongside tissot as a comparison device (full write-up:
`LuneOS/memoryusage/findings-2026-09-12.md`). Headline: **no memory leaks** —
`surface-manager` flat at 166 MB (17 min uptime) vs 165 MB (10.5 h on tissot) —
and **no unexplained crashes**. But **neither device had suspended once this
boot**: do not rely on wake-from-suspend behaviour yet.

- **Coredumps explained, not spontaneous.** `composer@2.1-service` SIGABRT ×2 and
  `MaliitServer` SIGABRT all coincided with *explicit* `systemctl restart
  surface-manager-daemon` jobs; sargo then ran 9 h 42 m untouched. The real
  defect: **maliit-server and webapp-mgr abort instead of exiting cleanly when
  the Wayland socket disappears** ("The Wayland connection broke…" → SIGABRT).
  Not chased further.
- **Charger debug spam ≈ doubles idle flash writes.** `qpnp_smb2` ships
  `debug_mask=31`; on a charger it emitted ~4 of the ~7 kernel lines/s reaching
  journald. A/B measured: **0.19 GB/h → 0.10 GB/h** whole-disk writes with
  `debug_mask=0` (the driver's own default; the vendor config sets 31 — nothing
  in LuneOS reads these, charging state comes from `/sys/class/power_supply`
  via nyx). Fix: `/etc/tmpfiles.d/luneos-charger-debug.conf`; recipe
  `meta-luneos/recipes-core/luneos-kernel-log-quirks/` — machine-independent
  (tmpfiles `w` only writes an existing file, no-op elsewhere), and
  **deliberately not routed through luneos-device-config's sparse overlay**,
  which has no ordering against `systemd-tmpfiles-setup.service`. Remaining
  chatter: `google_charger` (~1.45 lines/s) has **no runtime knob** — silencing
  it needs a kernel patch demoting its `pr_info` calls.
- **pulseaudio at 10% of a core while silent — a Qt 6 QtMultimedia bug.** At
  end-of-media, `QGstreamerMediaPlayer::handlePlayerMessage()`'s EOS branch
  reports `StoppedState` but never calls `gst_play_stop()`, so the GStreamer
  pipeline stays `PLAYING`; `pulsesink` only corks on PLAYING→PAUSED, so one
  finished boot chime pinned `sink.primary_output` RUNNING for the compositor's
  lifetime. Proven **not** audiod-pro (it never corks others' streams; 0 CPU
  over 12 h). Fixed in
  `meta-luneos/recipes-qt/qt6/qtmultimedia/0001-gstreamer-stop-the-pipeline-at-end-of-media.patch`
  (adds `gst_play_stop()` to the EOS branch) — verified on sargo with **stock
  QML plus the rebuilt plugin alone**: 10.1% → 3.4%. No cardshell change is
  carried; the patch is `Upstream-Status: Pending` with the full measurement in
  its header. **Still open:** `luneos-speechd`'s dummy output holds its own
  uncorked stream, keeping the chain at ~3% (0.2% with both fixed).
- Housekeeping: sargo `/` is 79% full; the LXC android rootfs image is 95% full
  (fixed size, expected).

On-device state vs recipes: sargo carries `/etc/tmpfiles.d/luneos-charger-debug.conf`
and a locally rebuilt, Qt-patched `libgstreamermediaplugin.so` (original kept as
`.bak-claude`; the next image flash overwrites it — the patch is in the recipe,
so a normal build carries it). The recipes live uncommitted on `meta-webos-ports`
`herrie/rebased`.

## What sargo can and cannot test

**Can:** vendor API 28→31 ladder on one device, A/B, retrofit dynparts, FBE/AVB/APEX (from A10 vendor up), the whole generic-rootfs claim, Halium 14/16 GSIs over a 12.1 vendor.
**Cannot:** GKI Tier A (pre-GKI 4.9 kernel), the `init_boot` path (A13-launch only), anything above vendor API 31 as a *vendor* (AIDL IComposer, gralloc5 vendors, VNDK-less A15+ vendors).

Recommended: keep a second sargo (~€50–70) as a known-good reference while bricking the first; check `getprop ro.vndk.version` on LineageOS 22 before assuming sargo can't go higher.
