# Device: mindphone (GreenTouch MindPhone, MediaTek MT6739)

GreenTouch MindPhone (`mindphone`), MT6739 with a 32-bit kernel and userland, Tier B on its Android 11 vendor; UI, Wi-Fi, BT, dual-SIM, audio and T9 keypad work.

The odd one out: a 64-bit-capable SoC running a **32-bit kernel and 32-bit userland**, non-dynamic partitions and boot header v2 — the legacy end of the spectrum, and the port that produced the 32-bit `halium_arm` GSI (11 and 16). It is the second runtime proof of a Halium 16 GSI on an old vendor after sargo, and the first on 32-bit.

## Status (as of 7 Oct 2026)

| Area | State | Notes |
|---|---|---|
| Boot, UI | works (hardware) | Halium 16 `halium_arm` GSI over the Android 11 (VNDK 30) vendor |
| Display | works | 480x800 panel |
| Wi-Fi | works | force-loaded stock WMT modules |
| Bluetooth | works | classic and LE (LE needs the command-bitmap fix below) |
| Modem / telephony | works, dual-SIM | `/ril_0` + `/ril_1` Powered |
| Audio | works | PDM linked `--whole-archive`; `setVolume` true, volume keys work |
| Keypad | works | 12-key T9 pad, volume and headset keys |
| Web apps / GPU | works | PowerVR; node permissions below |
| GPS | untested | |
| Camera | none | the device has no camera; the camera service and pipeline are not built |

## Platform facts

Read from the full A/B OTA payload (extracted with `payload_extract.py`).

| Fact | Value |
|---|---|
| SoC | MediaTek MT6739 (preloader/lk/tee/spmfw/mcupmfw/md1img partitions) |
| Word sizes | 64-bit SoC, 32-bit kernel + userland: `bootopt=64S3,32S1,32S1` |
| Android | 11 (patch level 2022-03), **userdebug** build |
| Partitions | A/B, 16 in the payload; no `vendor_boot`, no `init_boot`, no `super` |
| boot partition | 25,165,824 B (24 MB) |
| Stock kernel | 32-bit ARM zImage (gzip), Linux 4.14.186-gbba62e33f-dirty, clang 11.0.1 (Android r383902) |
| Console | `ttyMT0` |
| Stock config | IKCONFIG names the BSP project `k39tv1_bsp_1g`; `mer_verify_kernel_config`: 13 errors / 58 warnings |
| Display | 4.0" 480x800, 233 ppi physical (`mindphone.conf`); `deviceinfo_display_dpi="190"` chosen so the shell's GridUnit is 11 |

## Kernel

Tier B, built whole from the MT6739 ALPS tree: `linux-greentouch-mindphone`,
github.com/shr-distribution/linux branch `dnim/4.14.186` (SRCREV `06873421d`), defconfig
`arch/arm/configs/k39tv1_bsp_1g_defconfig` + `luneos.cfg` (ported from the arm64
`k39tv1_64_bsp_defconfig_luneos`, `CONFIG_DUMMY` kept `=y`). Platform identification and
defconfig method: kernel-porting.md § Tier B.

- **gcc 14 / binutils 2.4x patch series** (the classes: kernel-porting.md § Old BSP vs modern
  toolchain), as layer patches next to the recipe:
  1. `0001` obsolete `#alloc` section-flag syntax in 28 arm32 asm files (backport of upstream
     790756c7e022);
  2. `0002` `%llx` vs 32-bit `phys_addr_t` in mrdump;
  3. `0003` drop `-Werror` from 30 MTK vendor Makefiles;
  4. `0004` re-enable the commented-out Silead gslX680 point-id algorithm object (vmlinux link
     fails otherwise);
  5. `0005` disable `GSL_GESTURE` (only the no_gesture algorithm ships) + fix one unguarded u64
     division in eccci;
  6. `0006` rename `constexpr` in `unifdef.c` (a C23 keyword).

  Plus `CONFIG_FRAME_WARN=2048`.
- **pidfd**: the branch carries the `waitid(P_PIDFD)` backport and the follow-up "fork:
  CLONE_PIDFD: do not require a zeroed *parent_tidptr". Without the follow-up Qt's
  `QProcess::startDetached()` gets EINVAL, so luna-surfacemanager could neither
  `initctl emit lsm-ready` (no `READY=1`, a restart every 90 s, no first-use, no launcher
  icons, no maliit) nor `chgrp` its `wayland-0` socket to `compositor` (web apps got EACCES).
  Rule: kernel-porting.md § pidfd_open() without waitid(P_PIDFD).
- **Vendor modules**: the stock WMT/wlan/BT/GPS modules CRC-mismatch the reconfigured kernel,
  so `luneos.cfg` sets `CONFIG_MODULE_FORCE_LOAD=y` and they are force-loaded
  (kmi-crc-matching.md § Force-loading prebuilt modules, and when it is safe). This fragment
  also carries `CONFIG_NETCONSOLE=y`; see Open issues.
- `FW_LOADER_USER_HELPER` is off in `luneos.cfg` (Halium default) and on in stock.

```
MACHINE=mindphone bitbake linux-greentouch-mindphone
# → tmp/deploy/images/mindphone/zImage-mindphone.fastboot (= boot.img)
```

## Boot image

Layout class: boot-images.md § Class 1 — legacy header v2. Stock layout:

```
header_version = 2          page_size = 2048
kernel:  load 0x40008000    (base 0x40000000 + kernel_offset 0x00008000)
ramdisk: load 0x45000000    (ramdisk_offset 0x05000000)
tags:    load 0x44000000    (tags_offset   0x04000000)
dtb:     load 0x44000000    (dtb_offset    0x04000000), size 69,220
second:  none
cmdline: "bootopt=64S3,32S1,32S1 buildvariant=userdebug"
os_version 11.0.0, os_patch_level 2022-03
```

```
mkbootimg --header_version 2 --pagesize 2048 \
  --base 0x40000000 --kernel_offset 0x00008000 \
  --ramdisk_offset 0x05000000 --tags_offset 0x04000000 \
  --dtb_offset 0x04000000 \
  --os_version 11.0.0 --os_patch_level 2022-03 \
  --cmdline "bootopt=64S3,32S1,32S1 buildvariant=userdebug" \
  --kernel zImage --ramdisk initrd.gz --dtb unpacked-boot/dtb \
  -o boot-luneos.img
```

- The dtb is an AOSP dt_table (magic `0xd7b7ab1e`, 1 entry, page_size 2048), reused verbatim
  via `ANDROID_BOOTIMG_DTB = "file://dt-table.img"`; there is also a separate 36 KB `dtbo.img`.
- No vendor_boot: our initramfs replaces the whole first stage.
- Shipped `boot-mindphone-luneos.img`: kernel 9,362,176 B (32-bit zImage, head
  `00 00 a0 e1`), ramdisk 5,064,178 B, dtb byte-identical to stock; 14,499,840 B total = 57%
  of the 24 MiB partition. Must stay ≤ 24 MB.
- AVB: stock `vbmeta.img` (avbtool 1.1.0, SHA256_RSA2048, flags 0) chains `vbmeta_system`
  (rollback slot 2), `vbmeta_vendor` (4) and `boot` (3); the stock boot.img carries its own
  `AVBf` footer, so a self-built image needs a verification-disabled vbmeta (boot-images.md
  § AVB: does the stock vbmeta cover boot?).

## Vendor and GSI

Android 11 vendor, VNDK 30, 32-bit → the 32-bit `halium_arm` GSI. Build: gsi-building.md §
Building a 32-bit halium_arm GSI (the v30 VNDK port and the `apex_vndk` block that was
silently missing). Current pin in `android-system-image-mindphone.bb`:
`halium-luneos-16.0-20261007-1-halium_arm` (carries `com.android.vndk.v27` to `v34`; the same
build as the legacy 32-bit devices), pinned separately because the release the arm64 ports
tracked earlier published no `halium_arm` asset. It travels inside `rootfs.img` as
`android-rootfs.img` (`VIRTUAL-RUNTIME_android-system-image = "android-system-image-mindphone"`),
not beside it. `android-headers-halium` is 16.0%. Flashed and confirmed running on 13 Sep 2026.

## Yocto

Layer `meta-greentouch`, `MACHINE=mindphone`: `TARGET_ARCH = "arm"`, `tune-cortexa8`,
`MACHINEOVERRIDES =. "halium-arm:"`, `KERNEL_IMAGETYPE = "zImage"`, `IMAGE_CLASSES +=
"userdataimg"`. 32-bit machine rules (arch check, the webruntime tune split and the
`defaulttunes.inc` bridge `DEFAULTTUNE:mindphone` + `PACKAGE_EXTRA_ARCHS:append:mindphone`):
device-bringup-yocto.md § 32-bit (arm) machines. The port was first set up arm64 —
arch-arm64.inc, Image.gz-dtb, a Qualcomm cmdline, an arm64 defconfig, the `halium_arm64` GSI —
wrong on every count.

| Layer file | Role |
|---|---|
| `70-mindphone.rules` | `mtk-kpd` and `ACCDET` tagged `ID_INPUT_KEYBOARD` (T9, volume, headset button); `/dev/ion` 0666 |
| `bluebinder/mindphone` | LE command-bitmap fix (below) |
| `stubbed-services-mindphone` | health HAL, `storaged`, `sdcard`, `stp_dump3` |
| `mindset-deviceinfo` | `deviceinfo_display_dpi="190"`, `device_pixel_ratio="1.0"`, `video_call="false"`, `hybris_prefer_vndk="1"` |
| `nyx-conf/mindphone/nyx.conf` (meta-luneos) | keys pinned to `/dev/input/event1`; touch, battery, charger derived |

Nyx module selection comes from the `halium` default in `nyx-modules-machines.inc`
(nyx-modules.md § Module selection); there is no per-machine nyx file. `NYXMOD_OW_HAPTICS`
is part of that default (nyx-modules.md § When to flip a module back).

```
MACHINE=mindphone bitbake luneos-dev-image     # rootfs + userdata image
```

## Install

Fastboot only; no custom recovery exists (installing.md § Flash steps per layout class, the
legacy-v2 sequence). Kit: `boot-mindphone-luneos.img`, `boot-mindphone-luneos-debug.img`,
`vbmeta-disabled.img` (stock vbmeta with flags 2), `userdata-luneos.img` (3.0 GB ext4 holding
`rootfs.img`, built by `userdataimg.bbclass`), `install.sh` (`--debug` flashes the debug
image). Fastboot mode: `adb reboot bootloader` or Vol-Down + Power; `fastboot flashing unlock`
needs the OEM-unlock toggle. Flash both boot slots. MediaTek lk here has no `fastboot boot`, so
the debug image is flashed, not RAM-booted.

Revert: stock `boot.img` and `vbmeta.img`, then `fastboot -w`. If the phone stops enumerating,
mtkclient over the preloader recovers it — write `boot` and `userdata` only, never `preloader`.

## Subsystem notes

- **UI**: the boot-splash hang's root cause was the quoted
  `wait_for_prop hwservicemanager.ready "true"` gate (debugging.md § 2.2). Also needed:
  libhybris hook patches 0003/0004 (hal-userspace.md § libhybris fixes), LXC `CLONE_PIDFD` on
  4.14/arm32, binderfs symlinks, a DRM probe guard, the fb0 `modes` panel fallback, and a
  backlight kick.
- **Wi-Fi**: force-loaded stock WMT modules, firmware path, `echo 1 > /dev/wmtWifi` retry —
  generalised into `meta-android/recipes-core/mtk-connectivity` (hal-userspace.md § MediaTek
  connectivity).
- **Modem**: `mount-android.sh` picked `fstab.enableswap` over `fstab.mt6739`, leaving the NV
  partitions unmounted (`md1.status` "exception"). After the fix: `md1.status=ready`,
  `vendor.ril-daemon-mtk` running, IRadio@1.0 em1/em2 registered, ofono `/ril_0` + `/ril_1`
  Powered (debugging.md § Modem).
- **Bluetooth**: `/dev/stpbt` ownership and the MAC from
  `/mnt/vendor/nvdata/APCFG/APRDEB/BT_Addr` (hal-userspace.md § Bluetooth). The combo chip
  answers every LE command but advertises none (octets 25–28 of Read_Local_Supported_Commands
  are zero), so BlueZ set LE event mask 0x10 and LE scan/connect found nothing;
  `bluebinder/mindphone` sets four event-gating bits back (`BLUEBINDER_LOCAL_COMMANDS_SET`),
  giving the LE event mask 0x1f confirmed on the device. A working `hci0` needs
  `CONFIG_BT_HCIVHCI`.
- **GPU / web apps**: `/dev/pvr_sync` (shared `65-android.rules`) and `/dev/ion` must be 0666
  — `wam` is not in group `system`, and without it every `eglCreateContext` returns
  `EGL_BAD_ALLOC`.
- **Audio**: on armv7 PDM was linked with none of its device handlers (they register from
  static initialisers in a static archive nothing references), so audiod never got the sound
  card: no sound, no volume, no USB storage or MTP. Fixed by linking the core archive
  `--whole-archive` (meta-luneos `com.webos.service.pdm` patch 0001).
- **Keypad**: 12-key T9 pad on `mtk-kpd`; T9 multi-tap is webos-keyboard patch 0004. udev tags
  `mtk-kpd` `ID_INPUT_KEY` only, and the compositor finds keyboards by `ID_INPUT_KEYBOARD`
  (nyx-modules.md § Copy-paste is fiction until verified on hardware).
- **`stp_dump3`**: the vendor's `persist.vendor.connsys.coredump.mode=2` starts the combo-chip
  dump collector, which busy-loops on `pselect6()` for `/dev/stpwmt` (54,249 s of CPU in
  54,653 s uptime); stubbed.

## Open issues

- **Unverified risk: NETCONSOLE with force-loaded network modules.** `luneos.cfg` sets
  `CONFIG_NETCONSOLE=y` while the stock WMT/wlan modules are force-loaded, and stock has
  `NET_POLL_CONTROLLER` off — the combination that panicked the Titan Pocket
  (device-titanpocket.md; kmi-crc-matching.md § NETCONSOLE and NET_POLL_CONTROLLER). Wi-Fi
  works here, which does not prove the layouts match; run the struct-layout check
  (kmi-crc-matching.md § Struct layouts) before relying on it.
- `*`/`#` keymap remap (KEY_SWITCHVIDEOMODE 227 → KEY_NUMERIC_STAR) for the dialer; T9 could
  go dictionary-predictive.
- `FW_LOADER_USER_HELPER` off vs stock on — revisit if MTK firmware loading misbehaves.
- The initramfs lacks `udevadm`/`dumpe2fs`; its `machine.conf` still carries copy-pasted
  `mmcblk0p27/28` values (harmless — only the panic path uses `system_partition`; should be
  by-name).

## Device-specific traps

- Check the stock kernel's word size before writing a machine conf (`bootopt=`).
- MTK lk silently refuses boot images above roughly 28 MB (measured on the MP01); keep this
  one under the 24 MiB partition anyway.

## Sources

- https://github.com/shr-distribution/linux/tree/dnim/4.14.186
- https://github.com/webOS-ports/halium-images/releases
