# Device: mp01 (Minimal Phone MP01, MT6789)

Minimal Phone MP01 (`MP01`, vendor codename Z10), 4.3" E Ink QWERTY phone on MediaTek Helio G99 (MT6789), Tier A on MediaTek's mgk kernel; boots to the LuneOS UI.

From The Minimal Company; the first LuneOS port to an electrophoretic display. Same
SoC and same MediaTek `mgk` android12-5.10 kernel generation as the Zinwa Q25 — read
device-q25.md first, most of it applies. The port that produced most of the MediaTek
GKI debugging method: a failing MP01 is completely mute (storage, USB and watchdog are
all vendor modules, no UART, an E Ink panel behind another module), so `expdb`, the
watchdog, the two-UDC bug and ramdisk-compression matching were all found here
(debugging.md § Stage 0, § Debug channels, § Stage 1).

## Status (as of 25 Sep 2026)

Boots to the LuneOS UI on the shared `halium-arm64` rootfs; LuneOS runs on slot b,
slot a keeps stock Android.

| Area | State | Notes |
|---|---|---|
| Boot, container | works (hardware) | `cgroup_disable=net_prio` breaks a boot/shutdown deadlock (Kernel) |
| Display / UI | works (hardware) | rotated E Ink panel; patched `mediatek-drm.ko` replaces the vendor's; refresh-mode service done |
| Touch, keyboard | works (hardware) | |
| Wifi | works (hardware) | power-on race with `wmt_launcher` open |
| Modem / cellular | works (hardware) | |
| Bluetooth | works (hardware) | classic and LE scanning |
| Audio | works (hardware) | 48 kHz, VNDK-preferring libbase (Subsystem notes) |
| Camera | works (hardware) | rear 16 MP and front sensor both fitted |
| NFC | works (hardware) | NXP PN8x; Waydroid patch keeps `nfcd` alive |
| Fingerprint | conflict | reader confirmed working by the owner, but both vendor HALs are stubbed (they block suspend); see Open issues |
| Sensors | works (hardware) | |
| Charging detection | works (hardware) | `online=2` handled in nyx-modules |
| Battery percentage | broken | fuel gauge reports `capacity=-1` |
| Suspend | works with fingerprint HALs stubbed | 3240 freeze aborts in 90 min before |
| Web apps in portrait | broken | cropped (548x600 of a 600x657 card); landscape fine |

## Platform facts

All from the vendor's own SP Flash Tool package (`Z10_20251226_user_smr6.zip`, build
`alps-mp-s0.mp1-V17.88`), which Minimal publish at
<https://minimalcompany.dev/blog/tags/update>.

| Fact | Value |
|---|---|
| Codename | **`Z10`** in `flash.xml`/scatter/preloader and over fastboot (`getvar product`); `ro.product.vendor.device=MP01` is what `luneos-device-config` reads |
| SoC | **MT6789** — scatter, and the vendor's own flashing guide. Spec sites claiming MT6769/G85 are wrong |
| Stock kernel | `5.10.233-android12-9-00062-g49c66df526b8-ab13101360` (boot.img banner), clang r416183b, `CONFIG_ARCH_MEDIATEK=y`, `Image.gz` |
| Partitions | A/B, 64 MiB `boot`, 9216 MiB `super`, `init_boot_a/b` in the scatter but unused (no `init_boot.img` ships) |
| Vendor API | 31 (Android 12 vendor, `alps-mp-s0`) |
| Vendor modules | 345 stock modules; 180 in the `vendor_boot` ramdisk (vendor_boot ramdisk 22.5 MB) |
| Display | 4.3" E Ink 600×800, `CONFIG_DRM_PANEL_Z10_EINK_VDO=m` — a **DSI video-mode DRM panel**, Pango FPGA doing DSI→EPD; mounted rotated |
| Keyboard | AW9523B I2C expander, `aw9523b-key`. Key table includes **`Volup`**, so pin key devices by name |
| Touch | FocalTech, `focaltech_touch.ko` |
| Storage | 108.8 GiB userdata (**scatter declares 3 GiB — nominal, ignore it**; `fastboot getvar partition-size:userdata` = `0x1b357f8000`) |
| Connectivity | `gen4m_6789` / `connac1x` / `gps_drv_stp` / `mt6631_6635` — character-for-character the Q25's |
| NFC | NXP PN8x (`nxpnfc_i2c`, `/dev/nxpnfc`, `ro.hardware.nfc_nci=pn8x`) |
| Audio amp | `oca72xxx_pa` (`6-0058`); the DT's `rt5512@5c` is a second-source part not populated (`chip id check fail, ret = -6`) |
| BT | MediaTek (manufacturer `0x0046`), address from nvram `BT_Addr` |
| USB | stock config sets `CONFIG_USB_DUMMY_HCD=y` → two UDCs, `dummy_udc.0` and `musb-hdrc` |

## Kernel

- **Tree:** `shr-distribution/linux`, branch `mp01/5.10.233/lune`, SRCREV
  `7fb2662e0ded8c6c65ff110250f4cccb25d8620b` — Minimal's own source ("initial
  publish" `6ca3cc4`, published 15 Sep 2026) plus LuneOS's commits on top. Fixes go
  as commits on that branch and a SRCREV bump, never as patches in the layer. It
  carries what the Q25's tree lacks: the E Ink panel drivers (`panel-z10-eink-vdo`,
  `panel-z10-eink-i2c`) and the MediaTek v2 display driver this device runs.
- **Config:** the MP01's stock `.config` (shipped loose in the factory image as
  `merged/.config`) verbatim as the base, then `vermagic.cfg`, then `luneos.cfg`;
  `LUNEOS_KERNEL_FRAGMENT ?= "1"` is the baseline switch. Toolchain clang r416183b
  (the stock config's own `CONFIG_CC_VERSION_TEXT`; the same release the Q25 uses).
- **Vermagic** matches stock exactly: the tree is genuinely 5.10.233, and
  `vermagic.cfg` sets `CONFIG_LOCALVERSION="-android12-9-gdeb4d30d3489"` with
  `LOCALVERSION_AUTO` off and an empty `.scmversion` (kmi-crc-matching.md § Step 0 —
  ask the modules, they know).
- **KMI:** 0 of 345 stock modules would fail. As on the Q25, `USER_NS` stays off
  (device-q25.md § Kernel) and `IPC_NS` is off; `PID_NS` and `CHECKPOINT_RESTORE`
  are clean.
- **ThinLTO:** stock `CONFIG_LTO_CLANG_FULL=y` makes `ld.lld -r -o vmlinux.o` run
  single-threaded (93.6% of one core on a 64-thread host, ~20 min);
  `KERNEL_LTO_THIN = "1"` in mp01.conf drops it to 6m04s and is KMI-neutral
  (genksyms works on preprocessed source) — verified 0/345 both ways.
- **Command line:** `????????????????????log_buf_len=4M printk.devkmsg=on
  initcall_debug=0 loglevel=4 cgroup_disable=net_prio`. The 20 `?` absorb lk eating
  the first 20 characters; `initcall_debug=0 loglevel=4` undo a vendor_boot cmdline
  that turns both on. `cgroup_disable=net_prio` breaks a deadlock measured here at
  boot and shutdown — net_prio's `cgrp_css_online()` takes rtnl under cgroup_mutex,
  connmand holds rtnl in `ccmni_close()` waiting on an "events" work item, and every
  events kworker waits on cgroup_mutex in `cgroup_bpf_release()`; PID 1 then blocks
  in `proc_cgroup_show` (kernel-porting.md § The kernel command line).
- **Own module in the initramfs:** the patched `mediatek-drm.ko` (stripped; 37 MB
  unstripped against the vendor's 5.8 MB) is installed at `lib/modules/` and wins
  over the vendor's copy in the concatenated ramdisk; `load_kernel_modules()` then
  loads it in the vendor's order. `/override/modules` cannot be used: it runs before
  the vendor set and `mediatek-drm` imports 487 symbols from vendor modules.

### Rejected paths

- **Building the Q25's tree against the MP01's config.** Before Minimal published
  source, `linux-minimal-mp01` built `LineageOS/android_kernel_xelex_mt6789`
  (5.10.198) against the MP01's stock config: 0 of 345 would fail, with zero
  mismatches on any `vmlinux`-exported symbol (the two stock configs differ by 85
  options out of 2,665, all board-level drivers). It needed `SUBLEVEL = 233` and a
  `tree-fixup.cfg`: list-valued options (`CONFIG_TOUCHSCREEN_MTK_TOUCH`,
  `CONFIG_CUSTOM_KERNEL_IMGSENSOR`) name source subdirectories, and `olddefconfig`
  can drop unknown symbols but not directories that do not exist (`No rule to make
  target .../focaltech_touch/Makefile`).
- **Embedding all 180 vendor modules in our initramfs.** 5.5 MB compressed took the
  ramdisk from 6.6 to 14.8 MB and the boot image from 28 to 31.6 MB, after which
  our init stopped running entirely — no kmsg, no panic, nothing in expdb, on six
  consecutive images. lk evidently will not load the larger image; the 64 MiB
  partition is not the constraint, the combined ramdisk (ours plus vendor_boot's
  22.5 MB) is. The port relies on the bootloader concatenating vendor_boot's ramdisk
  instead. If `/lib/modules` ever turns out missing, embed a minimal set (storage +
  USB + watchdog) and keep the image near 28 MB. Use `install`, not `cp -a`, in such
  a recipe (`cp -a` keeps the extractor's uid: `KeyError: 'getpwuid(): uid not
  found: 1000'`).

## Boot image

Header **v4**, 64 MiB `boot`, kernel + non-zero ramdisk (stock: kernel 19,652,970
B, ramdisk 1,380,093 B), no `init_boot`. `os_version` `0x1800063C` = 12.0.0 /
**2099-12** — Minimal ship a deliberately far-future patch level; reproduce it,
never write a lower value. Both stock ramdisks (boot and vendor_boot) are **LZ4
legacy** (`02 21 4c 18`), so `GKI_RAMDISK_COMPRESSION = "lz4-legacy"`: with a gzip
ramdisk behind the lz4 vendor ramdisk ours was never unpacked, the vendor's `/init`
ran and the device landed in **Android Recovery** ("Try again / Factory data
reset") — debugging.md § 1.10 Ramdisk compression must match across the
concatenation. `ANDROID_BOOTIMG_DEBUG_CMDLINE = "enable_adb"` for the debug image.

## Vendor and GSI

Android 12 vendor, VNDK 31 → Halium 16 `halium_arm64` GSI (carries
`com.android.vndk.v31`).

## Yocto

Layer `meta-smartphone/meta-minimal`, `MACHINE=mp01`; rootfs `MACHINE=halium-arm64`.

| Recipe / file | Role |
|---|---|
| `conf/machine/mp01.conf` | boot image only; `GKI_KERNEL_PROVIDER = "linux-minimal-mp01"`, `Image.gz`, lz4-legacy ramdisk, cmdline, ThinLTO, `mediatek-drm` in the initramfs |
| `recipes-kernel/linux/linux-minimal-mp01_git.bb` + `files/` (`mp01-stock.config`, `vermagic.cfg`, `luneos.cfg`) | kernel |
| `recipes-bsp/mp01-vendor-modules` | the embed-all-vendor-modules recipe from the rejected path; not in the image |
| `recipes-core/luneos-device-config/.../MP01-deviceinfo` | Tier 1 adaptation (E Ink scale, compositor geometry, audio, BT, battery keys) |
| `recipes-core/initrdscripts/.../mp01/machine.conf` | sets the frontlight to 3 of 80 as soon as the LED driver is up |
| `recipes-core/android-system/.../stubbed-services-mp01` | per-codename stub list in the generic rootfs |

`org.webosports.service.eink` (einkd) comes in via `MACHINE_EXTRA_RRECOMMENDS`.
Before re-cutting the kit: `boot-mp01-luneos*.img` from `tmp/deploy/images/mp01/`,
`rootfs.img` from `tmp/deploy/images/halium-arm64/`, then `make-userdata.sh`.

## Install

The staging kit (`mp01_20260914.zip`) is modelled on the Q25's, with four
differences:

1. **All three vbmeta images** are attempted, but lk only exposes the top-level one
   (`has-slot:vbmeta_system` is empty; flashing it gives `partition does not
   exist`). Harmless: `--disable-verity --disable-verification` on the top-level
   vbmeta disables the chain.
2. **Lock-state check first.** A locked MediaTek lk does not report itself locked;
   it refuses critical partitions individually with `FAILED (remote: 'No support by
   lock control')`. If `flashing get_unlock_ability` is `false`, the unlock is
   refused too — that switch only exists inside booted Android.
3. **Partition-size check** before flashing userdata (the scatter's 3 GiB is
   nominal).
4. **No `fastboot -w`** (fails on the host: `make_f2fs failed`), on top of the Q25's
   no-`fastboot boot` rule (device-q25.md § Install). Flash `userdata-luneos.img`
   (or stock `userdata.img`) instead.

Device specifics:

- Fastboot entry: power fully off, **Volume Up + Power**, navigate with Vol Up,
  select with **Vol Down**. BROM: hold **Volume Down** through a forced restart
  (confirmed on hardware); a device in a reset loop also presents the preloader on
  every cycle for mtkclient.
- It does not power off with a long press while USB is connected (MediaTek
  auto-boots on USB power).
- `fastboot getvar current-slot` right after `--set-active` can report the old
  slot; flash `boot_b`/`vbmeta_b` explicitly. A slot that failed to boot is marked
  `slot-unbootable` and lk silently falls back; `--set-active` does not clear it.
- `vendor_dlkm` is inside `super`, not a fastboot partition. For LuneOS only
  `boot_b`, `vbmeta_b` and `userdata` are flashed.
- Full recovery that worked: flash stock boot/vendor_boot/dtbo/vbmeta to the slot,
  boot Android, charge to 100%, then reflash LuneOS.

## Subsystem notes

### Display and E Ink refresh

The panel is DSI, so from the SoC's side it is an ordinary MediaTek DRM display.
Refresh mode: `panel-z10-eink-i2c.ko` (the Pango CPLD's I2C side) exposes one
write-only command register,
`/sys/bus/i2c/drivers/eink_cpld/7-004b/eink_cpld_registers`, plus a read-only
`refresh_mode` mirror (0..3). Measured on the phone:

| write | effect |
|---|---|
| 1 | waveform 0: full greyscale, slowest, cleanest (stock "Slow") |
| 2 | waveform 1: greyscale, clearer and less ghosting than 1 |
| 3 | waveform 2: nearly two-level - crisp text, images lose their greys |
| 4 | waveform 3: fastest, most ghosting (stock "Ultra") |
| 5 | clear (full refresh); stock follows it with 3, then restores the mode 100 ms later |
| 6/7/8/10-15 | read-backs into dmesg (CPLD id, fw version 36, waveform version 16, VCOM ...) |
| 9 | **reprograms the CPLD's flash** from the module's embedded bitstream - never write casually |

Every switch among 1, 3 and 4 is silent; **entering 2** — from 1, 3 or 4 alike — is
a double clearing flash. That decides every policy below.

Stock (jadx on `services.jar` and the MiniEink apk): `DisplayManager.setRefreshMode(int)`
writes that file; `MinimalRefreshService` offers Slow (1), Hybrid (1, with 4 while a
`WindowMonitor` sees scrolling/animation/video) and Ultra (4), per-app modes, and
`forceFullRefresh` = 5, 3, restore. The key between the volume keys is keycode 252
(`AREFRESH`): short press = full refresh, 400 ms hold = quick settings; Home also
triggers a full refresh 500 ms after each press.

LuneOS: `org.webosports.service.eink` (einkd, C, modelled on torchd) owns the
register: `getStatus` (subscribable), `setMode`, `setActive`, `refresh`, `watchKey`.
Modes Slow, Balanced (default), Auto, Text, Ultra, persisted as systemservice
preference `einkRefreshMode`. It reads keycode 252 from evdev (`mtk-kpd`, event1):
short press = full refresh, long press = the shell's popup. luna-next-cardshell's
`Connectors/EinkRefresh.qml` derives "moving" from `frameSwapped` (6 frames in 250
ms) and "still" from 1 s without a frame, for Auto (1 at rest, 4 while moving — the
flash-free pair); `Notifications/EinkRefreshMenu.qml` is the popup; and
`AppTweaks.disableAnimations` (forced on when the service reports a panel) makes the
launcher tab switch, card open/close and launch-bar transitions instant. Settings >
Display has the same controls.

Also: 16-level greyscale (dark themes are unusable); `deviceinfo_display_dpi=233` /
`device_pixel_ratio=1.333` are arithmetic, not tuned — expect the legible DPI to be
larger, since hairlines vanish on E Ink. The frontlight brightness setting scales to
25% outdoors (`deviceinfo_backlight_outdoor_scale`): the panel is reflective, so
daylight needs less light, not more. lk lights the frontlight fully for its logo
(signed bootloader).

### Bring-up fixes

| Area | Finding | Fix |
|---|---|---|
| Reboot every ~3.5 min | clean shutdowns from `sleepd` | masked during bring-up |
| Power-off within a minute on the charger | fuel gauge `capacity=-1` ("cali car tune 119, invalid" from MediaTek's closed `libfgauge_gm30.so`) trips batteryd's critical check | `deviceinfo_battery_critical_percent="0"` (stopgap) |
| `Charging:false` on the cable | mt6375 reports `online=2` | nyx-modules `919ab0c` |
| Compositor spins on DRM master | charger-mode boot (`bootreason=usb`); Android's `charger` holds master; `QT_QPA_FORCE_HWC2` lost to an `export` prefix (systemd ignores `export` lines in `EnvironmentFile=`) | `/system/bin/charger` in `DISPLAY_CONFLICT_MATCH` (the meta-luneos copy of `start-android-hals.sh` is the one that ships), generator writes plain `KEY=VALUE` |
| Compositor never starts | patched display driver needed by the vendor hwcomposer | own `mediatek-drm.ko` (Kernel) |
| No audio, no camera | container's `/vendor_dlkm` was an empty bind, vendor `insmod_sh` loaded nothing | `mount-android.sh`: `_a`/`_b` dm names, bind `/android/vendor_dlkm` (hal-userspace.md § Vendor kernel modules) |
| Sound card never registers | `mt6789-mt6366` defers (`snd_soc_register_card fail -517`) until `mtk-btcvsd` (component `mtk-btcvsd-snd`) loads; found via `/sys/kernel/debug/devices_deferred`, `asoc/components` and the machine node's phandles in a pulled `/proc/device-tree` | load `mtk-btcvsd` (hal-userspace.md § Audio) |
| pulseaudio crash | vendor `libnvram.so` needs VNDK 31 `libbase` (`android::base::Basename`) | `deviceinfo_hybris_prefer_vndk="1"`, proven first with `systemctl set-environment HYBRIS_PREFER_VNDK=1` |
| Audio slightly off | HAL DL paths at 48 kHz | `deviceinfo_audio_sample_rate="48000"` |
| No WiFi/BT modules | `mtk-connectivity` conditions only checked `vendor` | `9d68df46` |
| BT dead | wrong HAL name, bad restart order, Synchronization Train over-reported | `mtk-bt-bringup.sh`, `deviceinfo_bluebinder_ext_features_page_2_mask="0x0400000000000000"` |
| NFC stops | Waydroid's container start runs `systemctl stop nfcd` | waydroid patch 0010 |
| Waydroid "container failed to start" | `lxc_spawn: ... Failed to clone a new set of namespaces` — no `IPC_NS`/`USER_NS`, Waydroid's LXC config asked for them | `waydroid-luneos-prepare` adds `lxc.namespace.keep` for whichever is missing from `/proc/self/ns` |
| Web apps sized wrong for the rotated panel | WAM used unrotated display size | WAM `herrie/panel-fix` (logical size + configd `compositorGeometry` subscription) |
| Gestures on the wrong edge | OrientationHelper mapped from parent, missing the output rotation | luna-next-cardshell `15bf576` (`mapFromGlobal`) |
| `setprop` fails from the host | `android-property-service` enabled but never started (no journal entries at all); MediaTek's hwcomposer sets properties during init | start the unit (debugging.md § 2.5) |
| `stp_dump3` at 93% of a core | combo-chip dump collector busy-loops with no framework to receive a dump | stubbed |
| `fuse_usbotg` restarting every 5 s | nothing mounts OTG media into the container | stubbed |
| Suspend never happens | both fingerprint HALs block uninterruptibly in the TrustKernel TEE driver (`tee_supp_cmd -> down`) waiting for a supplicant that never answers; 3240 freeze aborts in 90 min | stubbed (conflicts with fingerprint working, see Open issues) |

`rt5133@18` (a regulator) stays deferred (`Failed to request HWEN gpio`) without
anything visibly broken. `libsndcardparser.so not found` from the vendor
`libtinycompress.so` is harmless.

## Open issues

- **Battery percentage:** the kernel gauge (`mtk_battery.c`) is fine; the userspace
  algorithm rejects the nvram calibration. Compare with what stock Android reads
  from the same record.
- **Fingerprint:** `mp01.conf` declares it (owner confirmed the reader works), while
  `stubbed-services-mp01` stubs both HALs for suspend; whichever is out of date has
  to be fixed. Needs a working TEE supplicant.
- **WiFi power-on race** with `wmt_launcher` (hal-userspace.md § MediaTek
  connectivity).
- **Web apps cropped in portrait** (548x600 of a 600x657 card). Compositor side
  measured consistent (buffer, destination, source and item all 600x657); Chromium
  reports `screen` as unrotated 800x600 `landscape-primary`. Look at the web
  runtime's Wayland output handling (`wayland_output.cc`
  `panel_transform`/`logical_transform`). Method: debugging.md § Stage 3.
- **E Ink polish:** remaining shell animations worth making instant, a Home-press
  full refresh like stock's, per-app modes.
- `luneos.cfg` still sets `CONFIG_SYSVIPC=y`; LuneOS does not need it — drop it from
  the layer.

## Device-specific traps

- **`expdb` is the way in** (`dump-expdb.sh` in the port's tool directory wraps
  mtkclient; debugging.md § MediaTek: `expdb` when there is no pstore and no
  gadget). It settled what three rounds of guessing had not:

  ```
  [    0.458973][    T1] ======= LuneOS/Halium ===========
  [    0.461688][    T1] initrd: Initramfs Debug Mode
  [    1.541216][    T1] initrd: debug: telnet ready on usb0, 192.168.2.15 port 23
  RAM_CONSOLE detect abnormal boot wdt_status:0x6, aee_exp_type:1
  ```

  i.e. our init was running and the watchdog was killing the debug shell. `expdb`
  only records on an exception: a clean hang writes nothing and re-dumping returns
  the previous crash. Boot with `initrd_no_wdt` so a hang resets and leaves a record.
- **Watchdog:** `mtk-wdt` with a 31 s timeout resets the device every ~90-120 s with
  no panic in the journal; `printf 'V' > /dev/watchdog` disables it for that boot
  (verified: uptime past 180 s). Check `/proc/uptime` in the same command as any
  measurement (debugging.md § MediaTek: the hardware watchdog).
- **USB IDs:** `0e8d:201c` is fastboot, `0e8d:2000` the preloader (its own
  `/dev/ttyACM0` spews `READY` — not our console); ours is **`18d1:d001`** ("Halium
  initrd / Failed to boot"). The gadget came up as ECM + ACM, not adb (debugging.md
  § The debug gadget is not necessarily adb).
- **Two UDCs** (`CONFIG_USB_DUMMY_HCD=y`): both `android-gadget-setup` and the
  initramfs bound to `$(ls /sys/class/udc)`, which here is two names, so the gadget
  never bound; "telnet ready on usb0" was logged regardless. Fixed with a
  first-real-UDC loop (debugging.md § Two UDCs).
- **mdev names:** mdev creates `/dev/sdc59`, not `userdata`, so mountroot's `find
  /dev -name userdata` failed; the initramfs now synthesises by-name links from
  `PARTNAME=` in sysfs.
- **journald** lost all but the first six seconds of a minutes-long boot (default
  `SyncIntervalSec=5m`, forced power-off). Use `Storage=persistent`,
  `SyncIntervalSec=1s`; the real journal lives under
  `<data>/luneos-data/var/log/journal/`.
- `sh -x` as a drop-in `ExecStart` pinned a silent 90 s compositor timeout to the
  first line of `surface-manager.sh` (`PmLogCtl def surface-manager`).
- An aarch64 core with no gdb: `eu-stack --core`, map addresses via `NT_FILE`, and
  read `si_addr` from `NT_SIGINFO` by hand — here it was ASCII text, i.e. a
  clobbered thread pointer (debugging.md § Tooling appendix).
- The device does not charge in fastboot or the initramfs
  (`get_charger_charging_current: ... failed: -95`); a long session flattens it.
- Several bootloops followed heredoc writes over `adb shell` while pushed files
  behaved — a correlation only; prefer `adb push`.

## Sources

- https://minimalcompany.dev/blog/tags/update (factory images)
- https://github.com/shr-distribution/linux/tree/mp01/5.10.233/lune
