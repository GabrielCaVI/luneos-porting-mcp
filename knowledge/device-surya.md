# Device: surya (Xiaomi POCO X3 NFC, SM7150) — Tier B, built entirely without the hardware

Xiaomi POCO X3 NFC (`surya`), Qualcomm SM7150-AC / Snapdragon 732G, Tier B on an /e/OS A15 vendor: boot image builds and is verified host-side; never run on hardware.

The port that was done host-side from a downloaded ROM: no POCO X3 was ever
attached. Everything below was read out of shipping images — the /e/OS build the
device runs and the MIUI fastboot ROM under it — rather than out of a
BoardConfig. `MACHINE=surya bitbake linux-xiaomi-surya` produces a complete
header-v2 boot image; nothing has been observed on hardware, and the open
questions at the end say which claims that leaves soft. Layer:
`meta-smartphone/meta-xiaomi`.

## Platform facts

| Fact | Value | How it was established |
|---|---|---|
| SoC | Qualcomm **SM7150-AC / SDMMAGPIE** (Snapdragon 732G) | boot dtb root node — `qcom,sdmmagpie`, `qcom,msm-id <0x16d 0x0>` |
| Launch Android | 10 → a real `super`, **not** retrofit dynamic partitions | BoardConfig `BOARD_SUPER_PARTITION_SIZE := 8589934592` |
| Slots | **A-only**, real `recovery` partition | BoardConfig; no slot suffix anywhere in the /e/OS zip |
| Vendor as shipped | **/e/OS 4.2 A15** community (`e-4.2-a15-20260816663279`), lineage-22.2 base → API 35 → Halium 16 GSI | e.foundation build listing |
| Kernel | **4.14.356-openela-rc1**, arm64, pre-GKI → Tier B | IKCONFIG extracted from the /e/OS `boot.img` |
| Kernel tree | `LineageOS/android_kernel_xiaomi_surya`, branch `lineage-22.2` | the device's `lineage.dependencies` maps `kernel/xiaomi/surya` there — **not** the `sm6150` repo, which is a different tree that has no `surya_defconfig` |
| wifi | `CONFIG_QCA_CLD_WLAN=y` — **built in** | stock config |
| Loadable modules | exactly one (`MMC_TEST=m`) | stock config |
| dtbo | separate `dtbo.img` (24 MB), stays stock | `BOARD_KERNEL_SEPARATED_DTBO := true` |
| vbmeta | /e/OS builds it `--flags 3` (verity *and* verification already off) | BoardConfig `BOARD_AVB_MAKE_VBMETA_IMAGE_ARGS` |

**The fact that shapes the whole port:** wifi is in the kernel and the device has
no stock vendor `.ko`s at all. So a rebuilt kernel is self-contained — this port
needs neither the Tier A KMI discipline nor mindphone's
`CONFIG_MODULE_FORCE_LOAD`. Check this first on any new Tier B target; it is the
difference between a comfortable port and a vermagic fight.

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
section is a **single bare FDT** (not an AOSP dt_table like mindphone's) holding
the SoC base tree `sdmmagpie.dtb`; the device-specific overlays live in the
stock `dtbo.img`. Our rebuilt dtb has the same root `model`, the same
`qcom,msm-id`, and `__symbols__` present with no `__fixups__`, so ABL can still
apply those overlays to it. It differs in size from stock (361,695 vs 345,849)
purely by dtc version.

`boot` is 128 MB and the finished image is 21.8 MB — no size pressure at all.
For the kernel/ramdisk window, surya is the documented counterexample: the
shipping **stock /e/OS** kernel runs about 1 MiB past the 16 MiB window and that
image boots on real phones (boot-images.md § The window does not bind on every
bootloader — surya proves it). That is an observation about the stock image, not
about ours — no LuneOS image has run on a surya.

## Building msm-4.14 with the OE toolchain (GCC 15)

The tree has only ever been built with Android's prebuilt clang, so this was the
open risk. It cost **one** patch, not mindphone's six rounds:

| Patch | Why |
|---|---|
| `0001-techpack-qcacld-drop-Werror-from-the-vendor-Kbuilds` | 27 Kbuilds under `techpack/`, `qcacld-3.0`, `qca-wifi-host-cmn`, `fw-api` set `-Werror` unconditionally; GCC 15 diagnoses a pile of pre-existing `-Wpointer-sign` in the QTI audio techpack that clang does not. `-Werror=<specific>` forms left alone |
| `0002-init-keep-the-build-flags-out-of-linux_banner` | see below |

**The banner patch is the one worth carrying to every LineageOS msm tree.**
`init/Makefile` passes `"$(CONFIG_CC_VERSION_TEXT) $(KBUILD_CFLAGS)"` to
`mkcompile_h` as the compiler version, and `CONFIG_CC_VERSION_TEXT` does not
exist before 5.x — so on a 4.14/4.19 tree the banner *is* the flag list. Under
OE that list contains
`-fmacro-prefix-map=<TMPDIR>/work-shared/<machine>/kernel-source/=`, which puts
the builder's absolute paths into `vmlinux`, into `uname -v` and at the top of
every dmesg on the phone. `do_package_qa` catches it as `[buildpaths]`; without
that gate it would have shipped. Pass the compiler's own version line instead.

Two traps when reproducing the kernel build standalone (bitbake handles both):

- OE's `gcc-cross` does not find the cross `as` from `PATH` — it picks the host
  one and dies with `as: unrecognized option '-EL'`. Pass `-B` at a directory of
  unprefixed symlinks via `KCFLAGS`/`KAFLAGS`, and keep that directory **out of
  `PATH`**, or the host tools (`fixdep`) link against the aarch64 `ld` instead.
- Host GCC defaults to `-std=gnu23`, so `scripts/unifdef.c` fails on its
  `static bool constexpr;`. `BUILD_CFLAGS:append = " -std=gnu17"`.

## Kernel config

`mer_verify_kernel_config` scores:

| config | errors | warnings |
|---|---|---|
| stock /e/OS (via IKCONFIG) | 8 | 54 |
| `surya_defconfig` + `luneos.cfg` | **1** | **29** |

The remaining error is `CONFIG_DUMMY=y`, kept at the stock Android value.

`CONFIG_SYSVIPC` is off; LuneOS does not need it. `IKHEADERS` and `KALLSYMS_ALL` are off as size levers,
worth 3.6 MB together. `NETCONSOLE`+`NETCONSOLE_DYNAMIC` are on and the cmdline
carries `printk.devkmsg=on`: this device has **no accessible debug UART**, so
netconsole over the USB gadget plus the initramfs adb shell are the only
early-boot channels.

## Install

`boot` + `vbmeta` + `userdata`; `super` (and therefore `system`/`vendor`), `dtbo`
and `recovery` stay /e/OS, so the whole thing reverts by reflashing the /e/OS zip
from recovery. `rootfs.img` and `android-rootfs.img` sit side by side at the top
of an unencrypted ext4 `userdata`, and the initramfs grows it to the ~50 GB
partition on first boot.

**Vendor alignment.** The kernel is pinned to the same revision /e/OS builds
from, so the vendor already matches on a device running that build. To guarantee
it on a device that is on something else, the kit ships the `vendor.img` from
that exact /e/OS build — but on surya `vendor` is a **logical partition inside
`super`**, so it can only be flashed from `fastbootd` (`fastboot reboot
fastboot`), not from bootloader fastboot. Keep that opt-in: it is the
`super`-rewriting dance the architecture deliberately avoids.

Extracting it from a LineageOS-family block OTA is two steps and no special
tooling: `brotli -d vendor.new.dat.br` (OE ships `brotli-native`), then
reassemble against `vendor.transfer.list` — only the `new` commands consume
bytes, everything else describes blocks that stay zero, so a sparse file gives
them for free. **Verify with `e2fsck -fn` before shipping it**; a silent
off-by-one in the range arithmetic produces a plausible-looking image.

## Open questions

Nothing here has been on hardware. The structural claims (header fields, dtb
identity, initramfs contents, config) are verified; these are not:

- **Display/scaling.** `MACHINE_DISPLAY_PPI = 395` is arithmetic on 6.67"
  1080×2400; LineageOS buckets the device at density 440. sargo needed a device
  pixel ratio well away from the natural one.
- **`SERIAL_CONSOLE = ttyMSM0`** is derived from `sdmmagpie.dtsi`
  (`serial0 = &qupv3_se8_2uart`, a `qcom,msm-geni-console`), not observed — and
  a retail unit exposes no UART without a jig, so it may never be.
- **The dtb size difference** from stock is attributed to dtc versions. If the
  device does not boot, this is the first thing to swap: ship the stock blob via
  `ANDROID_BOOTIMG_DTB`.
- **SM7150 under libhybris on a Halium 16 GSI**: the closest precedent is
  sunfish (SM7150-AB, Snapdragon 730G, LineageOS 23.2 vendor), which reaches the
  LuneOS UI; sargo (SDM670, A12 vendor) is the next nearest.

## Its A15 vendor reports a dated API level, which mis-selected the binder protocol

Found while porting fajita (OnePlus 6T) and confirmed against this device's own
`vendor.img` (the one in its install kit):

```
ro.board.api_level=202404      <- Android 15 vendor API level, a YYYYMM date
ro.vendor.build.version.sdk=35
ro.vndk.version                <- absent; VNDK is deprecated from A15
```

`luneos-device-config` wrote `ro.board.api_level` straight into gbinder's
`ApiLevel`, and libgbinder picks the highest preset **≤** that value from
`{36,35,33,31,30,29,28}` — so a date always selects the newest, preset 36
(servicemanager `aidl6`), against a vendor that speaks preset 35's `aidl5`.

That is the shape of the open sensors problem recorded in
`stubbed-services-surya`: `sensorfwd`'s AIDL backend failing to reach
`android.hardware.sensors.ISensors/default` through libgbinder while the
container's own servicemanager resolves it fine, which that note had already
narrowed to "a libgbinder servicemanager API-level problem". **Retest sensors on
a rootfs built after the fix** before adding anything to the stub list for them.

Full reasoning and the eight-case test matrix: see the dated-API-level section in
device-fajita.md.
