# Device: bluejay (Google Pixel 6a, Google Tensor gs101)

Google Pixel 6a (`bluejay`), Tensor gs101, GKI Tier A on an Android 16 vendor: our kernel and initramfs boot on hardware; UI on Mali-G78 is open.

The first Tensor port in the Halium family (no Halium, UT, Droidian or SFOS port of any Tensor device has shipped). Our own ACK-built kernel and the LuneOS initramfs go in `boot`; everything vendor-side stays stock. It is the working reference for one kernel per KMI: the same kernel binary serves panther (device-panther.md). Boot-image tooling and the original hand build: github.com/Herrie82/luneos-bootimg-bluejay.

## Status (as of 30 Sep 2026)

| Area | State | Notes |
|---|---|---|
| Kernel boot | works (hardware) | two panics diagnosed and fixed: module order (MCT clock panic) and FMP module params (boot-images.md § Init patch history) |
| Initramfs, rootfs mount | works (hardware) | |
| Vendor modules | 203/203 load-compatible (host-side) | CRC check and `MODULE_SIG_PROTECT` off; on-device confirmation pending |
| Display / UI | open | HIDL composer path is the proven one; Mali-G78 under libhybris is unproven |
| Wi-Fi, BT | untested since the `MODULE_SIG_PROTECT` fix | the earlier kit never loaded the Wi-Fi/BT modules; BT HAL is AIDL-only |
| Modem, audio, GNSS, camera | untested | HAL surfaces are ones the stack covers (below) |
| Sensors | untested | AIDL multihal v3 |

## Platform facts

Read from factory image `bluejay-bp4a.251205.006` (Android 16 QPR2).

| Fact | Value |
|---|---|
| SoC / GPU | Google Tensor gs101 / Mali-G78 (big-Valhall) |
| Launch layout | A12-launch: no `init_boot`; `boot` (67 MB partition), `vendor_boot` (67 MB), `dtbo`, `vendor_dlkm`, real `super` |
| Stock kernel | `6.1.145-android14-11-gc1de4747ac59-ab14219743`, LZ4 Image, clang 17.0.2 → KMI `android14-6.1`; `CONFIG_MODVERSIONS=y`, `MODULE_SIG_FORCE` not set |
| Console | `ttySAC0` (vendor cmdline); no serial console reachable on the phone |
| Vendor API | `ro.board.api_level=202504`, no `ro.vndk.version` |
| Userdata | ~110 GB partition |

## Kernel

Tier A, built per KMI (kernel-porting.md § Tier A). The shipped kernel is ACK tag
`android14-6.1-2026-06_r7` (6.1.172) + `luneos_defconfig`.

- **Yocto**: `meta-android/recipes-kernel/linux-halium-gki/linux-halium-gki_6.1.bb`,
  plain kbuild with Google's prebuilt clang 17 r487747c (kernel-porting.md § Step 4).
  `bluejay.conf` sets `GKI_BOOTIMG = "1"` and `PREFERRED_VERSION_linux-halium-gki = "6.1%"`.
- **Kleaf**: `repo init -u https://android.googlesource.com/kernel/manifest -b
  android-gs-bluejay-6.1-android16` = `kernel/common` @ android14-6.1 (path `aosp/`) +
  ~50 `private/google-modules/*` repos + Kleaf tooling, about 10 GB. Stock validation build
  `./build_bluejay.sh --config=use_source_tree_aosp` (~7 min on 64 cores; dist has boot.img,
  dtbo, vendor_dlkm.img, all modules). The kernel-only target is the one in
  kernel-porting.md § Step 4; a kernel-only rebuild takes ~5 min, which is what the poison
  bisect ran on. The same tree carries `private/devices/google/{gs201,pantah}` and
  `build_pantah.sh`.

Config delta: stock config (from IKCONFIG) gives 23 errors / 59 warnings from
`mer_verify_kernel_config`; the fragment carries the standard delta (kernel-porting.md §
The config delta) plus:

- **Poison list `FANOTIFY`, `NET_L3_MASTER_DEV`** — with them on, 3145 exported CRCs drift
  and all 203 stock modules fail; with them off, 0 drift (kmi-crc-matching.md § Poison
  options). Consequences: no fanotify, no VRF, LXC keeps the IPC namespace.
- `# CONFIG_MODULE_SIG_PROTECT is not set` (`MODULE_SIG`/`MODULE_SIG_ALL` stay `=y`). With
  it on, the phone's own vendor modules count as unsigned and Wi-Fi/BT never load although
  every CRC matches; found here (kmi-crc-matching.md § A failure class invisible to CRC
  checks: MODULE_SIG_PROTECT). Confirmed off by reading the built kernel's IKCONFIG back.
- `CONFIG_UEVENT_HELPER=y` (mdev hotplug), `CONFIG_BT_HCIVHCI=m` (bluebinder's `/dev/vhci`;
  the Kleaf route adds `hci_vhci` to the GKI module lists in `build-bootimg.sh`).

KMI results:

| Build | Result |
|---|---|
| Stock config, from source, manifest pin (6.1.124, `a4662a84a`) | 201/203 factory `vendor_boot` DLKM modules load-compatible, 0 CRC mismatches |
| The two failures | `vh_mm.ko`, `vh_sched.ko`: import vendor-hook tracepoints (`android_rvh_setscheduler_prio`, `android_trigger_vendor_lmk_kill`, `android_vh_calculate_totalreserve_pages`) missing at the pin |
| Bumped to `android14-6.1-2026-06_r7` (6.1.172) | **203/203, 0 CRC drift, +454 new exports** (add-only KMI growth) |

The factory modules (ab14305268) were built against a newer android14-6.1 tag than the
manifest pin, and the factory kernel is yet another build (ab14219743); the rule is
kernel-porting.md § Vendor-hook modules and the ACK tag. Pin bump:
`git fetch --depth=1 <remote> android14-6.1-2026-06_r7 && git checkout FETCH_HEAD` in `aosp/`.

Kleaf traps on the bumped pin:

- A later `repo sync` reverts `aosp/` to the manifest pin; re-checkout the tag and re-apply
  the `modules.bzl` ppp/l2tp trim (the checkout reverts `aosp/modules.bzl`; the
  `common/modules.bzl` edit persists).
- The full dist fails on the bumped pin: the manifest-pinned google-modules do not compile
  against 6.1.172 headers (`DWC3_LLUCTL` redefined, -Werror, in soc/gs dwc3; a VLA in
  s3c2410_wdt). Use the kernel-only output, not `out/bluejay/dist/`.
- Option B (own vendor modules, kernel-porting.md § Option B) would be built at the
  manifest-matched 6.1.124 state, where the full dist succeeds.

`modules.load` is not dependency-ordered: 335 hard-dependency pairs listed backwards across
99 modules, plus ~15 `softdep pre:` edges; the initramfs loader resolves the order up front
(boot-images.md § Init patch history).

## Boot image

Layout class: boot-images.md § Class 2 — A12-launch GKI.

| Image | Content (stock) |
|---|---|
| `boot.img` | header v4, kernel only, ramdisk size 0 |
| `vendor_boot.img` | v4; `vendor_ramdisk00` PLATFORM (25 MB: first-stage `/init`, sepolicy, recovery, `first_stage_ramdisk/`), `vendor_ramdisk01` DLKM (5.9 MB: 203 early modules incl. aoc, exynos, UFS under `lib/modules`); dtb (536 KB) |

Vendor cmdline (from vendor_boot): `console=ttySAC0,115200`, `printk.devkmsg=on`,
bootconfig `androidboot.load_modules_parallel=true`, `androidboot.boot_devices=14700000.ufs`,
and module options such as `ufs_pixel_fips140.fips_first_lba=…` and
`exynos_drm.panel_name=samsung-s6e3fc3_6a` that the init passes to the modules it loads.

Shipped: `boot-bluejay-luneos.img` (~23.5 MB, header v4) = our 6.1.172 kernel + the LuneOS
initramfs as the boot ramdisk, packed with **no kernel command line**. The Pixel bootloader
drops boot-image arguments it does not recognise, so anything LuneOS needs belongs in
`CONFIG_CMDLINE` (kernel-porting.md § The kernel command line). The initramfs mirrors
`/dev/trusty-log0` into kmsg so a Trusty panic reason survives into pstore.

## Vendor and GSI

Vendor HAL surface, read from the factory `vendor.img` (rule: hal-userspace.md § HIDL vs AIDL):

- **Composer: HIDL `@2.4::IComposer`** — gs101's graphics HALs were never IDL-migrated;
  the passthrough `hwcomposer.gs101.so` and `gralloc.default.so` shims still ship in
  `/vendor/lib64/hw`. The display path is interface-identical to sargo's.
- Gralloc: AIDL allocator v2 + `mapper.pixel.so` (stable-C mapper5); the 16 GSI's libui speaks
  gralloc5 and libhybris delegates to it.
- EGL: monolithic `/vendor/lib64/egl/libGLES_mali.so` (+ `vulkan.mali.so`).
- Audio HIDL 7.1, IRadio HIDL 1.6 dual-slot, GNSS HIDL 2.1 (brcm), camera provider HIDL 2.7 +
  media.c2 AIDL + OMX 1.0 — all served by the existing stack.
- **Bluetooth: AIDL-only `IBluetoothHci`**; bluebinder is HIDL. **Sensors: AIDL multihal v3.**
  Neither is boot-blocking.

No VNDK (A15+ vendor) → Halium 16 GSI (`halium_arm64`); gbinder ApiLevel comes from the
vendor at boot (hal-userspace.md § Binder and gbinder). The open unknown is the Mali-G78 blob
under the hybris linker; carry the Mali patch set from day one (hal-userspace.md § Mali under
libhybris). The A12+ ashmem fix applies (debugging.md § 2.4).

## Yocto

Layer `meta-google`, `MACHINE=bluejay` (`meta-google/conf/machine/bluejay.conf`); the pattern is device-bringup-yocto.md § GKI device
machines.

```
MACHINE=bluejay bitbake luneos-bootimg-gki     # kernel, boot image, debug image
```

`ANDROID_BOOTIMG_INIT_BOOT = "0"` → one combined `boot.img`. The rootfs is the generic
`halium-arm64` one. The first images were hand-built by `build-bootimg.sh` (tools.md §
build-bootimg.sh); its init patches are upstream in `initramfs-scripts-halium`, and it now
applies them through `apply_if_needed()`, which treats "previously applied" as success.

## Install

Pure fastboot (installing.md § Flash steps per layout class): `install.sh` flashes vbmeta
(verification off) → `boot` → `userdata-luneos.img` (3,774,873,600 B ext4 holding
`rootfs.img` + `android-rootfs.img`, grows on first boot) → reboot. The kit is the same as
panther's except for the single boot image. `fastboot boot boot-bluejay-luneos-debug.img`
gives the initramfs shell without flashing. The older route — `fastboot format:ext4
userdata`, boot the debug image, `adb push` the two images — still works and skips the
resize path.

**Anti-rollback:** bootloader ARB was bumped by Android 13 and again by the May 2025 update.
A device on Android 16 cannot boot anything older than the May 2025 A15 build, and flashing
older factory images risks a permanent brick (including via the inactive-slot fallback; keep
both slots consistent). There is no downgrade ladder: the port targets the current kernel,
vendor and GSI (installing.md § Anti-rollback).

Revert: stock `boot.img` and `vbmeta.img` (no flags) from the bp4a factory zip, then
`fastboot -w`.

## Open issues

- Display on Mali-G78 under libhybris: no production precedent above Valhall G57/G68.
- Whether the `MODULE_SIG_PROTECT` fix brings up Wi-Fi/BT on the device: the CRC check
  proves it broke nothing; only a boot proves it fixed anything.
- Bluetooth needs an AIDL path in bluebinder; sensors need sensorfwd's AIDL backend.
- Plan B for graphics: postmarketOS boots bluejay with panel and touch on a near-mainline
  6.18 kernel via simpledrm (gs101-mainline); Mesa panfrost has no G78 model entry yet.

## Sources

- https://android.googlesource.com/kernel/manifest (branch `android-gs-bluejay-6.1-android16`)
- https://developers.google.com/android/images (factory image `bluejay-bp4a.251205.006`)
- https://github.com/Herrie82/luneos-bootimg-bluejay
