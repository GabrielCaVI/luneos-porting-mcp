# Device: fajita (OnePlus 6T, SDM845)

OnePlus 6T (`fajita`), Qualcomm SDM845, Tier B on a LineageOS 22.2 (A15) vendor: kernel and boot image build and are verified; never run on hardware.

The least work of any Tier B port in the tree: no vendor kernel modules, no dynamic partitions, no retrofit metadata, no per-device rootfs — one machine conf, one kernel recipe, one config fragment and one `deviceinfo`. Everything about the device is derived from LineageOS's `lineage-22.2` device and kernel trees and the paired LineageOS build, not from a booted phone. It found two generic bugs: the header-v1 dtb drop (boot-images.md § Boot header versions) and A15's dated `ro.board.api_level` selecting the wrong binder protocol (hal-userspace.md § Before blaming AIDL).

## Status (as of 28 Sep 2026)

| Area | State | Notes |
|---|---|---|
| Kernel build | works (host) | `MACHINE=fajita bitbake linux-oneplus-fajita` |
| Boot image | verified (host) | header, `id`, appended FDTs and window checked against the built and the shipping image (§ Boot image) |
| Boot on hardware | untested | no 6T has run this |
| Everything else | untested | |

Before flashing: the rootfs in the staging kit predates the `OnePlus6T` adaptation and the dated-API-level fix, so rebuild `luneos-image-halium-arm64` and re-cut `userdata-luneos.img`, or Tier 1 and the gbinder `ApiLevel` will both be wrong.

## Platform facts

| Fact | Value |
|---|---|
| SoC | Qualcomm SDM845 (Snapdragon 845), Adreno 630 |
| Launched | Android 9; last OxygenOS is 11 (vendor API level 30). LineageOS carries it to 22.2 / Android 15 |
| A/B | yes (`AB_OTA_PARTITIONS`: boot dtbo system vbmeta vendor) |
| Dynamic partitions | **none.** `system` and `vendor` are real partitions with `slotselect`; no `super`, no retrofit metadata |
| Storage | UFS; by-name symlinks under `/dev/block/bootdevice/by-name/` (stock `fstab.qcom`) |
| boot partition | 64 MB, and **is** recovery (`BOARD_USES_RECOVERY_AS_BOOT` + `TARGET_NO_RECOVERY`) |
| userdata | `fileencryption=ice` in the stock fstab → must be reformatted unencrypted |
| Display | 6.41" 1080x2340 AMOLED (`dsi_samsung_sofef00_m`), notched; sqrt(1080² + 2340²)/6.41 = **402 ppi** (LineageOS's `TARGET_SCREEN_DENSITY := 450` is a bucket) |
| Vendor props | `ro.board.api_level=202404`, `ro.vendor.build.version.sdk=35`, no `ro.vndk.version`, `ro.product.vendor.device=OnePlus6T`, `ro.product.vendor.model=ONEPLUS A6013`, `ro.product.first_api_level=28`, `ro.vendor.build.security_patch=2021-11-01` |
| Builds | boot.img + initramfs only; rootfs is `MACHINE=halium-arm64` |

## Kernel

**4.9.337**, `LineageOS/android_kernel_oneplus_sdm845` branch `lineage-22.2`, SRCREV `228c16bfcd256a546e3fde375215f6072135588f`. Pre-GKI, so Tier B for good. `enchilada_defconfig` serves both SDM845 OnePlus phones; the 6 vs 6T difference is the dtbo overlay. The paired build `lineage-22.2-20260922-nightly-fajita` pins this SRCREV in its `build-manifest.xml`, so kernel and vendor are one matched pair.

**No vendor kernel modules, so nothing to match.** `CONFIG_QCA_CLD_WLAN=y` (qcacld-3.0 built in); `device/oneplus/{fajita,sdm845-common}` has no `.ko` (none in `proprietary-files.txt` or `common.mk`, no `BOARD_VENDOR_KERNEL_MODULES`). The `insmod /vendor/lib/modules/qca_cld3_wlan.ko` and `modprobe`s for `pinctrl-wcd`, `wcd-dsp-glink`, `snd-soc-wcd-spi`, `snd-soc-sdm845` in CAF `init.target.rc` refer to OxygenOS-era files a LineageOS vendor lacks and fail harmlessly (kmi-crc-matching.md § Step −1). `CONFIG_MODULE_SIG_FORCE=y` stays as stock, with the signing key pinned in the recipe (sargo's, byte for byte) so out-of-tree module recipes survive a rebuild. This holds for a *LineageOS* vendor only: OxygenOS 11 ships `qca_cld3_wlan.ko` and is a different port (and the Halium 11 GSI).

**Config delta (`luneos.cfg`)**, each entry checked against `enchilada_defconfig` (kernel-porting.md § The config delta). Off in stock and turned on: `FHANDLE`, `VT` (and the console/PTY set), `DEVTMPFS`, `UTS_NS`, `PID_NS`, `USER_NS`, `NET_NS`, `CGROUP_DEVICE`, `MEMCG`, `FANOTIFY`, `BT_HCIVHCI` and the BT stack, `HIDRAW`, `SQUASHFS`, `VETH`, the netfilter extras, `NETCONSOLE` (safe: no prebuilt network module loads). Already on: **`CONFIG_OVERLAY_FS=y`**, so `luneos-device-config` applies the adaptation as one overlay mount. Changed from stock: `KALLSYMS_ALL` off (window lever), `RT_GROUP_SCHED` off (`waydroid-kernel.inc` forces it). `SYSVIPC` stays off. `CONFIG_CC_WERROR` off (below).

**4.9-tree tax:** `unifdef.c`'s `static bool constexpr;` → `BUILD_CFLAGS:append = " -std=gnu17"` (kernel-porting.md § Old BSP vs modern toolchain); the USB gadget functions must be forced from `m` back to `y` after `oldconfig`, or the configfs gadget (adb, netconsole) does not exist.

**-Werror against GCC 15.** `CONFIG_CC_WERROR=y` in the defconfig adds a tree-wide `-Werror`; the first two failures were style warnings, so it is turned off in `luneos.cfg` rather than patched (warnings still print):

| | |
|---|---|
| `arch/arm64/kernel/process.c:196` | `printk("\n%s: %pS:\n", name, addr)` in the OEM `show_data()` — `%pS` with an `unsigned long` [`-Werror=format=`] |
| `kernel/extable.c:44` | `__stop___ex_table > __start___ex_table` — comparing two array names [`-Werror=array-compare`] |

qcacld sets its own `-Werror` in `drivers/staging/qcacld-3.0/Kbuild`, untouched by `CC_WERROR=n`; GCC 13's `-Wenum-int-mismatch` fires on `wlan_hdd_send_hang_reason_event` (`int` in the header, `enum qdf_hang_reason` in the definition). One patch drops the unconditional flag and leaves `-Werror=<specific>` alone — one hunk, where surya needed 27, because this tree keeps audio in `sound/soc/msm` and nothing under `techpack/` sets `-Werror`.

**Appended dtbs come from the dtbo bases.** With `CONFIG_BUILD_ARM64_DT_OVERLAY=y`, `dtb-y` for SDM845 is empty (the base list is in the `else` branch of `arch/arm64/boot/dts/qcom/Makefile`). The bases are still built: `scripts/Makefile.dtbo` does `multi_depend($(dtbo), , -base)` and every fajita overlay declares `…-overlay.dtbo-base := sdm845-v2.1.dtb`. `arch/arm64/boot/Makefile` then appends `$(shell find $(obj)/dts/ -name \*.dtb)`, because the defconfig sets `CONFIG_BUILD_ARM64_APPENDED_DTB_IMAGE=y` without `..._NAMES`; safe only because `Image.gz-dtb` depends on `dtbs` in the parent make. The appended set is every base dtb for every enabled SoC, as LineageOS ships. Leave `KERNEL_DEVICETREE` **unset**, or the bbclass concatenates a second copy.

## Boot image

Header **v1**, header_size 1648, pagesize 4096, kernel `0x00008000`, ramdisk `0x01000000`, second `0x00000000`, tags `0x00000100`, os_version `0x1E0001A9` (15.0.0 / 2026-09) — verified field-by-field against the shipping LineageOS boot.img. dtb appended to the kernel (`Image.gz-dtb`); `BOARD_KERNEL_SEPARATED_DTBO`, so per-board overlays are in `dtbo.img`, which stays stock. First header-v1 device in the tree: `kernel_android.bbclass` used to split the appended FDT off and drop it; the split is now `hv == 2` only, and a v1 machine that names a tree gets it concatenated onto the kernel (boot-images.md § Boot header versions).

Built image, parsed (`boot-fajita-luneos.img`):

```
header_version 1   header_size 1648   page_size 4096
kernel   13,697,391 B @ 0x00008000
ramdisk   6,650,223 B @ 0x01000000     (the Halium initramfs)
second            0 B @ 0x00000000
tags                  @ 0x00000100
os_version 0x1e0001a9 -> 15.0.0 / 2026-09
recovery_dtbo 0 / 0
image total 20,357,120 B of a 64 MB boot partition
```

- **`id` matches AOSP `mkbootimg`'s sha1** over (kernel, ramdisk, second, recovery_dtbo). LineageOS's own `id` (`fc5582e53685af99d35826eb9a03ee1d386f8e60`) matches none of nine recipes tried (v1 AOSP, v0-style, padded sections, big-endian lengths, whole-image, …); their image has an AVB hash footer and is padded to 64 MB, and boots, so **`id` is not load-bearing on this bootloader**. Do not chase it.
- **Three appended FDTs** at 0xbe113c after a 12,456,252 B gzip payload: `model` "SDM845 v2.1 SoC", "SDM845 v1 SoC", "SDM845 v2 SoC", totalsizes 415,955 / 411,644 / 416,041 — the tree's `sdm845-v2.1.dtb`, `sdm845.dtb`, `sdm845-v2.dtb`. `sdm845-v2.1.dtb`, the one every overlay declares, is there.
- **Window:** `0x01000000 - 0x8000 = 16,744,448 B`; kernel 13,697,391 B (bases built with `DTC_FLAGS=-@`), **3,047,057 B spare** with `KALLSYMS_ALL` off. Whether this ABL honours the offsets is unknown; the image fits regardless (boot-images.md § The kernel/ramdisk window — a build-time invariant). `IKHEADERS` does not exist on 4.9.
- Release and debug images are different kernels (13,697,391 vs 13,697,509 B); the debug one carries `CONFIG_CMDLINE=" loglevel=3 systemd.unified_cgroup_hierarchy=0 SYSTEMD_CGROUP_ENABLE_LEGACY_FORCE=1 enable_adb"` with `CMDLINE_EXTEND=y`.

Both header corrections needed `bitbake -f -c deploy` (device-bringup-yocto.md § ANDROID_BOOTIMG_* changes do not always re-run do_deploy).

## Vendor and GSI

Target: the **LineageOS 22.2 vendor** (Android 15, SDK 35, `ro.board.api_level=202404`), so `PREFERRED_VERSION_android-headers-halium = "16.0%"` and the Halium 16 GSI with no VNDK snapshot (architecture.md § Glossary, VNDK). Read from the vendor's own build.prop, not reasoned from `BOARD_VNDK_VERSION := current`. A stock OxygenOS 11 phone is vendor API 30 and wants the Halium 11 GSI. The installer picks the GSI at install time; only `android-headers-halium` is pinned in the build. `VENDOR_SECURITY_PATCH := 2021-11-01` in `BoardConfigCommon.mk` is the OxygenOS 11 blob vintage, not an API level.

Shipped because of the matched pair: `vendor.img` from the same `lineage-22.2-20260922` build as the kernel SRCREV, extracted from the OTA `payload.bin` with `payload_extract.py` (sha256-verified against the manifest). No module coupling here, but the HAL-to-kernel-interface coupling exists and pinning both halves is cheap.

### Android 15 vendors report a *dated* API level

Found here, confirmed on surya; the mechanism and the resolution table are in hal-userspace.md § Before blaming AIDL. Measured:

| vendor | `ro.board.api_level` | `ro.vendor.build.version.sdk` | `ro.vndk.version` |
|---|---|---|---|
| fajita, LineageOS 22.2 | 202404 | 35 | absent |
| surya, /e/OS A15 | 202404 | 35 | absent |

`luneos-device-config` wrote 202404 straight into gbinder's `ApiLevel`, which selects preset 36 (`aidl6`) against an A15 vendor that speaks preset 35's `aidl5`. The fix maps a dated value to `ro.vendor.build.version.sdk`, with a date table when the vendor declares no SDK, and warns on an unknown date. Checked against eight property combinations: both A15 vendors select 35, an A16 date selects 36, sargo (numeric 32 → preset 31) and an Android 13 vendor (vndk 33 → preset 33) are unchanged.

A property whose format changed is more dangerous than one that went missing: a missing `ro.vndk.version` falls through to a fallback; `202404` where an SDK number is expected is a valid integer and every comparison silently succeeds.

## Yocto

| File | |
|---|---|
| `meta-oneplus/conf/machine/fajita.conf` | the machine |
| `meta-oneplus/recipes-kernel/linux/linux-oneplus-fajita_git.bb` | kernel + boot image |
| `.../linux-oneplus-fajita/luneos.cfg` | the config delta |
| `.../linux-oneplus-fajita/0001-qcacld-drop-Werror-from-the-vendor-Kbuild.patch` | the one vendor patch |
| `.../linux-oneplus-fajita/module-signing/` | pinned module signing key (sargo's) |
| `meta-android/classes/kernel_android.bbclass` | the header-v1 dtb fix |
| `meta-luneos/…/luneos-device-config/adaptations/OnePlus6T/deviceinfo` | Tier 1 adaptation |
| `meta-luneos/…/luneos-device-config/luneos-device-config` | the dated-API-level fix |

```sh
MACHINE=fajita bitbake initramfs-android-image
MACHINE=fajita bitbake linux-oneplus-fajita    # -> Image.gz-dtb-fajita.fastboot
```

nyx module selection comes from the `halium` override in `nyx-modules-machines.inc` (nyx-modules.md § Module selection); this machine builds no rootfs anyway.

**Adaptation directory is `OnePlus6T`**, the vendor's `ro.product.vendor.device`, not the codename; an `adaptations/fajita/` would never be read (deviceinfo-reference.md § When the compositor starts but ignores the touchscreen). The MACHINE stays `fajita`; a `stubbed-services.d` file, if ever added, follows the vendor name too. The adaptation sets `deviceinfo_display_dpi` 402 and `deviceinfo_device_pixel_ratio="2.4"` (carried from sargo/sunfish on the same-1080-px-width reasoning; measured there, not here), and pins `deviceinfo_key_devices_by_name="qpnp_pon;gpio-keys"`. Input nodes from `fajita.dtsi`:

```
qpnp_pon        power key, pm8998 (and the volume-down half of the pon combo)
gpio_keys       volume up, volume down (pm8998_gpios 5), hall sensor
                compatible = "gpio-keys", label = "gpio-keys"
tri_state_key   the alert slider (oneplus,tri-state-key) — a switch, but an input device
goodix_fp       under-display fingerprint (fpc and silead nodes beside it are alternative
                suppliers the same firmware can drive, not extra hardware)
synaptics-rmi-ts  the touchscreen ("HWK,synaptics,s3320"); /proc/touchpanel/double_tap_enable
```

The touchscreen is left to derivation: only one node advertises `ID_INPUT_TOUCHSCREEN`.

Deliberately not shipped: a stubbed-services file (LineageOS's livedisplay here is the AIDL `vendor.lineage.livedisplay-service.oneplus_sdm845`, `proprietary: true`, `class late_start`, driving sysfs display nodes; stub it only from a logcat showing it crash); udev rules (check `ueventd.qcom.rc` against the generic `65-android.rules` on first boot); a `/24` of its own in the gadget subnet table (halium devices share `172.16.45`).

## Install

Fastboot A/B kit (installing.md). Kit: `boot-fajita-luneos.img` / `-debug.img` (20,357,120 B each), `vendor.img` (1,073,741,824 B, paired LineageOS build), `vbmeta.img` (LineageOS's own, signed SHA256_RSA2048, flags 0x3), `vbmeta-disabled.img` (generated empty unsigned fallback for a stock-OOS vbmeta), `android-rootfs.img` (1,058,705,408 B, shared Halium 16 `halium_arm64`), `rootfs.img` (3,109,787,648 B, `halium-arm64`), `userdata-luneos.img` (4,587,520,000 B ext4, both images at the root, verified with `debugfs`); scripts `install.sh`, `make-userdata.sh`, `make-vbmeta.sh`, `make-debug-boot.sh`, `payload_extract.py`.

- **Flash both slots** (`boot_a`/`boot_b`, `vendor_a`/`vendor_b`): the bootloader can fall back to the inactive slot.
- `vendor` is a real partition, so bootloader fastboot writes it; no fastbootd.
- LineageOS already builds vbmeta with `--set_hashtree_disabled_flag --set_verification_disabled_flag` (`BOARD_AVB_MAKE_VBMETA_IMAGE_ARGS`); flashing with `--disable-verity --disable-verification` is still the habit.
- Flashing `boot` replaces recovery. Keep the LineageOS boot.img.

## Open issues

- First boot on hardware.
- Rebuild the rootfs and userdata image (Status).
- `deviceinfo_device_pixel_ratio` is reasoned, not measured.

## Sources

- https://github.com/LineageOS/android_kernel_oneplus_sdm845 (branch `lineage-22.2`)
- https://github.com/LineageOS/android_device_oneplus_fajita
- https://github.com/LineageOS/android_device_oneplus_sdm845-common
- https://wiki.lineageos.org/devices/fajita
- https://github.com/shr-distribution/meta-smartphone (`meta-oneplus`)
