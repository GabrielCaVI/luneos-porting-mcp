# Device: fajita (OnePlus 6T) — the cheap Tier B Qualcomm case

OnePlus 6T (`fajita`), Qualcomm SDM845, Tier B on a LineageOS 22.2 (Android 15) vendor: kernel and boot image build and are verified, never run on hardware.

A pre-GKI Snapdragon 845 running the generic `halium-arm64` rootfs over a
LineageOS 22.2 vendor. It is the **least work of any Tier B port in
the tree**, and worth reading for that reason: no vendor kernel modules, no
dynamic partitions, no retrofit metadata, no per-device rootfs. Everything that
made sargo, sunfish and surya expensive is simply absent here, and what is left
is one machine conf, one kernel recipe, one config fragment and one `deviceinfo`.
Layer `meta-smartphone/meta-oneplus`, `MACHINE=fajita`.

**UNVERIFIED on hardware: no OnePlus 6T has run this.** The kernel builds and the
boot image was parsed and checked (see Status), but everything about the *device*
is derived from LineageOS's device and kernel trees at `lineage-22.2`, not from a
booted phone or a shipping boot image. Where that matters it is called out.

## Platform facts

| Fact | Value |
|---|---|
| SoC | Qualcomm SDM845 (Snapdragon 845), Adreno 630 — the best-trodden libhybris path |
| Launched | Android 9; last OxygenOS is 11 (vendor API level 30). LineageOS carries it to 22.2 / Android 15 (vendor API 35) |
| Kernel | **4.9.337**, `LineageOS/android_kernel_oneplus_sdm845` branch `lineage-22.2` (SRCREV `228c16bfcd256a546e3fde375215f6072135588f`). Pre-GKI → Tier B forever |
| Defconfig | `enchilada_defconfig` — **one config for both SDM845 OnePlus phones**; the 6 vs 6T difference is the dtbo overlay, not the kernel |
| Paired build | `lineage-22.2-20260922-nightly-fajita`. Its `build-manifest.xml` pins `android_kernel_oneplus_sdm845` at the SRCREV this recipe builds, so kernel and vendor are one matched pair |
| Vendor props | `ro.board.api_level=202404` (A15 date format), `ro.vendor.build.version.sdk=35`, **no `ro.vndk.version`**, `ro.product.vendor.device=OnePlus6T`, `ro.product.first_api_level=28`, `ro.vendor.build.security_patch=2021-11-01` |
| A/B | yes (`AB_OTA_PARTITIONS`: boot dtbo system vbmeta vendor) |
| Dynamic partitions | **none.** `system` and `vendor` are real partitions with `slotselect`; there is no `super` and no retrofit metadata, so `parse-android-dynparts` is never involved |
| Storage | UFS, but by-name symlinks are under `/dev/block/bootdevice/by-name/` (see the stock `fstab.qcom`) |
| boot partition | 64 MB, and **is** recovery (`BOARD_USES_RECOVERY_AS_BOOT` + `TARGET_NO_RECOVERY`). Flashing LuneOS replaces recovery; keep the stock boot.img |
| boot header | **v1**, header_size 1648, pagesize 4096, kernel 0x00008000, ramdisk 0x01000000, second 0x00000000, tags 0x00000100, os_version 0x1E0001A9 (15.0.0 / 2026-09). **Verified field-by-field against the shipping LineageOS boot.img** |
| dtb | appended to the kernel (`Image.gz-dtb`). `BOARD_KERNEL_SEPARATED_DTBO`, so the per-board overlays are in `dtbo.img`, which stays stock |
| userdata | `fileencryption=ice` in the stock fstab → must be reformatted unencrypted |
| Builds | boot.img + initramfs only. Rootfs is `MACHINE=halium-arm64`; the GSI is chosen at install time |

## Header v1 has no dtb section, and the bbclass used to drop the tree

fajita is the **first header-v1 device in the tree** (athena is v0; sargo,
sunfish, surya, mindphone and radon are v2). v1 adds only the `recovery_dtbo`
fields to v0 — the dtb section arrives in v2 — so a v1 image carries its device
tree appended to the kernel, which is exactly what
`BOARD_KERNEL_IMAGE_NAME := Image.gz-dtb` delivers.

`kernel_android.bbclass` treated v1 like v2: it split the appended FDT off the
kernel into a `dtb` variable that `android_bootimg_v2()` then writes **only for
`hv >= 2`**. The result was an image whose kernel had no device tree and whose
tree went nowhere, with no error anywhere. Fixed by narrowing the split to
`hv == 2` and, for a v1 machine that does name a tree
(`KERNEL_DEVICETREE`/`ANDROID_BOOTIMG_DTB`), concatenating it onto the kernel
instead.

Worth remembering as a class of bug: an image assembler that is given a section
it has no field for will usually be silent about it.

## Image.gz-dtb on this tree: the dtb comes from the dtbo bases

With `CONFIG_BUILD_ARM64_DT_OVERLAY=y`, `dtb-y` for SDM845 is **empty** — the
base-dtb list lives in the `else` branch of
`arch/arm64/boot/dts/qcom/Makefile`. The base trees still get built, because
`scripts/Makefile.dtbo` does `multi_depend($(dtbo), , -base)` and every fajita
overlay declares `…-overlay.dtbo-base := sdm845-v2.1.dtb`.

`arch/arm64/boot/Makefile` then builds `Image.gz-dtb` as `Image.gz` plus
`$(shell find $(obj)/dts/ -name \*.dtb)`, because the defconfig sets
`CONFIG_BUILD_ARM64_APPENDED_DTB_IMAGE=y` but no
`CONFIG_BUILD_ARM64_APPENDED_DTB_IMAGE_NAMES`. That `find` runs when the boot
Makefile is parsed — which is safe only because `Image.gz-dtb` depends on `dtbs`
in the *parent* make, so the sub-make sees the built blobs. It also means the
appended set is "every base dtb for every enabled SoC", which is what LineageOS
ships too.

Consequence for the recipe: leave `KERNEL_DEVICETREE` **unset**. Naming a tree
there would make the bbclass concatenate a second copy.

## No vendor kernel modules — so no KMI problem at all

This is the fact that makes the port cheap, and it is checkable rather than
assumed:

- `CONFIG_QCA_CLD_WLAN=y` — wifi (qcacld-3.0) is built into the kernel.
- `device/oneplus/{fajita,sdm845-common}` contains **no `.ko` anywhere**:
  `proprietary-files.txt` lists none, `common.mk` installs none, and there is no
  `BOARD_VENDOR_KERNEL_MODULES`.
- The `insmod /vendor/lib/modules/qca_cld3_wlan.ko` and the `modprobe`s for
  `pinctrl-wcd`, `wcd-dsp-glink`, `snd-soc-wcd-spi`, `snd-soc-sdm845` left in the
  CAF `init.target.rc` refer to **OxygenOS-era files a LineageOS vendor does not
  have**. They fail harmlessly.

So a rebuilt kernel has no stock vermagic/CRCs to match: neither the Tier A KMI
discipline, nor sunfish's build-the-vendor's-modules-ourselves arrangement, nor
mindphone's `CONFIG_MODULE_FORCE_LOAD` workaround applies. Same situation as
surya. `CONFIG_MODULE_SIG_FORCE=y` stays as stock, with the signing key pinned in
the recipe (sargo's key, byte for byte) so out-of-tree module recipes survive a
kernel rebuild.

**Do not read this as "SDM845 needs no modules".** It is true of a *LineageOS*
vendor. A phone left on OxygenOS 11 presents a vendor that does ship
`qca_cld3_wlan.ko` and expects to insmod it, and that is a different port — one
that would also want the Halium 11 GSI rather than 16.

## Which vendor, and therefore which GSI

The port targets the **LineageOS 22.2 vendor** (Android 15, SDK 35, vendor API
level `202404`), so `PREFERRED_VERSION_android-headers-halium = "16.0%"` and the
Halium 16 GSI — the surya arrangement. Confirmed out of the vendor's own
build.prop, not reasoned from `BOARD_VNDK_VERSION := current`, and note that
**`ro.vndk.version` does not exist on it**: VNDK is deprecated from A15 and the
former VNDK libraries ship inside `/vendor` itself. That is the
Android-15-vendor shortcut athena documented — an A15 vendor serves a Halium 16
GSI with no VNDK snapshot at all — so fajita needs none of the snapshot work
sargo's Halium 16 bring-up did against a 12.1 vendor.

The alternative, a stock OxygenOS 11 phone, is vendor API level 30 and wants the
Halium 11 GSI.

The installer picks the GSI from `ro.board.api_level`/`ro.vndk.version` at install
time either way, so the only thing actually pinned to a generation in the build
is `android-headers-halium` — and that only reaches anything this machine builds,
since the rootfs comes from `halium-arm64`. But see the dated-API-level section
below before trusting `ro.board.api_level` as a number.

`VENDOR_SECURITY_PATCH := 2021-11-01` in `BoardConfigCommon.mk` is the OxygenOS 11
blob vintage LineageOS extracts from; it is not the vendor API level and must not
be read as one.

## Input space: crowded for a slab phone

The athena trap applies here. From `fajita.dtsi`:

```
qpnp_pon        power key, pm8998 (and the volume-down half of the pon combo)
gpio_keys       volume up, volume down (pm8998_gpios 5), hall sensor
                compatible = "gpio-keys", label = "gpio-keys"
tri_state_key   the alert slider (oneplus,tri-state-key) — a switch, but an input device
goodix_fp       under-display fingerprint (the fpc and silead nodes beside it are
                the other two suppliers the same firmware can drive, not extra hardware)
synaptics-rmi-ts  the touchscreen ("HWK,synaptics,s3320"); /proc/touchpanel/double_tap_enable
```

`adaptations/fajita/deviceinfo` pins `deviceinfo_key_devices_by_name="qpnp_pon;gpio-keys"`
— by name, never by number. The touchscreen is left to derivation: there is only
one node advertising `ID_INPUT_TOUCHSCREEN`.

## Display

6.41" 1080x2340 AMOLED (`dsi_samsung_sofef00_m`), notched.
sqrt(1080² + 2340²)/6.41 = **402 ppi**, which the adaptation ships as
`deviceinfo_display_dpi`; LineageOS's `TARGET_SCREEN_DENSITY := 450` is a density
bucket and a different number. `deviceinfo_device_pixel_ratio="2.4"` is carried
over from sargo and sunfish on the "same 1080 px panel width, so the same CSS
width" reasoning — measured there, only reasoned about here.

## Kernel config, versus `enchilada_defconfig`

Each entry in `luneos.cfg` was checked against the stock defconfig rather than
copied from surya's. What is actually off in stock and has to be turned on:
`FHANDLE`, `VT` (and the console/PTY set), `DEVTMPFS`, `UTS_NS`, `PID_NS`,
`USER_NS`, `NET_NS`, `CGROUP_DEVICE`, `MEMCG`, `FANOTIFY`, `BT_HCIVHCI` and the
rest of the BT stack, `HIDRAW`, `SQUASHFS`, `VETH`, the netfilter extras,
`NETCONSOLE`. Already correct, unusually: **`CONFIG_OVERLAY_FS=y`** — so unlike
sargo's 4.9 kernel, `luneos-device-config` can apply the adaptation as one
overlay mount instead of a bind mount per file.

`SYSVIPC` stays off, matching surya and the GKI devices, which takes `IPC_NS`
with it → LXC must not unshare the IPC namespace.

Two stock values deliberately changed for size/behaviour: `KALLSYMS_ALL` off (the
boot-image window lever), and `RT_GROUP_SCHED` off (`waydroid-kernel.inc` forces
this; stock has it on).

The 4.9-tree tax is the same as sargo's: `unifdef.c` declares `static bool
constexpr;`, so the host C standard is pinned with
`BUILD_CFLAGS:append = " -std=gnu17"`, and the USB gadget functions have to be
forced back from `m` to `y` after `oldconfig` or the configfs gadget — and with
it adb and netconsole — does not exist.

## The boot-image window

`ramdisk_offset - kernel_offset = 0x01000000 - 0x8000 = 16,744,448 B`. The kernel
section here is `Image.gz` **plus every appended base dtb**, built with
`DTC_FLAGS=-@` (overlay symbols make them larger than a plain dtb), so the margin
is worth measuring even though the boot partition is 64 MB and nowhere near full.

surya shows the rule does not bind everywhere — its kernel is 1 MiB past the line
and boots, because a v2-era ABL relocates — but the 6T's ABL is a generation
older and nothing establishes which behaviour it has. Measure the produced image;
if it needs shrinking, `KALLSYMS_ALL` is the lever (`IKHEADERS` does not exist on
4.9).

## What is deliberately not shipped

- **No stubbed-services file.** LineageOS's livedisplay here is the AIDL
  `vendor.lineage.livedisplay-service.oneplus_sdm845` (`proprietary: true`, so it
  is in `/vendor/bin/hw/`, `class late_start`), and it drives sysfs display nodes
  directly rather than surya's SDM picture-adjustment backend. There is no reason
  to assume it crashes. Stub it from a logcat that shows it doing so, not from
  another device's list.
- **No udev rules.** Check the device's own `ueventd.qcom.rc` against the generic
  `65-android.rules` on first boot before adding any.
- **No `/24` of its own** in the USB-gadget subnet table: halium devices share
  `172.16.45`, which is fine until two of them are plugged into one host.

Shipped *because* of the matched-pair argument: **`vendor.img`**, from the same
`lineage-22.2-20260922` build the kernel SRCREV comes from. The kernel needs no
vendor modules, so the module coupling surya's kit guards against does not exist
here — but the HAL-to-kernel-interface coupling does, and pinning both halves to
one build is cheap. Extracted from the OTA `payload.bin` with `payload_extract.py`
(sha256-verified against the manifest's digest).

## Files

| File | |
|---|---|
| `meta-oneplus/conf/machine/fajita.conf` | the machine |
| `meta-oneplus/recipes-kernel/linux/linux-oneplus-fajita_git.bb` | kernel + boot image |
| `meta-oneplus/recipes-kernel/linux/linux-oneplus-fajita/luneos.cfg` | the LuneOS/Halium config delta |
| `.../linux-oneplus-fajita/0001-qcacld-drop-Werror-from-the-vendor-Kbuild.patch` | the one vendor patch this port needs |
| `meta-oneplus/recipes-kernel/linux/linux-oneplus-fajita/module-signing/` | pinned module signing key (sargo's) |
| `meta-android/classes/kernel_android.bbclass` | the header-v1 dtb fix above |
| `meta-luneos/…/luneos-device-config/adaptations/OnePlus6T/deviceinfo` | Tier 1 adaptation — **named for the vendor, not the codename** |
| `meta-luneos/…/luneos-device-config/luneos-device-config` | the dated-API-level fix below (affects every A15+ vendor, not just this one) |

```sh
MACHINE=fajita bitbake initramfs-android-image
MACHINE=fajita bitbake linux-oneplus-fajita    # -> Image.gz-dtb-fajita.fastboot
```

No `nyx-modules` cmake file is needed: `nyx-modules-machines.inc` now selects the
module set with a `NYX_MODULES_REQUIRED:halium` override, so any machine carrying
the `halium` override is covered. The "a machine without a cmake file does not
parse" rule in the older notes no longer holds — and this machine builds no
rootfs anyway.

## Install (A/B, boot-is-recovery)

Same model as every fastboot kit: verification-disabled `vbmeta`, LuneOS boot
image, `userdata` image holding `rootfs.img` + `android-rootfs.img`. Two
device-specific points:

- **Flash both slots.** `boot_a`/`boot_b` and `vendor_a`/`vendor_b`, as on
  mindphone — the bootloader can fall back to the inactive slot, and an A/B device
  with one LuneOS slot and one stock slot is a confusing thing to debug.
- **`vendor` needs no fastbootd.** It is a real partition here, not a logical one
  inside `super`, so bootloader fastboot writes it directly — one step fewer than
  the surya kit.
- LineageOS already builds its vbmeta with `--set_hashtree_disabled_flag` and
  `--set_verification_disabled_flag` (`BOARD_AVB_MAKE_VBMETA_IMAGE_ARGS`), so on
  a LineageOS-flashed phone the flags are already off; flashing with
  `fastboot --disable-verity --disable-verification` is still the right habit.
- Flashing `boot` replaces recovery. Keep the stock/LineageOS boot.img.

## The adaptation directory is named `OnePlus6T`, not `fajita`

`luneos-device-config` keys adaptations by **`ro.product.vendor.device`**, because
on a GSI `ro.product.device` is the GSI's (`halium_arm64`) and not the phone's.
Google and Xiaomi put the codename in that property, so every adaptation in the
tree so far is named for its codename and the distinction never surfaced. OnePlus
does not:

```
ro.product.vendor.device=OnePlus6T
ro.product.vendor.model=ONEPLUS A6013
```

read out of the `vendor.img` in `lineage-22.2-20260922-nightly-fajita`. An
`adaptations/fajita/` directory is therefore **never read** — the log says "no
adaptation for 'OnePlus6T'" and the port silently runs on Tier 0 alone, which is
exactly the failure mode that is hardest to notice because the device still
boots. The Yocto MACHINE stays `fajita`; only the adaptation directory (and a
`stubbed-services.d` file, if one is ever added) follows the vendor's name.

The same rule is stated in `stubbed-services-surya`'s bbappend, and the codename
block in `luneos-device-config` spells it out too ("an adaptation directory is
named for what this derives, which is the name the device reports for itself").
It is a per-OEM trap, so check `ro.product.vendor.device` on every new port
rather than assuming the codename.

## Android 15 vendors report a *dated* API level, and it selected the wrong binder protocol

Found on fajita, confirmed on surya, and fixed in `luneos-device-config`.

Android 15 changed the format of `ro.board.api_level` from an SDK number (28..34)
to a **YYYYMM date** — 202404 for Android 15, 202504 for Android 16 — and
deprecated VNDK at the same time, so `ro.vndk.version` is absent on those vendors
and there is no older property to fall back to. Measured:

| vendor | `ro.board.api_level` | `ro.vendor.build.version.sdk` | `ro.vndk.version` |
|---|---|---|---|
| fajita, LineageOS 22.2 | 202404 | 35 | absent |
| surya, /e/OS A15 | 202404 | 35 | absent |

`luneos-device-config` wrote that number straight into gbinder's `ApiLevel`. But
libgbinder picks **the highest preset ≤ ApiLevel** from `{36,35,33,31,30,29,28}`
(`gbinder_config.c`: the table is descending and the loop breaks on the first
`api_level >= preset->api_level`), so *any* date sails past every preset and
always selects the newest one. Preset 35 sets servicemanager `aidl5`; preset 36
sets `aidl6`. The presets differ in exactly that string, so an A15 vendor was
being talked to with Android 16's servicemanager protocol.

The symptom is an AIDL HAL lookup that the container's own servicemanager
resolves happily while libgbinder's does not — the same shape as the sunfish
`registerForNotifications ... tx error -2147483647` incident that motivated
deriving ApiLevel at runtime in the first place. **This is the suspected cause of
surya's open sensorfwd/ISensors issue**, which `stubbed-services-surya` had
already narrowed to "a libgbinder servicemanager API-level problem" and left
open pending a rootfs rebuild.

The fix resolves a dated value to the vendor build's own platform SDK
(`ro.vendor.build.version.sdk`), with a table for the known dates when a vendor
declares no SDK, and warns rather than silently passing an unrecognised future
date through. Checked against eight property combinations: both A15 vendors now
select preset 35, an A16 date selects 36, and sargo (numeric 32 → preset 31) and
an Android 13 vendor such as sunfish's original /e/OS 13 (vndk 33 → preset 33)
are unchanged. sunfish now runs a LineageOS 23.2 vendor (SDK 36), which selects 36.

Worth generalising: **a property whose format changed is more dangerous than one
that went missing.** A missing `ro.vndk.version` falls through to a fallback; a
`202404` where an SDK number is expected is still a valid integer and every
comparison against it silently succeeds.

## Two build breaks, both -Werror against a nine-year-old tree

Neither is device knowledge, but both are what a 4.9 CAF tree costs when the
host toolchain is GCC 15 rather than the 2018 Android clang it was written for.

**`CONFIG_CC_WERROR=y` in `enchilada_defconfig`** makes the top-level Makefile
add a tree-wide `-Werror`, so every diagnostic GCC has gained since then is
fatal. The first two:

| | |
|---|---|
| `arch/arm64/kernel/process.c:196` | `printk("\n%s: %pS:\n", name, addr)` in the OEM-added `show_data()` — `%pS` with an `unsigned long`; type-unsafe, correct at runtime on a 64-bit varargs ABI [`-Werror=format=`] |
| `kernel/extable.c:44` | `__stop___ex_table > __start___ex_table` — comparing two array names, which is what the code means [`-Werror=array-compare`] |

Turned off in `luneos.cfg` rather than patched. Both are style warnings, there is
no reason to think they are the last two, and the alternative is a patch stack
that says nothing about LuneOS and has to be re-audited on every host toolchain
bump. Warnings still print.

**qcacld sets its own `-Werror`** in `drivers/staging/qcacld-3.0/Kbuild`, which
`CONFIG_CC_WERROR=n` does not touch, and GCC 13's `-Wenum-int-mismatch` fires on
`wlan_hdd_send_hang_reason_event` (the header declares `int` where the definition
uses `enum qdf_hang_reason`). One patch drops the unconditional flag, leaving the
`-Werror=<specific>` forms alone. **One hunk, where surya needed 27**: this 4.9
tree keeps audio in `sound/soc/msm` rather than a `techpack/` with its own
Kbuilds, and nothing under `techpack/` here sets `-Werror` at all.

## Status (27 Sep 2026) — builds, boot image verified, pre-hardware

`MACHINE=fajita bitbake linux-oneplus-fajita` succeeds. The produced image was
parsed rather than assumed:

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

(Read back from the kit's `boot-fajita-luneos.img`; `second` and `os_version`
match the shipping LineageOS image and the recipe's `ANDROID_BOOTIMG_*` values.)

- **The `id` field matches AOSP `mkbootimg`'s sha1** over
  (kernel, ramdisk, second, recovery_dtbo) — so `android_bootimg_v2()`'s v1
  header is byte-correct per mkbootimg semantics, not merely plausible.
- **LineageOS's own `id` matches no standard recipe**, ours included: nine
  variants were tried (v1 AOSP, v0-style, padded sections, big-endian lengths,
  whole-image, …) and none reproduce the stored
  `fc5582e53685af99d35826eb9a03ee1d386f8e60`. Their image has an AVB hash footer
  and is padded to the full 64 MB partition. Since that image boots on every 6T,
  **the `id` field is not load-bearing on this bootloader** — the same conclusion
  mindphone reached on MediaTek lk. Do not chase an `id` mismatch here; AVB is
  what verifies a boot image on this platform, and the install disables it.
- **Three appended FDTs inside the kernel section**, at 0xbe113c after a
  12,456,252 B gzip payload, with `model` strings "SDM845 v2.1 SoC", "SDM845 v1
  SoC" and "SDM845 v2 SoC" and totalsizes 415,955 / 411,644 / 416,041 —
  byte-for-byte the sizes of the tree's own `sdm845-v2.1.dtb`, `sdm845.dtb` and
  `sdm845-v2.dtb`. The `dtbo-base` mechanism described above does deliver the
  bases, and `sdm845-v2.1.dtb` — the one every fajita overlay declares — is
  there. This is the check that the header-v1 fix exists for.
- **Kernel/ramdisk window: 3,047,057 B spare** (13,697,391 of 16,744,448), with
  `KALLSYMS_ALL` off. Comfortable, so the window rule is satisfied on this device
  without relying on surya's relocating-ABL observation.

Also verified: the release and debug images are genuinely different kernels
(13,697,391 vs 13,697,509 B), the debug one carrying
`CONFIG_CMDLINE=" loglevel=3 systemd.unified_cgroup_hierarchy=0 SYSTEMD_CGROUP_ENABLE_LEGACY_FORCE=1 enable_adb"`
with `CMDLINE_EXTEND=y`. Both carry the same corrected header.

**Note for anyone changing `ANDROID_BOOTIMG_*`:** those variables reach
`d.getVar()` through a loop variable in the bbclass, so bitbake's dependency
scanner cannot see them and `do_deploy` may not re-run. Both header corrections
here were applied with `bitbake -f -c deploy`, which is what the yocto notes
already tell you to do — and the "tainted from a forced run" warning is the only
confirmation you get.

Flash kit (the device's staging kit):

| | |
|---|---|
| `boot-fajita-luneos.img` / `-debug.img` | 20,357,120 B each |
| `vendor.img` | 1,073,741,824 B, from the paired LineageOS build |
| `vbmeta.img` | LineageOS's own, signed SHA256_RSA2048, flags 0x3 |
| `vbmeta-disabled.img` | generated empty unsigned fallback, for a stock-OOS vbmeta |
| `android-rootfs.img` | 1,058,705,408 B, the shared Halium 16 `halium_arm64` GSI |
| `rootfs.img` | 3,109,787,648 B, the universal `halium-arm64` rootfs |
| `userdata-luneos.img` | 4,587,520,000 B ext4, `rootfs.img` + `android-rootfs.img` at the root (halium `file_layout`, verified with `debugfs`) |
| scripts | `install.sh` (both slots, boot + vendor), `make-userdata.sh`, `make-vbmeta.sh`, `make-debug-boot.sh`, `payload_extract.py` |

**Still pre-hardware.** No 6T has booted this. What is no longer open: the boot
header (verified against the shipping image), the vendor/kernel pairing (one
build manifest), the vendor API level and codename (read out of the vendor's own
build.prop). What is open: the rootfs in this kit predates the `OnePlus6T`
adaptation and the dated-API-level fix, so **rebuild `luneos-image-halium-arm64`
and re-cut `userdata-luneos.img`** before flashing, or Tier 1 and the gbinder
ApiLevel will both be as they were.
