# Device: bluejay (Google Pixel 6a)

Google Pixel 6a (`bluejay`), Google Tensor gs101, GKI Tier A: kernel and initramfs boot on hardware; UI/graphics on Mali-G78 is the open frontier.

First Tensor LuneOS port (nobody — Halium/UT/Droidian/SFOS — has shipped any Tensor port). Our own ACK-built kernel + LuneOS initramfs in `boot`, everything vendor-side stock. Working reference for the "one kernel per KMI" model: the same kernel binary serves panther. Kernel tooling (KMI checks, the original hand build): the `luneos-bootimg-bluejay` repository.

## Platform facts (verified from factory image `bluejay-bp4a.251205.006`, Android 16 QPR2)

| Fact | Value |
|---|---|
| SoC / GPU | Google Tensor (gs101) / Mali-G78 (big-Valhall — unproven under libhybris before this port) |
| Launch layout | **A12-launch: no `init_boot`** — `boot` (67 MB), `vendor_boot` (67 MB), `dtbo`, `vendor_dlkm`, real `super` |
| Stock `boot.img` | header **v4, kernel only, ramdisk size 0** |
| Kernel | `6.1.145-android14-11-gc1de4747ac59-ab14219743`, LZ4 Image, clang 17.0.2 → **KMI `android14-6.1`**; `CONFIG_MODVERSIONS=y`, `MODULE_SIG_FORCE` not set |
| `vendor_boot` | v4, two ramdisk fragments: rd00 PLATFORM (25 MB, full stock `/init` + recovery), rd01 DLKM (5.9 MB, 203 early Tensor modules incl. UFS) |
| Console | `ttySAC0` (vendor cmdline); bootconfig `androidboot.load_modules_parallel=true`, `boot_devices=14700000.ufs` |
| Vendor API | `ro.board.api_level=202504`, **no `ro.vndk.version`** (VNDK gone) → pair with the **Halium 16 GSI** |

Boot-flow property everything relies on: the bootloader concatenates vendor_boot fragments first, then the `boot` ramdisk on top (later cpio entries win). So our repacked `boot.img` = GKI kernel + LuneOS initramfs overrides vendor `/init`, while the DLKM fragment still lands in `lib/modules` of the merged initramfs — we modprobe the vendor's early modules (UFS!) without shipping any.

## Anti-rollback — hard constraint

Bootloader ARB was bumped by Android 13 and **again by the May 2025 update**. A device on Android 16 cannot boot anything older than the May-2025 A15 build; flashing older factory images risks a permanent brick (including the inactive-slot fallback trap — keep both slots consistent). **No downgrade ladder on bluejay**: the port targets 6.1 kernel + Android 16 vendor + Halium 16 GSI, full stop.

## Kernel: source, fragment, KMI results

- Source: `repo init -u https://android.googlesource.com/kernel/manifest -b android-gs-bluejay-6.1-android16` (10 GB). Kleaf/Bazel, entry `build_bluejay.sh`; prebuilt GKI is the default — `--config=use_source_tree_aosp` builds `//aosp` from source (needed for any config change).
- LuneOS fragment: `luneos/luneos_defconfig`, applied via `--//build/kernel/kleaf:defconfig_fragment=//luneos:luneos_defconfig`.
- Stock config (via IKCONFIG → `stock-gki-config-6.1.145-bp4a.txt`): `mer_verify_kernel_config` reports 23 errors / 59 warnings — **gki_defconfig alone is NOT enough**, the delta is small and known (DEVTMPFS+MOUNT, FHANDLE, TMPFS ACL/XATTR, VT, netfilter/PPP/L2TP, etc.).
- **KMI-poison list (from CRC bisect): `FANOTIFY`, `NET_L3_MASTER_DEV`.** These change core struct layouts under MODVERSIONS — with the poisoners on, all 203 stock modules fail (3145 symbol CRCs drift). Everything else in the fragment is KMI-clean (0 drift). The list is a property of this KMI-plus-tree (ACK android14-6.1), not of gs101 and not of GKI in general: q25's MediaTek mgk android12-5.10 tree gives a different one (device-q25.md). `CONFIG_SYSVIPC` is not needed and stays off.

- Userland consequences of the poison list staying off: no fanotify (systemd fine), no VRF (ofono fine). `IPC_NS` is off too, so **LXC must not unshare the IPC namespace** (PID_NS is available).
- ACK pin bumped to tag `android14-6.1-2026-06_r7` (6.1.172) for the vendor-hook tracepoints `vh_mm.ko`/`vh_sched.ko` need → **203/203 factory modules load, 0 CRC drift**. Caveat: `repo sync` reverts the pin — re-checkout the tag and re-apply the modules.bzl trim. Also `CONFIG_UEVENT_HELPER=y` added (mdev hotplug).
- Only the kernel is built, not the full Kleaf dist — manifest-pinned google-modules don't compile against 6.1.172 headers (irrelevant for Tier A; if option B is ever needed, build at the manifest-matched 6.1.124 state).
- Verification tools (host-side, no device): `kmi-crc-check.py` (parses `__versions` from stock .kos vs our `Module.symvers`), `symvers-drift.py`, `tools/module-order.py`.

## Boot images & Yocto

- The first images were hand-built by `build-bootimg.sh` (`boot-bluejay-luneos.img`, 23.5 MB, header v4, + `-debug.img` with `enable_adb`); the patched `init` they carried (module fixpoint→v4 loader, cmdline params, PARTNAME poll) is now upstream in `initramfs-scripts-halium/init.sh`.
- Since 4 Sep 2026 the images come out of bitbake: `MACHINE=bluejay bitbake initramfs-android-image` then `luneos-bootimg-gki` → `tmp/deploy/images/bluejay/`. Machinery: `meta-android/lib/halium/bootimg.py` (v3/v4 writer, byte-identical to AOSP mkbootimg for all four shipped shapes), `gki_bootimg.bbclass`, `meta-google/conf/machine/bluejay.conf`, `meta-luneos/…/nyx-modules/bluejay.cmake`. `ANDROID_BOOTIMG_INIT_BOOT = "0"` → single boot image.
- **The GKI kernel is built in-tree** by `meta-android/recipes-kernel/linux-halium-gki/linux-halium-gki_6.1.bb` (ACK `android14-6.1-2026-06_r7`, plain kbuild, Google's prebuilt clang 17 r487747c — never the OE toolchain, which would move MODVERSIONS CRCs and break the stock vendor modules). `luneos-bootimg-gki` (meta-android/recipes-bsp/gki-bootimg/) consumes it via `GKI_KERNEL_PROVIDER ?= "linux-halium-gki"`; setting `GKI_KERNEL_IMAGE` overrides it with an out-of-tree Image. `bluejay.conf` sets `PREFERRED_VERSION_linux-halium-gki = "6.1%"`; `PREFERRED_PROVIDER_virtual/kernel = "linux-dummy"` only means the rootfs carries no kernel.

## libhybris-on-Tensor feasibility (verdict: feasible)

De-risked by direct vendor.img inspection: composer is **HIDL @2.4::IComposer** (Google never IDL-migrated gs101 graphics; legacy `hwcomposer.gs101.so` + `gralloc.default.so` shims also present) — interface-identical to the working sargo setup. Gralloc: AIDL allocator v2 + `mapper.pixel.so`; the 16 GSI's libui speaks gralloc5 and libhybris delegates to it. EGL: monolithic `/vendor/lib64/egl/libGLES_mali.so` — the sargo default-LD-path fix applies. Audio HIDL 7.1, IRadio HIDL 1.6 dual-slot, GNSS HIDL 2.1, camera HIDL 2.7 — all covered by the existing stack. **One genuine unknown: Mali-G78 blobs under the hybris linker** (production precedent only up to Valhall G57/G68). Carry the Mali patch set from day one: PR #543/#575 (TLS-register leak), #601, #594 + qt5-qpa #104, FuriLabs 4a42d42. Known gaps, not boot-blocking: BT HAL is AIDL-only (bluebinder is HIDL), sensors AIDL v3 multihal; the `/dev/ashmem<boot_id>` host fix applies here too.

## Flash kit

The device's staging kit — pure-fastboot install (athena/panther parity): `install.sh` flashes vbmeta (verification off) → boot → `userdata-luneos.img` (3,774,873,600 B ext4 with `rootfs.img` + `android-rootfs.img` = Halium 16 GSI side by side; grows on first boot) → reboot. `make-userdata.sh` rebuilds after a rootfs rebuild. Distributable: `luneos_bluejay_20260904.tar.gz`. Only difference from panther: one boot image instead of two (no init_boot).

## Update (12 Sep 2026): deploy set rebuilt, MODULE_SIG_PROTECT defect found and fixed

- Staging kit regenerated: boot images (GKI 6.1.172 from ACK `android14-6.1-2026-06_r7`), halium-arm64 dev `rootfs.img` (ext4, wrynose 20260912), Halium 16 GSI `20260910-1` as `android-rootfs.img`, stock bp4a vbmeta, `install.sh`, README, SHA256SUMS.
- **The earlier kit had a real defect: `CONFIG_MODULE_SIG_PROTECT` was on.** A GKI kernel refuses (`-EACCES`) to let a module it did not sign resolve protected symbols; since we rebuild GKI, our key is not Google's, so the phone's own stock vendor modules count as unsigned → **Wi-Fi/BT modules never loaded — invisibly to a CRC-only check**. Fixed with one config line (`# CONFIG_MODULE_SIG_PROTECT is not set`, `MODULE_SIG`/`MODULE_SIG_ALL` stay `=y`; `internal.h` stubs both helpers when off — no source patch needed, unlike achunt2143's bootimg PR that surfaced it). **Verified, not assumed**: 203/203 factory modules load, 0 CRC mismatches, option confirmed off via IKCONFIG readback, poison list still off, UEVENT_HELPER + DEVTMPFS on. See kernel-porting.md Step 4b.
- `CONFIG_BT_HCIVHCI=m` added to the fragment (+ `hci_vhci` in the Kleaf GKI module lists in `build-bootimg.sh`) for bluebinder's `/dev/vhci`.
- `build-bootimg.sh` was broken until this rebuild: the module-loader overlay patch is now upstream in `initramfs-scripts-halium/init.sh`, so `patch` hit "previously applied" and died under `set -e`. Now applied via `apply_if_needed()`, which treats already-applied as success.
- meta-webos-ports cherry-picks applied (uncommitted): 3 PulseAudio null-guard patches + SRC_URI lines, and the `AUDIO_FORMAT_PCM_FLOAT` rewrite in droid-audio-config-gen — verified present in the packaged output of both halium_arm64 and bluejay builds. Everything else from PR817 dropped.
- Machine confs now say which KMI they want out loud — `bluejay.conf`/`panther.conf` declare `GKI_BOOTIMG = "1"` + `PREFERRED_VERSION_linux-halium-gki = "6.1%"` — so the KMI is explicit (q25 builds its own kernel, `linux-zinwa-q25`).

## Status

Kernel + initramfs boot verified on hardware (two panics diagnosed and fixed: module order → MCT panic; FMP module params). Boot images, KMI verification (CRC **and** signature-protection), flash kit, Yocto machine: done. UI/graphics bring-up on Mali-G78: the open frontier.
