# LuneOS GSI + GKI Architecture

LuneOS's target architecture: one universal arm64 rootfs plus a generic Halium GSI on any unlockable Treble/GKI device, with per-device cost cut to a boot image and config.

This document describes the target architecture, the storage/install model, the Tier A/Tier B kernel split and the adaptation tier model; it was first proven on the Pixel 3a (`sargo`). Historically, a LuneOS port = one Yocto `MACHINE` + one forked Android device tree + one full Halium Android build + one kernel fork — everything rebuilt per device (`TUNE_PKGARCH:append = "-halium"` taints every package with the machine arch). That is why LuneOS never scaled past Android 9.

## Why Treble makes this possible

The trick is not really "GSI" in the Android sense — it is **Project Treble**:

> Since Android 8/9 the HALs live in the device's **`/vendor`** partition, which is already on the phone and which we never have to build. What we mount as `/android` only needs to be a *generic* Android userspace (init, servicemanager/hwservicemanager, logd, VNDK libs) matched to the device's **vendor API level** — not to the device.

- `/vendor` (device's own, untouched) provides the HALs and firmware.
- `/android` (our generic Halium GSI) provides Android init + `hwservicemanager`/`servicemanager` + the VNDK/`libbinder`/`libhidl` set the vendor HALs link against.
- Compatibility is negotiated at runtime through **VINTF** (`compatibility_matrix.xml` / `manifest.xml`). The binding constraint is the **vendor API level**, *not* the Android version the device currently runs. Read it from `ro.vndk.version`, or from `ro.vendor.build.version.sdk` on A15+ vendors, which have no `ro.vndk.version` and whose `ro.board.api_level` is a YYYYMM date (202404, 202504) rather than an SDK number (see device-fajita.md). Never read `ro.build.version.release` for this.
- **An A15+ vendor needs no VNDK snapshot.** Android 15 deprecated VNDK: the former VNDK libs ship in `/vendor` itself, `ro.vndk.version` is absent, and the GSI only has to provide the framework side. Older vendors need the GSI to carry the snapshot matching their `ro.vndk.version` (linkerconfig looks it up by exact version); the snapshot matrix is in gsi-building.md.
- In practice the **16.0 GSI is the production target**: every GSI machine in meta-smartphone pins `android-headers-halium` 16.0 (sargo also boots 14.0). Its arm64 build carries the VNDK 27–34 snapshots, so one image serves vendors from Android 8.1 to 14 as well as A15+ vendors. Limitation: libhybris past Android 13 is community-patched (see Key risks).
- Vendor floor: the Halium 9 GSI requires an **Android 9 vendor** as its base — Android 8.0/8.1 vendors are "experimental" only (UBports porting-notes, https://github.com/ubports/porting-notes/wiki/Generic-system-image-(GSI)).

## The artifact table

| Artifact | Count | Device-specific? |
|---|---|---|
| LuneOS rootfs (`rootfs.img`) | **1** for all arm64 devices | no |
| Halium GSI (`system.img` → `/android`) | **1 in use**: 16.0 (`halium_arm64`, plus `halium_arm` for 32-bit userlands). 9.0/11.0/13.0/14.0 are built and published but no current port uses them | no — the GSI carries a VNDK snapshot per vendor API level |
| Boot image (kernel + LuneOS initramfs) | **~4 GKI KMIs** + one per legacy device | GKI: no. Legacy: yes |
| Device adaptation (udev, audio, modem, quirks) | ~15 tiny files per device | yes, but *data*, not a build |

Nothing is flashed to `system`/`vendor`. `rootfs.img` and `system.img` live as files inside `userdata`, so stock Android survives and installation is `fastboot flash boot` + push two files.

## Target architecture

```
                    ┌────────────────────────────────────────────┐
                    │  built ONCE, arm64, device-agnostic        │
                    │  MACHINE = halium-arm64                    │
   Yocto ───────────┤   • luneos-image  → rootfs.img             │
                    │   • luneos-initramfs (cpio)                │
                    │   • all adaptations bundled as data        │
                    └────────────────────────────────────────────┘
                                     +
                    ┌────────────────────────────────────────────┐
                    │  built per generation, from halium/android │
   AOSP/repo ───────┤   halium_arm64 product, branches           │
                    │   halium-9.0/-11.0/-13.0/-14.0/-16.0       │
                    │   → system-gsi-<vndk>.img                  │
                    └────────────────────────────────────────────┘
                                     +
   ┌──────────────────────────────┐     ┌──────────────────────────────┐
   │ Tier A — GKI (A12+/5.10+)    │     │ Tier B — pre-GKI vendor BSP  │
   │ build ACK once per KMI       │     │ build vendor kernel per dev  │
   │ + repack boot/init_boot      │     │ driven by deviceinfo         │
   │ using per-device offsets     │     │ (reuse UBports HGABT)        │
   └──────────────────────────────┘     └──────────────────────────────┘
                                     +
                    ┌────────────────────────────────────────────┐
                    │ luneos-device-adaptations (plain git repo) │
                    │  devices/sargo/{deviceinfo, sparse/...}    │
                    │  ~12 files. No bitbake involvement.        │
                    └────────────────────────────────────────────┘
                                     ↓
                    ┌────────────────────────────────────────────┐
                    │ luneos-installer: detect device → pick GSI │
                    │ by vendor API level → flash boot/init_boot │
                    │ + vbmeta → push rootfs.img & system.img    │
                    └────────────────────────────────────────────┘
```

## On-device layout

```
/dev/block/by-name/userdata   (unencrypted ext4)
  ├── rootfs.img              ← universal LuneOS
  ├── system.img              ← Halium GSI for this vendor API level
  └── luneos-data/            ← /home, /var overlay (already implemented)

/                             ← rootfs.img
/android                      ← system.img (loop) + device's real /vendor bind-mounted in
/var/lib/lxc/android/rootfs   ← LXC container root
```

Storage/install model consequences:

- Do **not** flash the GSI to `system`. Keep `rootfs.img` + `system.img` as files in `userdata`. Halium's initrd already supports this (`systempart=`, `rootfs.img`, `system.img`, `halium-rootfs/`, writable-image dev mode, A/B `androidboot.slot_suffix` handling).
- Stock Android stays installed, no `super` resizing, no `fastbootd` dance, reversible by wiping the files.
- `userdata` must be formatted **unencrypted** (FBE is on by default from Android 10).
- `vbmeta` must be flashed verification-disabled (flags 2 vs 3: see installing.md).

**Future work — encrypted userdata without giving up this model:** Ubuntu Touch 24.04 runs
a working FBE setup on the same storage layout — root stays unencrypted, `fscrypt` encrypts
the data filesystem (AES_256_XTS contents / AES_256_CTS filenames), and PIN entry is
deferred to the UI. fscrypt policy v2 is native on kernels ≥5.4; for 4.14/4.19 they
backport fs/crypto + ext4/f2fs support from the Android Common Kernel. Setup is `fscrypt
setup` plus a per-device opt-in flag. (UBports docs,
https://docs.ubports.com/en/latest/porting/configure_test_fix/Fscrypt.html)

## Tier A vs Tier B kernels

**Tier A — GKI (Android 12+, kernel ≥5.10).** Android 12+ with kernel ≥5.10 must ship GKI: the core kernel is generic; SoC/board drivers are loadable modules in `vendor_boot` (early/recovery) and `vendor_dlkm` (the rest). The KMI is binary-stable within an LTS (`android12-5.10`, `android13-5.15`, `android14-6.1`, `android15-6.6`) — exactly what lets us ship **one Halium-configured kernel per KMI instead of one per device**. The stock GKI config is not enough (Droidian's guide says so; verified on bluejay: 23 errors / 59 warnings from `mer_verify_kernel_config`), so rebuild from ACK with a config fragment — but that rebuild is per KMI, not per device; the stock `vendor_dlkm` modules still load as long as the rebuilt kernel keeps the KMI's symbol CRCs. That is the single biggest lever in the whole plan. **A GKI-labelled device is not necessarily ACK-compatible:** the Zinwa Q25 (MT6789) ships MediaTek's *mgk* GKI derivative, and an ACK build failed all 344 of its stock vendor modules while a build from the device's own kernel tree loads all of them (see device-q25.md). Such a device is still Tier A, but the kernel comes from the vendor's GKI tree, not ACK.

Because the stock GKI config is not sufficient, an A13+-launch device gets both a rebuilt
kernel in `boot` and the LuneOS initramfs in `init_boot`; header versions and layouts per
launch generation are in boot-images.md.

**Tier B — pre-GKI, vendor BSP kernel.** Defined by the kernel, not by the Android version: a device whose kernel is the vendor's own BSP tree is Tier B whatever its vendor runs (mindphone: Android 11 vendor; sargo: 12.1; sunfish; fajita, athena and surya: Android 15 vendors). Build the vendor kernel per device, driven by a `deviceinfo` file (UBports/postmarketOS format) so adding a legacy device does not mean writing bitbake. Example: sargo is pre-GKI (kernel 4.9) and keeps a device kernel, but moved from its Halium 9 device build to the 14.0 and 16.0 GSIs simply by flashing stock Android 12.1 first so `/vendor` is VNDK 32 — zero Android-side device build.

## Dynamic partitions and the container mount

From Android 10, `system`/`vendor`/`product` are logical partitions inside `super` (or,
on devices retrofitted from an older launch, spread over `system` and `vendor` with no
`super` partition at all). LuneOS maps them from systemd, not the initramfs — see
device-bringup-yocto.md § mount-android.sh and the LXC container.

## The adaptation tier model — derive first, declare second, ship files last

**Governing principle (established empirically on sargo): anything the device's own `/vendor` already knows should be *discovered at runtime*, not shipped per device.** Every per-device file is a device not yet ported; every derivation is a device class already ported. Four sargo problems were solved this way:

| Problem | Naive fix | What we do instead |
|---|---|---|
| 33 vendor HALs never start | per-device service list | parse `service`/`class` out of the container's own rc files |
| init blocked forever | hardcode `vendor.qcom.time.set` | parse every `wait_for_prop` gate from the rc files, grace-period, force stragglers |
| 50 EACCES on vendor sysfs | per-device chown list | replay `chown`/`chmod` from the triggers init never reached |
| compositor races the HAL | per-device sleep | wait for `IComposer` to actually register on hwbinder |

**Tier 0 — derived at runtime (target: everything).** `luneos-device-config` derives: HAL services, init gates, node permissions (from `/android/{vendor,odm,system}/etc/init/**.rc`); display density from `ro.sf.lcd_density`, geometry from hwcomposer/DRM; partitions by name plus `parse-android-dynparts`; vendor API level from `ro.vndk.version`, or `ro.vendor.build.version.sdk` where `ro.board.api_level` is a YYYYMM date (A15+ vendors); RIL topology by enumerating `android.hardware.radio@1.x::IRadio/slotN` from hwservicemanager and generating `binder.conf`.

**Tier 1 — `deviceinfo` (declarative, small, UBports-compatible).** Only what genuinely cannot be read off the device — needed *before* it is running, or describes how to build for it: `deviceinfo_codename`, `deviceinfo_bootimg_header_version`, `deviceinfo_flash_offset_*`, `deviceinfo_kernel_clang_compile`, `deviceinfo_dtbo`, `deviceinfo_bootimg_tailtype`, plus a `quirks` list. Names kept verbatim from UBports/postmarketOS so their device configs can be consumed directly.

**Tier 2 — `sparse/` overlay (last resort).** A real file tree overlaid on `/etc` and `/usr/lib/luneos/device/`. Adding a file here requires stating why it cannot be derived. Tier 2 should shrink release over release.

**Placeholders, not defaults.** Shipped config files are placeholders: device-describing values in them must be obviously invalid (zeros, empty lists, `/dev/input/PLACEHOLDER`). A plausible constant is worse than a broken one — it is right often enough that the devices where it is wrong never announce themselves (`luna-platform.conf` shipped `DPI=445` and it became the effective DPI of every device without an adaptation; `nyx.conf` shipped sargo's key nodes; `surface-manager.env` shipped sargo's touchscreen node). Two rules: never read a value back out of the file you generate; put genuine fallbacks in the generator, not the config. Values that are not derived at all stay as working values, marked as such.

**Applying an adaptation: bind-mounts now, overlayfs when available.** Copying files in would destroy universality — the mechanism must be non-destructive and re-evaluated every boot. Do NOT use oe-core's `overlayfs-etc.bbclass` (needs a hardcoded per-machine device node, replaces `/sbin/init`, solves a read-only-rootfs problem we don't have). Raw overlayfs (`lowerdir=<adaptation>/etc:/etc`, Droidian's model) is the right shape but e.g. sargo's 4.9 kernel lacks `CONFIG_OVERLAY_FS`. So: prefer overlayfs when `/proc/filesystems` advertises it, fall back to per-file bind-mounts.

**Prior art — UBports' overlay store** is this exact design productized (UBports docs,
https://docs.ubports.com/en/latest/porting/configure_test_fix/Overlay.html). Enabled with
`deviceinfo_use_overlaystore="true"`, semantics selected per directory by marker files
inside the overlay tree:

- `.halium-override-dir` in a directory → the overlay directory **replaces** the destination directory entirely
- `.halium-overlay-dir` → the directory is **merged** over the destination via overlayfs (underlying files stay visible unless shadowed)
- no marker → each file is individually **bind-mounted** over its destination

The per-directory replace/merge distinction and the marker-file idea are worth adopting.

**Shadowing files of the mounted stock vendor/system:** Droidian keeps two standing overlay
roots — `/usr/lib/droid-vendor-overlay/` and `/usr/lib/droid-system-overlay/`, each
mirroring the partition's directory structure — whose contents shadow individual files of
the mounted stock partitions without modifying them (used in practice to ship a patched
`vndservicemanager` binary and tweaked vendor rc files). LuneOS currently has **no**
mechanism to non-destructively shadow a *vendor* file; this is the known solution shape
when one is needed. (Droidian, https://docs.droidian.org/porting-guide/debugging-tips/)

**Unknown devices must still boot:** if no `deviceinfo` matches, Tier 0 alone must produce a usable UI — default density from `ro.sf.lcd_density`, geometry from the compositor. That is the difference between "supports 30 devices" and "runs on pretty much every Android device".

## Devices

Per-device state lives in the `device-<codename>.md` files.

## The Halium container handshake

Android's init is patched (51 patches under `system/core` alone) so the framework never
starts. On a generic GSI, `on nonencrypted` is dead (no fstab → `mount_all` never runs)
and `droid.late_start` is commented out in halium-9.0, so the distro has to complete the
handshake itself: `start-android-hals.sh` opens the vendor's `wait_for_prop` gates and
replays `class_start`/`chown`. Init that "stops after post-fs-data" is usually *stuck* on
such a gate, not curtailed by design — see debugging.md § Stage 2.

## How the others did it

**Droidian — the closest model.** One Debian arm64 rootfs for all devices; prebuilt GSI as a package (`android-system-gsi-{28,29,30,33}-bin`); per-device work = kernel package (`kernel-info.mk`) + adaptation package. `droidian-devices/adaptation-google-sargo` is **~12 files total** (udev rules, phoc.ini, a BT-address script, camera conf, feature flags, a gschema override) — that is the entire device-specific surface, and the target to aim at. Extra pieces for modern Android: `parse-android-dynparts`, `droidian-apex-manager`, `lxc-android`. Droidian also ships `android_boot_completed.service` (`setprop sys.boot_completed 1`) and runs the container as `Type=notify` with `Delegate=yes`.

**UBports.** `halium-generic-adaptation-build-tools` (HGABT): a standalone kernel/boot builder driven by a `deviceinfo` file (postmarketOS format) — `build.sh`, `build-kernel.sh`, `make-bootimage.sh`, `make-dtboimage.sh`, plus `system-image-from-ota.sh` for pulling vendor bits from an OEM OTA. Their porting wiki: a GSI needs a device "released with Android 8 or later"; works with A/B, A-only and system-as-root alike; **"the sole hard requirement is a Halium-patched kernel."**

**Halium upstream.** `github.com/halium/android` branches: `halium-9.0` through `-16.0`. Generic GSI target: `halium/android_device_halium_halium_arm64` (product `halium_arm64` → `system.img`). `hybris-patches`, `libhybris`, `droidmedia`, `initramfs-tools-halium` all active mid-2026. Halium is alive and already generic.

**Sailfish OS.** Per-device HADK builds, but its userspace libraries (`libgbinder`, `pulseaudio-modules-droid`, `ofono-binder-plugin`, `droidmedia`, `gst-droid`, `geoclue-providers-hybris`) are the ones that track new Android releases — the stack LuneOS has largely migrated to (present in `meta-luneos`: libgbinder, ofono-binder-plugin, pulseaudio-modules-droid + -hidl, bluebinder, sensorfw, qt6-qpa-hwcomposer-plugin, nyx-modules-hybris, libsuspend, mtp-server, waydroid recipes; still to add: droidmedia + gst-droid, geoclue-providers-hybris, parse-android-dynparts packaging, mechanicd evaluation).

## Glossary

| Term | Meaning |
|---|---|
| Treble | Android 8+ split: HALs and firmware in `/vendor`, framework in `/system`, so a generic system image (GSI) can run over any vendor |
| GSI | generic system image; for LuneOS a Halium build of `halium_arm64`/`halium_arm` mounted as `/android` |
| VINTF | vendor interface manifests and compatibility matrices that the framework and vendor are checked against at runtime |
| VNDK | the versioned framework libraries vendor HALs link against (API 27–34); deprecated in Android 15, so A15+ vendors carry them in `/vendor` |
| GKI | Generic Kernel Image: Android 12+ devices with kernel ≥5.10 ship a generic core kernel plus vendor modules |
| ACK | Android Common Kernel, the source GKI builds come from (`android14-6.1` etc.) |
| KMI | Kernel Module Interface: the exported symbols and their CRCs that vendor modules are built against; stable within one ACK branch |
| mgk | MediaTek's GKI derivative kernel; GKI-labelled but not ACK-compatible (device-q25.md) |
| vermagic | the version string in every `.ko` that must match the running kernel before CRCs are even compared (kmi-crc-matching.md) |
| poison option | a kernel config option that changes the KMI (moves `module_layout` or struct layouts), so enabling it makes stock vendor modules refuse to load; the list is per KMI (kmi-crc-matching.md) |
| `vendor_boot` | GKI partition with the vendor ramdisk (first-stage init, early modules), dtb and vendor cmdline |
| `init_boot` | A13+-launch partition holding the generic ramdisk; `boot` then holds only the kernel |
| `vendor_dlkm` | logical partition with the rest of the vendor kernel modules |
| aboot / ABL / lk / lk2nd | bootloaders: Qualcomm's older LK-based `aboot` (honours header offsets); Qualcomm's UEFI-based ABL (header v2+, relocates images); MediaTek and older LK `lk`; `lk2nd`, a secondary LK chain-loaded from the boot partition on old Qualcomm devices |
| Tier A / Tier B | kernel tiers: A = GKI, kernel built per KMI; B = pre-GKI vendor BSP kernel built per device |
| Tier 0 / 1 / 2 | adaptation tiers: 0 = derived at runtime, 1 = declared in `deviceinfo`, 2 = shipped files (`sparse/`) |

## Key risks

| Risk | Impact | Mitigation |
|---|---|---|
| hwcomposer on A13+ — vendors moving to AIDL `IComposer` | No display = no port | libhybris merged HWC3/AIDL composer support Jan–Mar 2026 (PRs #578/#609); no port has run it on hardware yet (panther needs it and has never been flashed) |
| ACK-built GKI rejected by vendor modules (MediaTek mgk: q25) | ACK kernel unusable | Build from the vendor's own GKI tree and verify CRCs per device (device-q25.md) |
| libhybris beyond Android 13 community-patched only | Every current port depends on those patches | Track `halium-16.0` |
| One rootfs for all → one bug for all | Wider blast radius | A/B rootfs slots + writable-image dev mode |
| Vendor API level ≠ Android version the user runs | Wrong GSI chosen | Read `ro.vndk.version`, or `ro.vendor.build.version.sdk` (A15+ `ro.board.api_level` is a YYYYMM date); never `ro.build.version.release` |
| FBE/userdata encryption, AVB, locked bootloaders | Install fails | Installer preflight checks with clear errors |
