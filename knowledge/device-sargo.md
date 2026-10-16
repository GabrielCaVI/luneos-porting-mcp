# Device: sargo (Google Pixel 3a, Qualcomm SDM670)

Google Pixel 3a (`sargo`), Qualcomm SDM670, Tier B on its stock Android 12.1 vendor: the GSI pilot, running a full LuneOS UI on the Halium 14.0 and 16.0 GSIs.

The device the GSI/GKI architecture was proven on. One generic rootfs (`MACHINE=halium-arm64`, no kernel, no GSI baked in) boots sargo on both the 14.0 and 16.0 GSIs over its stock vendor: `systemctl is-system-running = running`, 0 failed units, full UI, 32 audio sinks, nyx, sensorfwd, bluebinder/Bluetooth and ofono working. It is the control device for the rest of the project, and where the derive-don't-ship adaptation model and the placeholder rule were learned (architecture.md § The adaptation tier model).

## Status (as of 7 Oct 2026)

| Area | State | Notes |
|---|---|---|
| Boot, UI | works (hardware) | Halium 16 GSI over the 12.1 vendor |
| Wi-Fi | not recorded | qcacld; `wlan-suspend-mode` arms firmware packet filtering with the display off (unverified on the phone) |
| Bluetooth | works | bluebinder |
| Modem / telephony | works | ofono; after the `wait_for_prop` fix (below) |
| Audio | works | 32 sinks |
| Sensors | works | sensorfwd; Waydroid gets them through `waydroid-sensors` |
| Camera | works, flaky provider | `camera-droid-heal` restarts the provider when its sensor probe comes up invalid (~half of boots) |
| NFC | partial | reaches `RF_DISCOVER` without error after the Tier 2 `libncicore.conf` and its `Before=nfcd.service` ordering; no tag read yet |
| Alarms / RTC | alarms work via timerfd; RTC cannot be written | below |
| Waydroid | boots | after the socket and `configstore` fixes |
| Suspend | unverified | the idle triage saw no suspend in 10 h (Subsystem notes) |

## Platform facts

| Fact | Value | Source |
|---|---|---|
| SoC | Qualcomm SDM670 (Adreno) — the best-trodden libhybris path | |
| Launched / last OTA | Android 9; official updates through Android 12 (final OTA May 2022) → can present vendor API 28, 29, 30, 31 on one device | |
| Kernel | 4.9.124 (pre-GKI, Tier B for good), `lineageos_bonito_defconfig` | `linux-google-sargo_git.bb` |
| A/B | yes (`androidboot.slot_suffix`); no recovery partition | |
| Dynamic partitions | **retrofit, from Android 10** (`PRODUCT_RETROFIT_DYNAMIC_PARTITIONS := true` in AOSP device/google/bonito `android-10.0.0_r1`): `BOARD_SUPER_PARTITION_METADATA_DEVICE := system`, block devices `system vendor`, no partition named `super` | AOSP device/google/bonito |
| Display | 1080x2220 | `sargo.conf` |
| Console | `ttyMSM0` | `sargo.conf` |
| userdata | ~50 GB, `/dev/mmcblk0p72` | kit |

## Kernel

`linux-google-sargo`: github.com/shr-distribution/linux branch `sargo/4.9.124/lune`
(SRCREV `eadf7289`), `lineageos_bonito_defconfig` + the Halium options. It builds its own
modules, so no KMI is at stake; module signing uses a fixed key committed to the layer
(`module-signing/luneos-module-signing-key.pem`) so kernel and modules agree across
rebuilds.

- The kernel host tools need the host C standard pinned: `unifdef.c` uses `constexpr` as an
  identifier (kernel-porting.md § Old BSP vs modern toolchain).
- The stock defconfig has no `CONFIG_OVERLAY_FS`; `halium-kernel.inc` turns it on, so the
  Tier 2 overlay path is used rather than the bind-mount fallback (confirmed on the phone).
- `MADV_WIPEONFORK` (needs ≥ 4.14) is made non-fatal in the GSI's init (blocker table below).
- sargo is the test bed for "does anything need fanotify": `LUNEOS_TEST_NO_FANOTIFY = "1"`
  builds the kernel without it (kmi-crc-matching.md § Does anything actually need
  FANOTIFY or CGROUP_DEVICE?).

## Boot image

Header v2, 4096-byte pages, dtb in its own section (stock and TWRP both use this; a v0 image
is refused with "Error boot prepare"). `boot-sargo-luneos.img` ≈ 23.4 MB: 4.9.124 kernel +
LuneOS initramfs + SDM670 dtb, deployed as `Image.gz-dtb-sargo.fastboot`.

**The bootloader drops command-line arguments it does not recognise** (measured with a
`zz.marker=1` canary), so an `enable_adb` in the boot header never reaches `/proc/cmdline`.
The debug image is a kernel rebuild with `LUNEOS_ENABLE_ADB=1`, which puts `enable_adb` into
`CONFIG_CMDLINE` (`make-debug-boot.sh` in the kit does it); rule: kernel-porting.md § The
kernel command line. The same applies to `no_low_battery_hold`. With the current initramfs
default `USB_FUNCTIONS=rndis` the debug image offers telnet (192.168.2.15, port 23), not adb;
adb needs `adb` back in `USB_FUNCTIONS` (sargo's kernel has `USB_CONFIGFS_ECM`/`_ACM` unset).

## Vendor and GSI

Stock Android 12.1 vendor (VNDK 32), mounted from the phone (`SARGO_ANDROID_VENDOR = "none"`).
`android-system-image-sargo.bb` defaults to the GSI (`SARGO_ANDROID_SYSTEM ?= "gsi"`), taking
the generation from `halium-luneos-gsi-16.inc`; the old per-device
`halium-luneos-9.0-*-sargo` image is reachable only by setting either knob back to
`device` (its `20240307-1` vendor.img is corrupt; the recipe restores `20240301-3` from a
shipped testing package). Published `halium_arm64` GSIs for 9.0, 11.0, 13.0, 14.0 and 16.0
are on github.com/webOS-ports/halium-images (release `halium-luneos-20260826` carries all
five); android-headers track the GSI (device-bringup-yocto.md).

The control experiment that started it all: same device, same 4.9 kernel, same Android 9
vendor, same LuneOS build, only `/android` swapped from the sargo device image to a generic
`halium_arm64` GSI. It proved the per-device Android build unnecessary.

### The seven Android 16 blockers (each visible only after the previous one)

| Problem | Fix | Where |
|---|---|---|
| `***missing tool metalava***` at 86% | lunch `bp4a`, not `trunk_staging` | build config (gsi-building.md § Trap 1) |
| VNDK 32 absent vs a 12.1 vendor | ship the v32 snapshot | device tree |
| `/init` aborts on kernel 4.9 | `MADV_WIPEONFORK` non-fatal | `hybris-patches` `herrie/h16-fixes` |
| `.capex` never mounted | `PRODUCT_COMPRESSED_APEX := false` | device tree |
| TLS abort in every `getprop`/`setprop` | TheKit's Android 16 libhybris adaptation | `Herrie82/libhybris` `herrie/android16-tls` |
| GPU driver not found | `/vendor/lib{,64}/egl` on the default LD paths | same branch |
| Boot splash never cleared | create `/dev/ashmem<boot_id>` on the host | `mount-android.sh` (debugging.md § 2.4) |

The last one is the one to remember: 0 failed units, working audio, no display, and the only
evidence in the container's logcat.

## Yocto

Layer `meta-google`, `MACHINE=sargo` (`sargo.conf`), in `$BUILD_DIR` with
`MACHINE=sargo . ./setup-env`. The machine builds only the boot image; the rootfs is the
generic `halium-arm64` one. A `MACHINE=sargo` rootfs once shipped without Waydroid because
`packagegroup-luneos-extended` appends it only for `halium-arm64` (device-bringup-yocto.md §
The generic halium-arm64 machine). What is sargo-specific lives in `luneos-device-config`:
`adaptations/sargo/deviceinfo` (scaling, key devices), `sparse/etc/libncicore.conf` (NFC),
`70-sargo.rules` (32 udev rules beyond `65-android.rules`), and `stubbed-services.d/sargo`.

```
MACHINE=sargo bitbake linux-google-sargo     # → Image.gz-dtb-sargo.fastboot (= boot.img)
```

Changes in meta-smartphone (`herrie/wrynose-structured`) that sargo needed and every later
port inherits:

| Commit | What |
|---|---|
| `e52e8357` | kernel host tools vs C23; documents the corrupt `20240307-1` vendor.img |
| `c5eabe2d` | Android counts as up without LineageOS's `livedisplay` (a generic GSI ships none): hwcomposer/gralloc/`sys.init_boot_completed`, bounded wait, services logged on timeout |
| `4815b208` | `mdev-partlabel.sh` parses uevent instead of sourcing it (bash 5.3 cannot source sysfs) — restores `/dev/disk/by-partlabel`, which the stock vendor mount needs |
| `92664d81`, `6d9d712b` | Android partitions mounted from systemd with dynamic partitions; retrofit support in `parse-android-dynparts` |
| `d6e0ae16` | lxc: arch from `TARGET_ARCH`, `lxc.uts.name=android`, binderfs, APEX mounts |

## Install

Only `boot` (the active slot) and `userdata` are touched; no vbmeta is flashed. The bootloader
is unlocked (`androidboot.vbmeta.device_state=unlocked`, `verifiedbootstate=orange`), and in
that state AVB reports without enforcing.

```
adb reboot bootloader
./install.sh          # prints current-slot, then boot → userdata → reboot
```

Flashing the inactive slot and rebooting is a silent no-op that looks like a failed port.
The userdata image holds `rootfs.img` + `android-rootfs.img` side by side (halium
`file_layout`) and grows on first boot. Revert with Google's factory image. Converting sargo
to a real `super` is impossible and pointless (GPT fixed by the bootloader; a bad flash is an
EDL brick).

## Subsystem notes

### Retrofit dynamic partitions

`mount-android.sh` (ported from Droidian, run as `ExecStartPre` of `android-system.service`)
and `parse-android-dynparts` handle the retrofit case: no `super`, LP metadata on `system`,
extents spanning `system` + `vendor` (upstream refused multi-device layouts).
`tests/loopback-retrofit-test.sh` covers it with 22 assertions on loop devices with real
device-mapper, and pins the Android 9 no-metadata behaviour (exit 0, no dm nodes). Retrofit is
a device class (most phones upgraded to 10 rather than launched on it), not a sargo quirk.

### Init stuck on `wait_for_prop`

`init.<board>.rc` gates `post-fs-data` on `wait_for_prop vendor.qcom.time.set true`, set by
`time_daemon`, which Halium does not run. Setting it brought up the modem (`per_mgr`,
`per_proxy`, `pd_mapper`, `qcrild`), fixed the vibrator restart loop, zeroed the sensors' QMI
errors and cut EACCES from 50 to 1 (debugging.md § 2.1). sargo's vendor gates carry no
quotes, so it never hit the quoted-property bug (debugging.md § 2.2).

### RIL slots

`Missing path for slot slot2` showed that the plugin enumerates slots from the HAL, not from
`ril_subscription.conf`; the committed `ofono-conf/sargo/*` files are Tier 2 debt to be
replaced by derivation.

### The RTC cannot be written

The hardware clock reads 1970-02-14 every boot and nothing can correct it. In the order that
establishes it:

- `/sys/class/rtc/rtc0/date` disagrees with the system clock legitimately: sntp sets the
  system clock and nothing writes the RTC (nyx-modules.md § Wakeup alarms).
- `hwclock -w` first fails with EBUSY: sleepd holds `/dev/rtc0` exclusively for its whole life;
  stop it first (also for `nyx-test-system`).
- Then EINVAL: `pm660.dtsi` sets `qcom,qpnp-rtc-write = <0>`, so qpnp-rtc installs
  `qpnp_rtc_ro_ops`, which has `read_time`, `set_alarm`, `read_alarm` and `alarm_irq_enable`
  but no `set_time` — alarms can be armed while the clock cannot be set. (`rtc_set_time()`
  returns EINVAL for ops without `set_time`, ENODEV for no ops.)
- **Flipping the device tree does not help.** With `&pm660_rtc { qcom,qpnp-rtc-write = <1>; }`
  booted via `fastboot boot`, `hwclock -w` fails with ENODEV:

      spmi spmi-0: error: impermissible write to peripheral sid:0 addr:0x6046
      qcom,qpnp-rtc ...: SPMI write failed
      qcom,qpnp-rtc ...: Disabling of RTC control reg failed with error:-19

  `qpnp_rtc_set_time()` ran, so the flip took effect, and the SPMI permission map refused the
  write to the RTC control register (`0x6046`) one layer below the driver. Only a TZ or
  bootloader change could alter that; the patch was reverted.

Consequences:

- **RTC alarms never fire.** `qpnp_rtc_set_alarm()` compares a 2026 expiry against the RTC's
  1970 clock and arms it ~56 years out, while `set-alarm`/`next-alarm` round-trip perfectly.
  The `CLOCK_REALTIME_ALARM` timerfd, now watched in `alarm.c`, is what makes alarms fire here.
- The clock jumps mid-boot (journald: "Time jumped backwards, rotating"), so timestamps within
  one boot cannot be trusted and wall-clock deadlines can misfire across the jump.
- Never judge an RTC test against the system clock alone: on a fresh boot both read 1970 and a
  zero delta looks like success. Require a sane system clock and honour `hwclock`'s exit status.

Test kit `sargo-nyx-system`: `test-rtc-write.sh` (the three outcomes above),
`test-system-alarm.sh` (13 passed / 0 failed / 4 skipped, the skips being these device
properties), `install.sh` over adb or ssh with `--revert`.

### Idle health

10 h idle on a charger, measured beside tissot (method in debugging.md § Stage 5): no
memory leaks (`surface-manager` 166 MB at 17 min vs 165 MB at 10.5 h on tissot) and no
unexplained crashes, but no suspend at all in that boot.

- Coredumps of `composer@2.1-service` (SIGABRT ×2) and `MaliitServer` coincided with
  explicit `systemctl restart surface-manager-daemon`. The defect: **maliit-server and
  webapp-mgr abort instead of exiting when the Wayland socket disappears** ("The Wayland
  connection broke…" → SIGABRT). Not chased further.
- `qpnp_smb2` ships `debug_mask=31` (~4 of ~7 kernel lines/s on a charger): 0.19 → 0.10 GB/h
  whole-disk writes with `debug_mask=0`. Fixed by a `tmpfiles.d` rule
  (`meta-luneos/recipes-core/luneos-kernel-log-quirks/`); the boot header also carries
  `qpnp_smb2.debug_mask=0`, which this bootloader may drop.
  `google_charger` (~1.45 lines/s) has no runtime knob; silencing it needs a kernel patch.
- **pulseaudio at 10% of a core while silent** — Qt 6 QtMultimedia's EOS branch reports
  `StoppedState` without calling `gst_play_stop()`, so one boot chime kept
  `sink.primary_output` running. Fixed by
  `meta-luneos/recipes-qt/qt6/qtmultimedia/0001-gstreamer-stop-the-pipeline-at-end-of-media.patch`
  (10.1% → 3.4%, `Upstream-Status: Pending`). Not audiod-pro (0 CPU over 12 h).
  `luneos-speechd`'s dummy output still holds an uncorked stream (~3%; 0.2% with both fixed).
- Power stubs in `stubbed-services.d/sargo`: `diag_mdlog` (the `DIAG_WS` suspend aborter, 7
  aborts/min → 0; stubbed to exit, since it is `exec_start`ed as a oneshot), `ssr_diag`, the
  health HAL `android.hardware.health@2.0-service.bonito` and `storaged` (nothing in LuneOS
  consumes the health HAL; `healthd` armed a 60 s alarm that woke the SoC every minute).
- `/` is 79% full; the LXC android image 95% (fixed size, expected).

### Waydroid

Two faults kept Android in the container from reaching `sys.boot_completed`: the session
bind-mounted `/tmp/xdg/wayland-0` by inode, so a compositor restart left the container on a
dead socket (`waydroid-luneos-session.service` now has `PartOf=surface-manager-daemon.service`);
and `configstore` is stubbed on the host while Waydroid's SurfaceFlinger asks the host
hwservicemanager for it through `/dev/host_hwbinder` (`waydroid-luneos-prepare` now sets the
nine `ro.surface_flinger.*` props). Prop setters run after `waydroid upgrade -o`, which
regenerates `waydroid_base.prop`.

### Browser (Atlas) scaling

Measured over Chromium's remote debugging port (1080x2220, 441 PPI; rule: hal-userspace.md §
Browser (Atlas) UI scaling): `webapp-mgr.sh` passes `--force-device-scale-factor` 2.4 (from
`com.webos.surfacemanager.devicePixelRatio`); adding it to browser_shell crops the toolbar
(verified at 1.5 and 2.75). The Atlas-side fixes: `document.documentElement.style.zoom`
(verified 1.5–2.4, 2.4 preferred by eye), and collapsing the toolbar buttons while the address
bar is focused (address bar 115 → 323 device px at zoom 2.4).

## Open issues

- `luneos-speechd`'s uncorked stream; maliit/webapp-mgr abort on Wayland loss.
- Suspend never observed in the idle triage; do not rely on wake-from-suspend yet.
- `ofono-conf/sargo/*` to be replaced by slot derivation.
- The layer's `lineageos_bonito_defconfig` still sets `CONFIG_SYSVIPC=y`; LuneOS does not
  need it — drop it from the layer.

## Device-specific traps

- **What sargo can test:** the vendor API 28→31 ladder on one device, A/B, retrofit
  dynamic partitions, FBE/AVB/APEX (from an A10 vendor up), the generic-rootfs claim,
  Halium 14/16 GSIs over a 12.1 vendor.
- **What it cannot:** GKI Tier A, the `init_boot` path, anything above vendor API 31
  as a vendor (AIDL composer, gralloc5 vendors, VNDK-less A15+ vendors). Check
  `getprop ro.vndk.version` on LineageOS 22 before assuming it cannot go higher.
- Keep a second sargo as a known-good reference.

## Sources

- https://android.googlesource.com/device/google/bonito/+/refs/tags/android-10.0.0_r1
- https://github.com/shr-distribution/linux/tree/sargo/4.9.124/lune
- https://github.com/webOS-ports/halium-images/releases
