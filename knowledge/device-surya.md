# Device: surya (Xiaomi POCO X3 NFC, SM7150-AC)

Xiaomi POCO X3 NFC (`surya`), Qualcomm SM7150-AC / Snapdragon 732G, Tier B on an /e/OS A15 vendor: built host-side from shipping images; one on-device logcat, little else tested.

The port was done host-side from a downloaded ROM: every fact below was read out of
shipping images — the /e/OS build the device runs and the MIUI fastboot ROM under
it — rather than out of a BoardConfig. Notable for having **no stock vendor kernel
modules at all** (wifi is built in), which makes a rebuilt Tier B kernel
self-contained, and as the device whose stock image boots past the nominal
kernel/ramdisk window (boot-images.md § The kernel/ramdisk window — a build-time
invariant).

## Status (as of 27 Sep 2026)

The only hardware evidence is a logcat taken on a POCO X3 running LuneOS on
26 Sep 2026, cited in meta-xiaomi's `stubbed-services-surya`.

| Area | State | Notes |
|---|---|---|
| Boot, Android container | booted on hardware | the 26 Sep logcat shows the container's services and host-side `sensorfwd` running |
| Camera (HAL) | enumerates | CameraService listed cameraId 0, 1, 21 in that logcat; nothing beyond enumeration recorded |
| Sensors | broken | `sensorfwd` cannot reach `ISensors` through libgbinder; retest at the corrected gbinder `ApiLevel` (Vendor and GSI) |
| Display/UI, touch, wifi, BT, modem, audio, NFC, fingerprint, charging | untested | nothing recorded |

## Platform facts

| Fact | Value | Source |
|---|---|---|
| SoC | Qualcomm **SM7150-AC / SDMMAGPIE** (Snapdragon 732G) | boot dtb root node — `qcom,sdmmagpie`, `qcom,msm-id <0x16d 0x0>` |
| Launch Android | 10 → a real `super`, **not** retrofit dynamic partitions | BoardConfig `BOARD_SUPER_PARTITION_SIZE := 8589934592` |
| Slots | **A-only**, real `recovery` partition | BoardConfig; no slot suffix anywhere in the /e/OS zip |
| Vendor as shipped | **/e/OS 4.2 A15** community (`e-4.2-a15-20260816663279`), lineage-22.2 base → API 35 → Halium 16 GSI | e.foundation build listing |
| Kernel | **4.14.356-openela-rc1**, arm64, pre-GKI → Tier B | IKCONFIG extracted from the /e/OS `boot.img` |
| wifi | `CONFIG_QCA_CLD_WLAN=y` — **built in** | stock config |
| Loadable modules | exactly one (`MMC_TEST=m`) | stock config |
| boot partition | 128 MB (`BOARD_BOOTIMAGE_PARTITION_SIZE`); stock content 17.8 MB kernel + 1.7 MB ramdisk | BoardConfig, stock image |
| dtbo | separate `dtbo.img` (24 MB), stays stock | `BOARD_KERNEL_SEPARATED_DTBO := true` |
| vbmeta | /e/OS builds it `--flags 3` (verity *and* verification already off) | BoardConfig `BOARD_AVB_MAKE_VBMETA_IMAGE_ARGS` |
| Display | 6.67" 1080×2400; `MACHINE_DISPLAY_PPI = 395` (arithmetic); LineageOS density 440 | surya.conf, LineageOS device tree |

**The fact that shapes the whole port:** wifi is in the kernel and the device has
no stock vendor `.ko`s at all. So a rebuilt kernel is self-contained — this port
needs neither the Tier A KMI discipline nor `CONFIG_MODULE_FORCE_LOAD`. Check this
first on any new Tier B target (kmi-crc-matching.md § Step −1 — first ask whether
you need to match at all).

## Kernel

- Tree: `LineageOS/android_kernel_xiaomi_surya`, branch `lineage-22.2`, SRCREV
  `21aca2e848f6697311ad801176e4c4aa4ddc52c7` ("surya: Switch to ir-spi driver"),
  the tree and branch the /e/OS build reports. The device's `lineage.dependencies`
  maps `kernel/xiaomi/surya` there — **not** the `sm6150` repo, a different tree
  with no `surya_defconfig`.
- Toolchain: OE's GCC 15. The tree had only ever been built with Android's clang;
  it cost two patches:

| Patch | Why |
|---|---|
| `0001-techpack-qcacld-drop-Werror-from-the-vendor-Kbuilds` | 27 Kbuilds under `techpack/`, `qcacld-3.0`, `qca-wifi-host-cmn`, `fw-api` set `-Werror` unconditionally; GCC 15 diagnoses pre-existing `-Wpointer-sign` in the QTI audio techpack that clang does not. `-Werror=<specific>` forms left alone |
| `0002-init-keep-the-build-flags-out-of-linux_banner` | on a 4.14/4.19 tree `init/Makefile` passes `$(CONFIG_CC_VERSION_TEXT) $(KBUILD_CFLAGS)` as the compiler version and the former does not exist before 5.x, so the banner *is* the flag list — under OE including `-fmacro-prefix-map=<TMPDIR>/...`, which puts build paths into `vmlinux`, `uname -v` and every dmesg. `do_package_qa` catches it as `[buildpaths]`. Worth carrying to every LineageOS msm tree |

- Config: `mer_verify_kernel_config` gives 8 errors / 54 warnings on stock /e/OS
  (IKCONFIG) and **1 / 29** on `surya_defconfig` + `luneos.cfg`; the remaining
  error is `CONFIG_DUMMY=y`, kept at the stock Android value. `IKHEADERS` and `KALLSYMS_ALL` are off as size levers (3.6 MB
  together). `NETCONSOLE` + `NETCONSOLE_DYNAMIC` are on and the cmdline carries
  `printk.devkmsg=on`: there is no accessible debug UART, so netconsole over the
  USB gadget and the initramfs adb shell are the early-boot channels. That is safe
  here because no prebuilt network module loads (kmi-crc-matching.md § NETCONSOLE
  and `NET_POLL_CONTROLLER`).
- Standalone kernel build traps (bitbake handles both): OE's `gcc-cross` picks the
  host `as` from `PATH` and dies with `as: unrecognized option '-EL'` — pass `-B`
  at a directory of unprefixed symlinks via `KCFLAGS`/`KAFLAGS`, kept **out of
  `PATH`** or the host tools (`fixdep`) link against the aarch64 `ld`. Host GCC
  defaults to `-std=gnu23`, so `scripts/unifdef.c` fails on `static bool
  constexpr;` — `BUILD_CFLAGS:append = " -std=gnu17"`.

## Boot image

Header **v2**, page size **4096**, every field verified against the shipping
/e/OS image:

```
header_version 2      page_size 4096      os_version 15.0.0 / 2026-08
base 0x00000000 + kernel_offset 0x00008000
ramdisk 0x01000000    tags 0x00000100     second 0x00000000 (none)
dtb     0x01f00000
BOARD_KERNEL_IMAGE_NAME = Image.gz, BOARD_INCLUDE_DTB_IN_BOOTIMG = true
cmdline: androidboot.hardware=qcom service_locator.enable=1
         lpm_levels.sleep_disabled=1 loop.max_part=7
         androidboot.init_fatal_reboot_target=recovery
```

`os_version` is the packed field `0x1E0001A8` — read it back out of the stock
header rather than encoding it from the version string.

One image to flash: no `vendor_boot`, no `init_boot`, no DLKM fragment. The dtb
section is a **single bare FDT** (not an AOSP dt_table) holding the SoC base tree
`sdmmagpie.dtb`; the device-specific overlays live in the stock `dtbo.img`. Our
rebuilt dtb has the same root `model`, the same `qcom,msm-id`, and `__symbols__`
present with no `__fixups__`, so ABL can still apply those overlays. It differs
in size from stock (361,695 vs 345,849 B), attributed to the dtc version.

The kit image is 21,803,008 B of the 128 MB partition. Kernel/ramdisk window
(nominal 16,744,448 B):

| | bytes | vs window |
|---|---|---|
| stock /e/OS 4.14.356 | 17,781,272 | over by 1,036,824 |
| LuneOS, first build | 18,599,221 | over by 1,854,773 |
| LuneOS, `IKHEADERS`+`KALLSYMS_ALL` off | **14,782,385** | **1,962,063 spare** |

The stock image boots despite the overrun, which is the evidence that ABL does not
bind the window here (boot-images.md § The kernel/ramdisk window — a build-time
invariant). Ours fits regardless.

## Vendor and GSI

/e/OS A15 vendor → Halium 16 `halium_arm64` GSI. Measured in the kit's
`vendor.img`:

```
ro.board.api_level=202404      <- Android 15 vendor API level, a YYYYMM date
ro.vendor.build.version.sdk=35
ro.vndk.version                <- absent; VNDK is deprecated from A15
```

`luneos-device-config` used to write `ro.board.api_level` straight into gbinder's
`ApiLevel`, which selects preset 36 (`aidl6`) against a vendor that speaks preset
35's `aidl5`. It now resolves a dated value to `ro.vendor.build.version.sdk` (35)
— see device-fajita.md § Android 15 vendors report a *dated* API level, and it
selected the wrong binder protocol, and hal-userspace.md § Binder and gbinder.

**Vendor alignment.** The kernel is pinned to the revision /e/OS builds from, so
the vendor matches on a device running that build. The kit also flashes that exact
/e/OS `vendor.img` to guarantee it; `vendor` is a **logical partition inside
`super`**, so it is written from `fastbootd` (`fastboot reboot fastboot`), not
bootloader fastboot. Extracting it from a LineageOS-family block OTA:
`brotli -d vendor.new.dat.br` (OE ships `brotli-native`), then reassemble against
`vendor.transfer.list` — only the `new` commands consume bytes, so a sparse file
gives the rest for free. **Verify with `e2fsck -fn`**; an off-by-one in the range
arithmetic produces a plausible-looking image.

## Yocto

Layer `meta-smartphone/meta-xiaomi`, `MACHINE=surya`; the rootfs is the shared
`halium-arm64` image.

| Recipe / file | Role |
|---|---|
| `conf/machine/surya.conf` | the machine (boot image only) |
| `recipes-kernel/linux/linux-xiaomi-surya_git.bb` + `luneos.cfg` | kernel, the two patches above, header-v2 boot image |
| `recipes-core/android-system/.../stubbed-services-surya` | per-codename stub list, shipped in the generic rootfs (`ro.product.vendor.device=surya`) |

`MACHINE=surya bitbake linux-xiaomi-surya` produces the boot image.

## Install

`boot` + `vbmeta` + `userdata` + `vendor` (from fastbootd); `system`, `product`,
`system_ext`, `dtbo`, `recovery`, modem and bootloader stay /e/OS, so the whole
thing reverts by reflashing the /e/OS zip from recovery. `rootfs.img` and
`android-rootfs.img` sit side by side at the top of an unencrypted ext4
`userdata`, and the initramfs grows it to the ~50 GB partition on first boot.
General steps: installing.md.

## Subsystem notes

- **Stubbed:** `vendor.lineage.livedisplay@2.1-service.surya` SIGABRTs on every
  start ("PictureAdjustment backend not ready, exiting") and init restarts it;
  nothing in LuneOS uses it.
- **Not stubbed: `minimedia`.** The once-per-second `ISensors` polling in the
  logcat is host-side `sensorfwd` (five `getBackend()` attempts per run, restarted
  by systemd), not minimedia; stubbing minimedia would remove camera and video for
  a symptom it does not cause.

## Open issues

- **Sensors:** only the AIDL multihal service exists on this vendor; retest on a
  rootfs with the `ApiLevel` fix before stubbing anything (hal-userspace.md §
  Sensors).
- **Display/scaling:** PPI 395 is arithmetic; sargo needed a device pixel ratio
  well away from the natural one.
- **`SERIAL_CONSOLE = ttyMSM0`** is derived from `sdmmagpie.dtsi`
  (`serial0 = &qupv3_se8_2uart`, a `qcom,msm-geni-console`), not observed; a
  retail unit exposes no UART without a jig.
- **dtb size difference** from stock: if the device misbehaves at boot, ship the
  stock blob via `ANDROID_BOOTIMG_DTB` first.
- **SM7150 precedent:** sunfish (SM7150-AB, Snapdragon 730G, LineageOS 23.2
  vendor) reaches the LuneOS UI; sargo (SDM670) is the next nearest.

## Sources

- https://github.com/LineageOS/android_kernel_xiaomi_surya (`lineage-22.2`)
- https://wiki.lineageos.org/devices/surya/
