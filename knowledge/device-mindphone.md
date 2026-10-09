# Device: mindphone (MediaTek MT6739, 32-bit)

GreenTouch MindPhone (`mindphone`), MediaTek MT6739 with a 32-bit kernel and userland, Tier B on its Android 11 vendor; boots to the UI with wifi, BT and dual-SIM modem.

The odd one out: a 64-bit-capable SoC running a **32-bit kernel and 32-bit userland**, Android 11 stock, non-dynamic partitions, boot header v2 — the legacy (Tier B) end of the spectrum. Most subsystems are **up**: UI, wifi, BT, dual-SIM modem, hardware keypad with T9. Also the port that produced the 32-bit `halium_arm` GSI (11 and 16). Yocto: layer `meta-smartphone/meta-greentouch`, `MACHINE=mindphone`.

## Platform facts (from the full A/B OTA payload; extracted with `payload_extract.py`)

| Fact | Value |
|---|---|
| SoC | MediaTek MT6739 (preloader/lk/tee/spmfw/mcupmfw/md1img partitions) |
| Android | 11 (patch level 2022-03), **userdebug** build |
| Partitions | A/B, 16 in payload. **No vendor_boot, no init_boot, no super** (non-dynamic) |
| boot partition | 25,165,824 B (24 MB) |
| Kernel | **32-bit ARM zImage** (gzip), Linux 4.14.186, clang 11.0.1; cmdline `bootopt=64S3,32S1,32S1 buildvariant=userdebug` |
| Console | ttyMT0 |
| Stock config | IKCONFIG → `stock-config-4.14.186.txt`; mer-check: 13 errors / 58 warnings |

## boot.img recipe (header v2 — replicate exactly)

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

- The v2 `dtb` field is **not a bare FDT** — it is an AOSP **dt_table** (magic `0xd7b7ab1e`), same format as dtbo.img. Reuse the stock blob verbatim (lk wants the table format) or wrap a self-built dtb with `mkdtboimg.py create`.
- No vendor_boot → the boot ramdisk IS the entire first stage; our initramfs replaces everything, nothing is merged on top (unlike bluejay).
- Must stay ≤ 24 MB; kernel must be an armv7 zImage, not Image.gz/arm64. Sanity-check with `unpack_bootimg.py` and diff the header fields.
- AVB: stock vbmeta has flags=0 and chains `boot` (rollback slot 3) — a self-built boot.img will NOT verify. Flash a verification-disabled vbmeta (`avbtool make_vbmeta_image --flags 2 --padding_size 4096` or `fastboot --disable-verity --disable-verification flash vbmeta`); MTK lk in unlocked/orange state then boots unsigned images.

## Yocto port

The port was initially set up arm64 — wrong on every count. Fixed config: `TARGET_ARCH=arm` + tune-cortexa8 (shares hammerhead/tenderloin halium sstate), `KERNEL_IMAGETYPE zImage`, kernel recipe `linux-greentouch-mindphone_git.bb` (stock `k39tv1_bsp_1g_defconfig` + `luneos.cfg` delta; bootimg vars = the v2 recipe above; dtb = stock dt_table blob via `ANDROID_BOOTIMG_DTB`). Deploys `zImage-mindphone.fastboot` (= boot.img), verified byte-level against stock header layout.

Build gotchas that cost real time:
- gcc 14/binutils vs the 4.14 BSP: six layer patches (obsolete `#alloc` asm syntax ×28 files, `%llx` vs 32-bit phys_addr_t, drop `-Werror` from 30 MTK Makefiles, Silead gslX680 point-id object, GSL_GESTURE off + unguarded u64 division, `constexpr` C23 keyword in unifdef.c) + `CONFIG_FRAME_WARN=2048`.
- webruntime (Chromium): the distro builds it thumb-disabled → lands in `cortexa8hf-neon-halium` while everything else is `cortexa8t2hf-…`; `defaulttunes.inc` must bridge the two arches per machine (`DEFAULTTUNE:mindphone` + `PACKAGE_EXTRA_ARCHS:append:mindphone`) or the image dies at wam-clang with "sstate manifest could not be found".
- Stock vendor modules (wmt/wlan/bt/gps) CRC-mismatch our reconfigured kernel → `CONFIG_MODULE_FORCE_LOAD=y` in luneos.cfg. Force-loading has worked here, but it is only safe while the struct layouts those modules touch match stock — on the Titan Pocket a force-loaded `wlan_drv_gen3` panicked the kernel through a NETCONSOLE-shifted `struct net_device_ops` (kernel-porting.md § What happens when it breaks: Titan Pocket, 2 Oct 2026; device-titanpocket.md). This fragment carries NETCONSOLE too, so run the struct-layout check (kernel-porting.md § The check: diff struct-affecting options against stock, before flashing).

## halium_arm GSI (32-bit) — built for 11 AND 16

- **11.0**: `device/halium/halium_arm` cloned from halium_arm64 in a Halium 11.0 source tree: board include `generic_arm_ab`, no `core_64_bit.mk` inherit, keep `TARGET_USES_64_BIT_BINDER := true` (binder wire ABI). 16-min build.
- **16.0** (what the build now uses): three edits — (1) BoardConfig includes `build/make/target/board/generic/BoardConfig.mk` (the ready-made `generic_arm_ab` was removed in 13/14); drop `core_64_bit.mk`; do NOT set `TARGET_USES_64_BIT_BINDER` (default+deprecated); (2) hardlink `prebuilts/vndk/v30` from the 14.0 tree, `PRODUCT_EXTRA_VNDK_VERSIONS := 30 32 34` — the Android 11 vendor needs the v30 VNDK apex; (3) **the non-obvious one**: `packages/modules/vndk/apex/Android.bp` only declares `apex_vndk` for v31–v34 — add a v30 block or `com.android.vndk.v30` never exists and is *silently dropped*. Build with explicit env `TARGET_PRODUCT=lineage_halium_arm TARGET_RELEASE=bp4a TARGET_BUILD_VARIANT=userdebug; m systemimage`. Output verified genuinely 32-bit-primary (zero `system/lib64`) with the v30 apex present.
- Packaged as `halium-luneos-16.0-20260827-1-halium_arm.tar.bz2`; `android-system-image-mindphone.bb` points at it, `android-headers-halium` bumped 11.0%→16.0%, libhybris rebuilt. **Flashed and confirmed running on hardware (13 Sep 2026):** mindphone boots the Halium 16 stack over its Android 11 (VNDK 30) vendor — the second runtime proof of a Halium 16 GSI on an old vendor after sargo (12.1 / VNDK 32), and the first on 32-bit.

## Install (fastboot; no custom recovery exists)

```
adb reboot bootloader
fastboot flashing unlock                       # once; wipes data
fastboot flash vbmeta   vbmeta-disabled.img
fastboot flash boot_a   boot-luneos-mindphone.img
fastboot flash boot_b   boot-luneos-mindphone.img
fastboot flash userdata userdata-luneos.img
fastboot reboot
```

Regenerate userdata after an image rebuild: `mke2fs -q -F -t ext4 -L userdata -d <dir with rootfs.img> userdata-luneos.img 3600m`. If boot hangs: the initramfs panics into the "Halium initrd — Failed to boot" adb gadget; `adb shell`, read `/dev/kmsg`.

## What was brought up (and the fixes that did it — details in debugging.md)

| Subsystem | State / key fix |
|---|---|
| UI | **BOOTS.** Root cause was the quoted `wait_for_prop hwservicemanager.ready "true"` gate; plus libhybris hook patches, lxc CLONE_PIDFD on 4.14/arm32, binderfs symlinks, DRM probe guard, fb0 `modes` panel fallback (real panel 480x800@~187ppi — machine conf's 1080x2340 was fiction), backlight kick, wayland XDG symlink watcher |
| Wifi | **WORKS** — force-loaded stock vendor WMT modules, firmware path, `echo 1 > /dev/wmtWifi` retry; generalized into `meta-android/recipes-core/mtk-connectivity` |
| Modem | **WORKS (dual-SIM)** — the fstab.enableswap selection bug had left MTK NV partitions unmounted; fixed → md1 ready, `/ril_0` + `/ril_1` Powered |
| BT | **WORKS** — /dev/stpbt ownership + MAC from `/mnt/vendor/nvdata/APCFG/APRDEB/BT_Addr` |
| GPU/webapps | pvr_sync/ion 0666 udev rule (else EGL_BAD_ALLOC everywhere) |
| Keypad | 12-key T9 pad on mtk-kpd/event1; ID_INPUT_KEYBOARD udev promote; T9 multi-tap implemented as webos-keyboard patch 0004 (compiles, **not behaviorally tested**) |

## Open items

- `*`/`#` keymap remap (KEY_SWITCHVIDEOMODE 227 → KEY_NUMERIC_STAR) for the dialer; T9 v2 could go dictionary-predictive.
- FW_LOADER_USER_HELPER flipped off (halium default) vs stock on — revisit if MTK firmware loading misbehaves.
- nyx `mindphone.cmake` battery/charger/input paths are still rosy copy-paste — verify on device (patch 0022 allows `/etc/nyx.conf` runtime override); `NYXMOD_OW_HAPTICS TRUE` is deliberate (hybris haptics needs the legacy vibrator API that headers ≥11 lack — sargo precedent).
- Device-only fixes to land in layers: GPU udev rule, keypad udev, product.env DRM guard (needs luna-surfacemanager patch), wayland watcher; kernel patches should move to shr-distribution `dnim/4.14.186`; the 16 recipe/machine edits belong on `herrie/mindphone-mt6739`, not `herrie/mindphone-platform-fixes`.
- initramfs still lacks `udevadm`/`dumpe2fs`; machine.conf carries stale mmcblk numbers (harmless, fix to by-name).

## Tools

`payload_extract.py` (pure-stdlib payload.bin lister/extractor), `unpack_bootimg.py` (header v0–v2), extracted `images/`, `unpacked-boot/`, stock config + mer-check reports.
