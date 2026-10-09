# Device: mp01 (Minimal Phone MP01, vendor codename Z10)

Minimal Phone MP01 (`MP01`, vendor codename Z10), 4.3" E Ink QWERTY phone on MediaTek Helio G99 (MT6789), Tier A on the Q25's kernel tree; boots to the LuneOS UI.

From The Minimal Company; the first LuneOS port to an electrophoretic display.

**Status (17 Sep 2026): boots to the LuneOS UI on the shared `halium-arm64`
rootfs.** Working on hardware: display (rotated E Ink panel), touch, keyboard,
WiFi, cellular, camera, audio, Bluetooth (classic and LE scanning), NFC,
fingerprint, sensors, charging detection. Open: battery percentage (fuel gauge
reports -1), a WiFi power-on race, web apps cropped in portrait. See
"Bring-up results" below; the sections before it describe the pre-boot work.

Layer `meta-smartphone/meta-minimal`, `MACHINE=mp01`. The port's tool directory
holds the notes, firmware, KMI gate and `dump-expdb.sh`.

## The one-line summary

**Same SoC and same kernel as the Zinwa Q25** — MT6789 (Helio G99), MediaTek
`mgk` android12-5.10 **KMI generation 9**, clang r416183b, 64 MiB boot,
9216 MiB super, unused `init_boot`. The two stock kernel configs differ by
**85 options out of 2,665**, every one a board-level driver. Read
`device-q25.md` first; most of it applies.

## Platform facts

All from the vendor's own SP Flash Tool package (`Z10_20251226_user_smr6.zip`,
build `alps-mp-s0.mp1-V17.88`), which Minimal publish themselves at
<https://minimalcompany.dev/blog/tags/update> — no OTA interception needed.

| Fact | Value |
|---|---|
| Codename | **`Z10`** in `flash.xml`/scatter/preloader and over fastboot (`getvar product`); `ro.product.vendor.device=MP01` is what `luneos-device-config` reads |
| SoC | **MT6789** — scatter, and the vendor's own flashing guide. Spec sites claiming MT6769/G85 are **wrong** |
| Kernel | **5.10.233**, `5.10.233-android12-9-gdeb4d30d3489`, clang r416183b, `CONFIG_ARCH_MEDIATEK=y` |
| Vendor API | 31 (Android 12 vendor, `alps-mp-s0`) — halium_arm64 16.0 GSI carries `com.android.vndk.v31` |
| Display | 4.3" E Ink 600×800, `CONFIG_DRM_PANEL_Z10_EINK_VDO=m` — a **DSI video-mode DRM panel**, Pango FPGA doing DSI→EPD |
| Keyboard | AW9523B I2C expander, `aw9523b-key`. Key table includes **`Volup`**, so pin key devices by name |
| Touch | FocalTech, `focaltech_touch.ko` |
| Storage | 108.8 GiB userdata (**scatter declares 3 GiB — nominal, ignore it**; `fastboot getvar partition-size:userdata` = `0x1b357f8000`) |
| Connectivity | `gen4m_6789` / `connac1x` / `gps_drv_stp` / `mt6631_6635` — **character-for-character the Q25's** |

## Kernel: no published source, and it does not matter

Minimal publish no GPL kernel source. What they do publish is the factory image,
which ships the stock kernel config loose as `merged/.config`.

So `linux-minimal-mp01` builds the **Q25's** tree
(`LineageOS/android_kernel_xelex_mt6789`, 5.10.198) against the **MP01's own
stock config** (5.10.233). Measured against all 345 of this device's stock
modules: **0 would fail**, with zero mismatches on any `vmlinux`-exported
symbol. The substitution is legitimate.

Two things that fall out of building a different tree than the config came from:

- **List-valued options break the build.** `CONFIG_TOUCHSCREEN_MTK_TOUCH` and
  `CONFIG_CUSTOM_KERNEL_IMGSENSOR` are *strings naming source subdirectories*.
  `olddefconfig` silently drops unknown *symbols* — which is what makes the
  whole substitution work — but cannot drop these, because the symbol exists
  and only the directories do not. Result: `No rule to make target
  .../focaltech_touch/Makefile`. `files/tree-fixup.cfg` rewrites them, applied
  **unconditionally including the baseline**, since it belongs to the source
  substitution rather than to LuneOS.
- **Vermagic must be forced to match** (debugging.md 1.14) — `SUBLEVEL = 233`,
  `CONFIG_LOCALVERSION="-android12-9-gdeb4d30d3489"`, `LOCALVERSION_AUTO` off,
  and an empty `.scmversion`.

KMI-poison list is the Q25's, re-measured here: `CONFIG_USER_NS` and/or SysV
IPC, held out as a group (both stay off). `PID_NS` and
`CHECKPOINT_RESTORE` are clean.

### ThinLTO is worth it during bring-up

Stock sets `CONFIG_LTO_CLANG_FULL=y`, and `ld.lld -r -o vmlinux.o` then runs
**single-threaded** — measured at 93.6% of one core on a 64-thread host, ~20
min. `CONFIG_LTO_CLANG_THIN` drops it to **6m04s** and is KMI-neutral: CRCs come
from `$(CPP) -D__GENKSYMS__ | genksyms`, i.e. preprocessed *source*, which is
independent of codegen. Verified 0/345 both ways. Gated behind
`conf/mp01-thinlto.conf`; revert to full LTO for a shipped image.

## Why this device is so hard to debug

Everything you would normally use to see a failed boot is itself a vendor
module:

```
CONFIG_SCSI_UFS_MEDIATEK=m   ufs-mediatek-mod.ko    storage
CONFIG_MMC_MTK=m             mtk-mmc.ko, phy-mtk-ufs.ko
(out-of-tree)                musb_hdrc.ko           USB - so no adb, no gadget
(vendor)                     mtk_wdt.ko             watchdog - so it resets you
```

No debug UART, and the panel is E Ink behind another module. A failing MP01 is
**completely mute**: nothing on `lsusb` but the preloader flashing past on each
reset. This drove four separate findings now generalised into debugging.md
1.9–1.14 — read those before debugging any MediaTek GKI device.

`dump-expdb.sh` (in the port's tool directory) is the way in: MediaTek's `expdb` partition
over mtkclient. It is what proved our init *was* running and the watchdog was
killing the debug shell.

## Device quirks that cost time

- **It does not power off with a long press while USB is connected.** MediaTek
  auto-boots on USB power, so Power-for-10s just resets it and it comes straight
  back. You do not need it off, though: **hold Volume Down through that forced
  restart and it lands in BROM** (confirmed on hardware), which is the reliable
  way in. Alternatively a device in a reset loop presents the preloader on every
  cycle and mtkclient polls for exactly that, so leaving it looping on the cable
  also works.
- **`0e8d:201c` is fastboot mode**, not a LuneOS gadget. `0e8d:2000` is the
  preloader, and it presents a `/dev/ttyACM0` of its own that spews `READY` -
  which is *not* our debug console. Ours is **`18d1:d001`** ("Halium initrd /
  Failed to boot"). Three separate false positives came from not checking the
  ID.
- **"telnet ready on usb0" in the log does not mean USB works.** The original
  panic() did `write .../UDC "$(ls /sys/class/udc)"` and then called
  start_debug_network unconditionally - so with an empty UDC the bind silently
  did nothing while the script still logged success. Check for the USB ID, never
  the log line.
- **`expdb` only records on an exception.** A clean hang writes nothing, so
  re-dumping after a silent hang returns the *previous* crash and looks like
  nothing changed. If the device hangs without resetting, boot it with
  `initrd_no_wdt` so the watchdog fires and produces a record.

## Install

The device's staging kit (`mp01_20260914.zip`). Modelled on the Q25
kit, four differences:

1. **All three vbmeta images** are attempted, but lk only exposes the top-level
   one — `has-slot:vbmeta_system` comes back empty and flashing it dies with
   `partition does not exist`. Harmless: `--disable-verity
   --disable-verification` on the top-level vbmeta disables the whole chain.
2. **Lock-state check first.** A locked MediaTek lk does not report itself as
   locked; it refuses *critical* partitions individually with
   `FAILED (remote: 'No support by lock control')`, which reads like a problem
   with that partition. And if `flashing get_unlock_ability` is `false`, the
   unlock itself is refused too — that switch only exists inside booted Android.
3. **Partition-size check** before flashing userdata (see the scatter trap
   above).
4. **No `fastboot -w`**, on top of the Q25's no-`fastboot boot` rule (device-q25.md § The install kit); the
   community guide reports `-w` failing here.

Fastboot entry: power fully off, **Volume Up + Power**, navigate with Vol Up,
select with **Vol Down**.

## The display, which is the real work

The panel is DSI so it *paints* — from the SoC's side it is an ordinary MediaTek
DRM display. Refresh mode is a separate, solved problem (17 Sep 2026):

**Hardware.** `panel-z10-eink-i2c.ko` (the Pango CPLD's I2C side) exposes one
write-only command register,
`/sys/bus/i2c/drivers/eink_cpld/7-004b/eink_cpld_registers`, plus a read-only
`refresh_mode` mirror (0..3). Values, all measured on the phone:

| write | effect |
|---|---|
| 1 | waveform 0: full greyscale, slowest, cleanest (stock "Slow") |
| 2 | waveform 1: greyscale, visibly clearer and less ghosting than 1 |
| 3 | waveform 2: nearly two-level - crisp text, images lose their greys |
| 4 | waveform 3: fastest, most ghosting (stock "Ultra") |
| 5 | clear (full refresh); stock always follows it with 3, then restores the mode 100 ms later |
| 6/7/8/10-15 | read-backs into dmesg (CPLD id, fw version 36, waveform version 16, VCOM ...) |
| 9 | **reprograms the CPLD's flash** from the module's embedded bitstream - never write casually |

Every switch among 1, 3 and 4 is silent; **entering 2** - from 1, 3 or 4 alike -
is a double clearing flash. That one fact decides every policy below.

**Stock's design** (decompiled with jadx from `services.jar` and the MiniEink
apk): `DisplayManager.setRefreshMode(int)` writes the integer to that file;
`MinimalRefreshService` in system_server offers Slow (1), Hybrid (1, with 4
while a `WindowMonitor` sees scrolling/animation/video) and Ultra (4), per-app
modes, and `forceFullRefresh` = 5, 3, restore. The key between volume up and
down is Linux keycode 252 (`AREFRESH` in Generic.kl): short press = full
refresh, 400 ms hold = quick settings; the Home key also triggers a full
refresh 500 ms after each press.

**LuneOS.** `org.webosports.service.eink` (einkd, C, modelled on torchd, in
the MP01 image via `MACHINE_EXTRA_RRECOMMENDS`) owns the register: `getStatus`
(subscribable), `setMode`, `setActive`, `refresh`, `watchKey`. Modes: Slow,
Balanced (default), Auto, Text, Ultra; the choice persists as systemservice
preference `einkRefreshMode`. It reads keycode 252 from evdev (`mtk-kpd`,
event1) itself: short press = full refresh, long press = the shell's popup.
luna-next-cardshell's `Connectors/EinkRefresh.qml` derives "moving" from the
compositor's `frameSwapped` (6 frames in 250 ms) and "still" from 1 s without
a frame, for Auto (1 at rest, 4 while moving - the flash-free pair; a full
refresh counts as settled); `Notifications/EinkRefreshMenu.qml` is the long-press popup; and
`AppTweaks.disableAnimations` (forced on when the service reports a panel) makes
the launcher tab switch, card open/close and launch-bar transitions instant -
each animation frame was a flashing greyscale update. Settings > Display has
the same controls.

Beyond that: 16-level greyscale (dark themes are unusable), luna-surfacemanager
animates everything, and `deviceinfo_display_dpi=233` /
`device_pixel_ratio=1.333` are arithmetic from the spec sheet, not tuned. Expect
the legible DPI to be *larger* than the arithmetic one — hairlines that are
merely crisp on an LCD vanish on E Ink.

Booting this is a bring-up task; making it pleasant is a design task. Scope them
separately.

## Bring-up results (16-17 Sep 2026)

Staging kit: the device's staging kit (its `README.md` has the WiFi/BT
write-up). LuneOS runs on **slot b**; slot a keeps stock Android.

### Flashing and recovery

- `fastboot getvar current-slot` right after `--set-active` can report the old
  slot; flash `boot_b`/`vbmeta_b` explicitly instead of trusting it.
- A slot that failed to boot is marked `slot-unbootable` and lk silently falls
  back to the other one; `--set-active` does not clear that.
- `vendor_dlkm` is not a fastboot partition (`partition does not exist`); it is
  inside `super`. For LuneOS only `boot_b`, `vbmeta_b` and `userdata` need
  flashing - leave `super` alone unless restoring stock.
- `fastboot -w` fails on the host (`make_f2fs failed`); flash
  `userdata-luneos.img` (or stock `userdata.img`) instead.
- Full recovery that worked: flash stock boot/vendor_boot/dtbo/vbmeta to the
  slot, boot Android, charge to 100%, then reflash LuneOS.
- Update the staging kit from the build first: `boot-mp01-luneos*.img` from
  `tmp/deploy/images/mp01/`, `rootfs.img` from
  `tmp/deploy/images/halium-arm64/`, then `make-userdata.sh`.

### Per-subsystem findings

| Area | Finding | Fix |
|---|---|---|
| Reboot every ~3.5 min | clean shutdowns from `sleepd` | masked during bring-up |
| Power-off within a minute on the charger | fuel gauge `capacity=-1` ("cali car tune 119, invalid" from MediaTek's closed `libfgauge_gm30.so`) trips batteryd's critical check | `deviceinfo_battery_critical_percent="0"` (stopgap) |
| `Charging:false` on the cable | mt6375 reports `online=2` | nyx-modules `919ab0c` |
| Compositor spins on DRM master | charger-mode boot (`bootreason=usb`, the phone is never truly off); `charger` holds master; `QT_QPA_FORCE_HWC2` lost to an `export` prefix | `/system/bin/charger` in `DISPLAY_CONFLICT_MATCH` (meta-luneos copy), generator writes plain `KEY=VALUE` |
| No audio, no camera | container's `/vendor_dlkm` was an empty bind, vendor `insmod_sh` loaded nothing | `mount-android.sh`: `_a`/`_b` dm names, bind `/android/vendor_dlkm`, vendor loads modules |
| pulseaudio crash | vendor `libnvram.so` needs VNDK 31 `libbase` | `deviceinfo_hybris_prefer_vndk="1"` |
| Audio slightly off | HAL DL paths at 48 kHz | `deviceinfo_audio_sample_rate="48000"` |
| No WiFi/BT modules | `mtk-connectivity` conditions only checked `vendor` | `8fd74686` |
| BT dead | wrong HAL name, bad restart order, Synchronization Train over-reported | `mtk-bt-bringup.sh`, `deviceinfo_bluebinder_ext_features_page_2_mask="0x0400000000000000"` |
| NFC stops | Waydroid's container start stops `nfcd` | waydroid patch 0010 |
| Waydroid "container failed to start" | kernel has no IPC/user namespaces, Waydroid's LXC config asked for them | `waydroid-luneos-prepare` adds `lxc.namespace.keep` for missing namespaces |
| Web apps sized wrong for the rotated panel | WAM used unrotated display size | WAM `herrie/panel-fix` (logical size + configd `compositorGeometry` subscription) |
| Gestures on the wrong edge | OrientationHelper mapped from parent, missing the output rotation | luna-next-cardshell `15bf576` (`mapFromGlobal`) |

Hardware notes: the NFC controller is an NXP PN8x (`nxpnfc_i2c`, `/dev/nxpnfc`,
`ro.hardware.nfc_nci=pn8x`). The speaker amp actually fitted is `oca72xxx_pa`
(`6-0058`); the DT's `rt5512@5c` is not populated. BT is MediaTek
(manufacturer `0x0046`), address from nvram `BT_Addr`. `rt5133@18` (a regulator)
stays deferred (`Failed to request HWEN gpio`) without anything visibly broken.

### Still open

- **Battery percentage.** The kernel gauge (`mtk_battery.c`) is fine; the
  userspace algorithm rejects the nvram calibration. Compare with what stock
  Android reads from the same nvram record.
- **WiFi power-on race** with `wmt_launcher` (hal-userspace.md).
- **Web apps cropped in portrait** (548x600 of a 600x657 card, landscape fine).
  Compositor side verified consistent; Chromium reports `screen` as unrotated
  800x600 landscape. Look at the webOS Wayland output handling in the web runtime
  (`wayland_output.cc` `panel_transform`/`logical_transform`).
- **E Ink polish.** Refresh control is done (see the display section); what is
  left is finding the remaining shell animations worth making instant under
  `AppTweaks.disableAnimations`, a Home-press full refresh like stock's, and per-app
  modes if anyone wants them.
