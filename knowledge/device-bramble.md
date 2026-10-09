# Device: bramble (Google Pixel 4a 5G, SM7250)

Google Pixel 4a 5G (`bramble`), Qualcomm SM7250 (lito, Snapdragon 765G), Tier B run with Tier A discipline on a LineageOS 23.2 vendor; built and verified host-side, never booted.

A Pixel of the same generation as sunfish but a different machine in almost every
way that matters: header v3 with a `vendor_boot`, and its storage, clocks, pinctrl
and display drivers are all **vendor modules in the `vendor_boot` ramdisk**, so a
module that will not load means no storage and no boot. The 4.19 redbull tree is
not GKI, but the port has to keep a KMI anyway. It is the device that reached 0 of
218 stock modules failing in three measured steps (kmi-crc-matching.md § Step 1 —
get the vendor's real config, not its defconfig, and § Step 6 — always have a
baseline switch), and then moved to shipping its own modules (kmi-crc-matching.md §
The initramfs route).

## Status (as of 30 Sep 2026)

**Nothing has run on a Pixel 4a 5G.** Everything is derived from LineageOS's trees
and the stock factory images.

| Area | State | Notes |
|---|---|---|
| Kernel + modules build | done (host) | 329 modules built, covering all 221 LineageOS ships; vermagic identical to the vendor's |
| Boot image | built (host) | header v3, 37,679,104 B |
| Boot, display, touch, wifi, BT, modem, audio, sensors, camera, NFC, fingerprint, charging | untested | never flashed |

First checks on hardware (the first line decides whether it boots):

```sh
dmesg | grep -iE 'disagrees about version|Unknown symbol'   # expect nothing
dmesg | grep -i "installed .* of our own kernel modules"    # the swap
lsmod | wc -l                                              # expect ~221
dmesg | grep -iE 'ufs|scsi 0'                               # storage came up
journalctl -b | grep -i "gbinder ApiLevel"                  # expect 36
```

## Platform facts

| Fact | Value | Source |
|---|---|---|
| SoC | Qualcomm SM7250 (lito) | bramble.conf; LineageOS wiki |
| Device tree / kernel family | **redbull**, shared with redfin (Pixel 5); `device/google/bramble` is a thin shim over it | LineageOS trees |
| Stock reference | `UP1A.231105.001.B2` (Android 14, patch 2023-11); last OTA reports vndk 34 | factory image |
| Launch | Android 11 → no `init_boot` | bramble.conf |
| boot | header **v3**, kernel + generic ramdisk, **empty cmdline** (stock: 11,726,538 B lz4 kernel, 2,045,806 B ramdisk); 100 MB partition | stock boot.img |
| vendor_boot | device tree (405,231 B at 0x1f00000), the real kernel cmdline, a 30 MB vendor ramdisk holding the kernel modules | stock vendor_boot.img |
| Vendor modules | redbull's `modules.load` has 329 entries, incl. `ufs_qcom`, `ufshcd-core`, `ufshcd-pltfrm`, `pinctrl-lito`, `clk-qcom`, `gcc-lito`, `msm_drm`, `msm_adreno`; LineageOS 23.2's vendor_boot ships 221; the rev 1 CRC check covered 218 of Google's stock modules | redbull, kit |
| Storage | UFS, by-name at `/dev/block/platform/soc/1d84000.ufshc/by-name/` | bramble.conf |
| Display | 6.24" 1080×2340, 413 ppi | bramble.conf |
| Console | `ttyMSM0` (stock vendor_boot cmdline; needs a serial adapter) | bramble.conf |

## Kernel

- **Tree:** `LineageOS/android_kernel_google_redbull`, branch `lineage-23.2`,
  SRCREV `a0096400123a165d701f23c7745d8d8e721d049d` — the revision LineageOS 23.2's
  `build-manifest.xml` names. vermagic
  `4.19.325-cip135-st19-ga0096400123a` (`vermagic.cfg`:
  `CONFIG_LOCALVERSION="-ga0096400123a"`). At this revision
  `techpack/{audio,camera,dataipa,display,video}` are populated, so `msm_drm.ko`,
  `msm-vidc.ko`, the fts touch driver and `vd6281` can be built; at the stock
  revision four modules could not be produced.
- **Config base:** the config LineageOS 23.2's build shipped (extracted from
  `IKCFG_ST` in its `boot.img`, 6046 lines), then `luneos.cfg`.
  `LUNEOS_KERNEL_FRAGMENT ?= "1"`; `"0"` builds the pure baseline.
- **Toolchain: Clang r416183b**, forced: `redbull_defconfig` sets `LTO_CLANG`,
  `CFI_CLANG` and `SHADOW_CALL_STACK`. GCC stops at `'-fsanitize=shadow-call-stack'
  requires '-ffixed-x18'`, and turning the three off would leave the stock CFI/SCS
  modules loading into a kernel that does not maintain x18 or implement their CFI
  checks — vermagic would not catch it (`MODULE_ARCH_VERMAGIC` is just `aarch64`).
  The recipe follows `linux-zinwa-q25` (own configure/compile with the prebuilt
  Clang, no kernel.bbclass), so it does not provide `virtual/kernel`
  (`linux-dummy`). Set `GKI_CLANG_DIR:bramble`.
- **Config delta:** deliberately smaller than sunfish's — it leaves out `IPC_NS`,
  `FANOTIFY` and `NET_L3_MASTER_DEV` (bluejay's KMI-poison list, kept as caution);
  `CONFIG_SYSVIPC` is off (not needed). Measured 22 Sep 2026: the whole delta
  scores 0 of 218 stock modules failing, the same as the stock-config baseline, so
  nothing in it poisons this KMI. `CONFIG_MODULE_FORCE_LOAD=y` is a bisecting
  escape hatch only — forcing a module whose layouts moved corrupts memory, and here
  those modules are the storage stack. No compat vDSO, unlike stock.
- **Module strategy: ship our own build.** `ANDROID_INITRAMFS_KERNEL_MODULES = "1"`
  puts all 329 in the initramfs (ramdisk 2.8 → 24.3 MB). `init.sh`'s
  `stage_our_kernel_modules()` copies ours over `/lib/modules` before anything is
  modprobed, keeping the vendor's `modules.load`, `modules.dep` and
  `modules.softdep` as the authority on what loads and in what order. The copy is
  explicit because cpio layering does not substitute here: the vendor ramdisk has a
  real `/lib/modules`, ours is usrmerge (`/usr/lib/modules`), and our `/lib ->
  usr/lib` symlink cannot be created over the vendor's directory. LineageOS keeps
  the 221 modules flat at `/lib/modules/*.ko`, while `modules_install` writes
  `/lib/modules/<version>/kernel/...`, so `do_install` flattens them. No bind-mount
  is needed, unlike sunfish. Rules: kmi-crc-matching.md § The initramfs route.

### Rejected paths

- **Matching Google's stock modules (rev 1).** Pinned to `7b0944645172`
  (4.19.278, the revision Google's stock vermagic names) and reached **0 of 218**
  stock modules failing in three measured steps: Clang instead of GCC; the vendor's
  revision instead of the `lineage-22.2` tip (4.19.325, 47 stable releases on,
  which failed all 218 on `module_layout`); and the vendor's shipped config instead
  of `redbull_defconfig` — even at the right revision a pure stock-defconfig build
  failed 170 of 218, because the public defconfig has `DEBUG_FS=y` and
  `CORESIGHT=y` while Google's user build has both off (11 symbols differ in all).
  Right answer to the wrong question: the phone runs LineageOS's `vendor_boot`, not
  Google's, so rev 2 and later pin LineageOS 23.2's revision and ship their own
  modules.

## Boot image

Header **v3**, kernel `Image.lz4` + the Halium initramfs, no dtb section (the device
tree stays in `vendor_boot`), `ANDROID_BOOTIMG_CMDLINE = ""` (the real cmdline is
vendor_boot's), `ANDROID_BOOTIMG_OS_VERSION = "0x1c00017b"` (Android 14 /
2023-11), no `init_boot`. Built by `luneos-bootimg-gki` with
`GKI_KERNEL_PROVIDER = "linux-google-bramble"` — the bluejay/panther class
(boot-images.md § Class 2 — A12-launch GKI (ramdisk in `boot`)). Kit image
37,679,104 B, 37% of the 100 MB partition.

## Vendor and GSI

LineageOS 23.2 vendor and `vendor_boot`, both flashed from the same revision as the
kernel so the three cannot diverge:

```
kernel + modules   4.19.325-cip135-st19-ga0096400123a   built here
vendor_boot        LineageOS 23.2, same revision         flashed
vendor             LineageOS 23.2, same revision         flashed
```

Halium 16 `halium_arm64` GSI. gbinder `ApiLevel` should resolve to 36.
`extract-vendor.sh` builds `vendor-los232.img` from a LineageOS 23.2 OTA zip.

## Yocto

Layer `meta-smartphone/meta-google`, `MACHINE=bramble`; rootfs `MACHINE=halium-arm64`.

| Recipe / file | Role |
|---|---|
| `conf/machine/bramble.conf` | boot image only; `GKI_BOOTIMG = "1"`, `GKI_KERNEL_PROVIDER`, header v3, modules in the initramfs |
| `recipes-kernel/linux/linux-google-bramble_git.bb` + `lineage-config`, `luneos.cfg`, `vermagic.cfg`, `buildfix.cfg` | kernel and modules, Clang-built |
| `adaptations/bramble/deviceinfo` (luneos-device-config) | Tier 1: key devices, display |
| `stubbed-services.d/bramble` | per-codename stub list |

```sh
MACHINE=bramble bitbake initramfs-android-image
MACHINE=bramble bitbake luneos-bootimg-gki     # builds linux-google-bramble on the way
```

No udev rules of its own: everything redbull's `ueventd.rc` grants is already in
the generic `65-android.rules`; the 17 remaining entries are Airbrush/face-auth/
charger-logbuffer nodes nothing in LuneOS reads.

## Install

```sh
./extract-vendor.sh lineage-23.2-<date>-nightly-bramble-signed.zip   # once
./install.sh
```

`install.sh` flashes `vbmeta` (verity and verification off), `boot`, `vendor_boot`
and `userdata`, then reboots into **fastbootd** for `vendor` (a logical partition in
`super`). Prerequisite: Google's stock factory image flashed and booted once,
bootloader unlocked (it supplies bootloader, modem, tz and other firmware). LineageOS
need not be installed. `boot` is recovery on this A/B device: keep the stock
`boot.img` and `vbmeta.img` to undo the kit. General steps: installing.md.

## Open issues

- **It has never booted.** Every result above is host-side.
- **Key devices and DPI are guessed:** `adaptations/bramble/deviceinfo` pins
  `qpnp_pon;gpio-keys` and 413 ppi from geometry; `device_pixel_ratio` is unset
  (sargo's 2.4 is the first value to try).
- **pKVM early modules:** gs101/gs201 need `/system/bin/modprobe` in the initramfs
  before `/init`; this Qualcomm device should not, but check if it reboots to the
  bootloader early.

## Sources

- https://github.com/LineageOS/android_kernel_google_redbull (`lineage-23.2`)
- https://wiki.lineageos.org/devices/bramble/
