# Device Bring-up in meta-smartphone / Yocto

How a LuneOS port is wired into Yocto: layer geography, machine confs, the generic halium-arm64 machine, GKI boot-image machines, GSI recipes, LXC config and build traps.

Device stories live in the device files; this file holds the rules and the recipe
mechanics they share.

## ANDROID_BOOTIMG_* changes do not always re-run do_deploy

`kernel_android.bbclass` reads the boot-image addresses in a loop:

```python
for key, var in (("cmdline",     "ANDROID_BOOTIMG_CMDLINE"),
                 ("kerneladdr",  "ANDROID_BOOTIMG_KERNEL_RAM_BASE"),
                 ("ramdiskaddr", "ANDROID_BOOTIMG_RAMDISK_RAM_BASE"), ...):
    cmd += ["-c", "%s=%s" % (key, d.getVar(var))]
```

Because the variable name reaches `d.getVar()` through `var` rather than as a
literal, bitbake's dependency scanner cannot see the reference, so changing one of
these in the recipe **may not invalidate `do_deploy`** — the build succeeds, reports
no error, and silently redeploys the previous boot image. Always follow such a
change with:

```sh
MACHINE=<m> bitbake -f -c deploy linux-<vendor>-<device>
```

and then verify the produced image rather than trusting the build (see the
kernel/ramdisk window check in boot-images.md). (Found on athena; see device-athena.md.)

A missing `*_RAM_BASE` is worth calling out on its own: the default is `0x0`, so a
recipe that loses the line produces an image whose ramdisk is loaded at address
zero. Nothing in the build complains.

## Repo and layer geography

- **`meta-smartphone` is the repo, not the layer.** `meta-smartphone/meta-android` is a
  separate Yocto layer with its own `layer.conf`, already generic: libhybris,
  android-headers, the GSI recipe base, initramfs and lxc-android live there, and no recipe
  in it names a device. The planned `meta-halium` layer was deliberately dropped — all GSI
  work lives in `meta-smartphone/meta-android`.
- Vendor layers hold the device machines: `meta-smartphone/meta-google` (sargo, sunfish,
  bramble, bluejay, panther, tangorpro), `meta-smartphone/meta-greentouch` (mindphone), plus `meta-xiaomi`,
  `meta-oneplus`, etc. Long-term these are deleted for Halium/GSI targets and kept only for
  mainline/legacy non-Treble devices.
- LuneOS distro bits: `meta-webos-ports/meta-luneos` (nyx-modules recipe, defaulttunes,
  the HAL glue recipes: libgbinder, ofono-binder-plugin, pulseaudio-modules-droid,
  bluebinder, sensorfw, qt6-qpa-hwcomposer-plugin, nyx-modules-hybris, waydroid, …).
- **Yocto release: wrynose.** Upstream is `shr-distribution/meta-smartphone` branch
  `wrynose`; the port work in these notes was verified against the
  `Herrie82/meta-smartphone` branch `herrie/wrynose-structured`. The abandoned prior art
  is the single-commit `herrie/kirkstone-halium9-gsi` branch (`daf7fb55`), which is a
  mido config wearing a generic name — do not reuse anything from it unchecked.
- Build tree: a `webos-ports` checkout (`$BUILD_DIR`), entered with
  `MACHINE=<machine> . ./setup-env`.

## What a machine conf contains

Real examples on disk:

**`meta-google/conf/machine/sargo.conf`** (Tier B, Pixel 3a) — a machine that builds
only the kernel and boot image; the rootfs is `halium-arm64`'s:
- `PREFERRED_PROVIDER_virtual/kernel ?= "linux-google-sargo"`
- `PREFERRED_VERSION_android-headers-halium = "16.0%"` (tracks the GSI, below)
- `VIRTUAL-RUNTIME_android-system-image = ""` — no system image baked in
- No XSERVER: the stack is hwcomposer-based.
- Still hardcoded: `ANDROID_BOARD_BOOTIMAGE_PARTITION = "/dev/block/mmcblk0p13"`,
  `SERIAL_CONSOLE = "115200 ttyMSM0"`.

**`meta-greentouch/conf/machine/mindphone.conf`** (32-bit MTK): `TARGET_ARCH=arm` +
`tune-cortexa8`, `KERNEL_IMAGETYPE = zImage`, `SERIAL_CONSOLE ttyMT0`, by-name boot
partition path, `PREFERRED_VERSION_android-headers-halium` bumped `11.0%` → `16.0%` when
the device moved to the Halium 16 arm32 GSI.

**android-headers track the GSI, not the vendor** (contrary to what the 13.0/14.0
recipes state). libhybris gates its per-generation support on `ANDROID_VERSION_MAJOR`
(Android 16: `>= 16`), and that macro comes from this package. Verified safe for the vendor
ABI: `gralloc.h`, `hwcomposer2.h`, `hardware.h`, `lights.h` are byte-identical between 11.0
and 16.0, and `audio_hw_device`'s member order is unchanged with four fields appended. When
a machine moves to a newer GSI generation, bump `PREFERRED_VERSION_android-headers-halium`
with it and rebuild libhybris. (Found on sargo; see device-sargo.md.)

**`meta-android/conf/machine/include/meta-android-halium.inc`** carries
`MACHINEOVERRIDES =. "halium:"`, libhybris as `virtual/egl|mesa|libgles*`, `ofono-halium`,
`initramfs-scripts-halium` — and `TUNE_PKGARCH:append = "-halium"`, the historical scaling
blocker (every package becomes `aarch64-halium`).

## The generic `halium-arm64` machine

One universal arm64 rootfs, no kernel, no GSI baked in; device machines build only their
kernel and boot image (proven first on sargo, see device-sargo.md).

```
PREFERRED_PROVIDER_virtual/kernel = "linux-dummy"   # no kernel in the rootfs build
MACHINE_ESSENTIAL_EXTRA_RDEPENDS = ""
IMAGE_FSTYPES = "ext4 tar.gz"
```

**Do NOT drop `TUNE_PKGARCH:append = "-halium"`**: `aarch64` is
already produced by non-Halium arm64 machines (pinetab2) and TMPDIR is shared, so removing
the taint would mix libhybris-linked and mesa-linked packages in one feed. The actual
enemy is the **MACHINE_ARCH feed**: 49 recipes were machine-arch for sargo, measured with
`meta-android/scripts/check-machine-arch.sh`. The CI gate that keeps the rootfs universal:

```sh
# fail the build if any package in the image is MACHINE_ARCH
find tmp/deploy/ipk -mindepth 1 -maxdepth 1 -type d ! -name 'all' ! -name 'aarch64*' ! -name noarch
```

Anything landing in a `halium-arm64/` feed dir is a bug — move it to the adaptation repo.

**`MACHINE_FEATURES`-gated packages never reach the generic rootfs.** A packagegroup's
`contains_any('MACHINE_FEATURES', ...)` is evaluated for the machine that builds the
rootfs, which is `halium-arm64`; a feature set in a device machine that builds only a
boot image (q25's `trackpad`, athena's `keyboard-touch`) can never pull its package in.
Ship such packages on the generic image (`RDEPENDS:${PN}:append:halium-arm64`, and
`:halium-arm`) and let the runtime decide, and grep `contains_any('MACHINE_FEATURES'` in
the packagegroups whenever a device builds only a boot image. (Found on q25; see
device-q25.md.)

## GKI device machines (the bluejay / panther pattern)

A GKI machine builds kernel and boot images from bitbake:

```
MACHINE=bluejay bitbake luneos-bootimg-gki      # same for panther
```

Output in `tmp/deploy/images/<machine>/`: `boot-<machine>-luneos.img`,
`boot-<machine>-luneos-debug.img`, and on panther `init_boot-panther-luneos.img`. All
header v4, header_size 1584; panther's boot has `ramdisk=0`, its init_boot has `kernel=0`.

Files that make it work:

| File | Role |
|---|---|
| `meta-android/lib/halium/bootimg.py` | v3/v4 boot image writer — verified **byte-identical** to AOSP `mkbootimg.py` for all four shipped shapes (kernel-only, ramdisk-only, kernel+ramdisk, kernel+ramdisk+`enable_adb`) |
| `meta-android/classes/kernel_android.bbclass` | routes header_version >= 3 to the new writer; stops splitting an appended dtb for v3+ (no dtb section exists) |
| `meta-android/recipes-kernel/linux-halium-gki/linux-halium-gki_6.1.bb` | builds the ACK android14-6.1 kernel in-tree |
| `meta-android/classes/gki_bootimg.bbclass` | packs that kernel + the machine initramfs |
| `meta-google/conf/machine/{bluejay,panther}.conf` | the machines (`GKI_BOOTIMG = "1"`, `PREFERRED_VERSION_linux-halium-gki = "6.1%"`) |
| `meta-android/recipes-bsp/gki-bootimg/luneos-bootimg-gki_1.0.bb` | the packing recipe, enabled by `GKI_BOOTIMG = "1"` |

**The kernel is built in-tree, but not with the OE toolchain.** `linux-halium-gki_6.1.bb`
builds ACK android14-6.1 with plain kbuild and Google's prebuilt clang 17 (r487747c), the
compiler the KMI was frozen with: rebuilding ACK with OE's cross toolchain would move the
exported-symbol CRCs under `CONFIG_MODVERSIONS` and the stock vendor modules would stop
loading — which is the whole Tier A property (stock `vendor_boot`/`vendor_dlkm` modules
keep loading against our kernel). `gki_bootimg.bbclass` takes the kernel from
`GKI_KERNEL_PROVIDER ?= "linux-halium-gki"` by default; setting `GKI_KERNEL_IMAGE`
overrides it with an out-of-tree Image (e.g. one built by `build-bootimg.sh` in
github.com/Herrie82/luneos-bootimg-bluejay). `PREFERRED_PROVIDER_virtual/kernel =
"linux-dummy"` only means the rootfs carries no kernel. bluejay, panther and
tangorpro use the 6.1 recipe; there is no `linux-halium-gki_5.10.bb` (q25 builds its
own kernel: `GKI_KERNEL_PROVIDER = "linux-zinwa-q25"`).

No nyx-modules file is needed per machine: module selection lives in
`nyx-modules-machines.inc` (see nyx-modules.md).

**`ANDROID_BOOTIMG_INIT_BOOT = "1"`** is what splits the output into a kernel-only `boot`
plus a ramdisk-only `init_boot` (panther, A13-launch layout). bluejay sets `"0"` and gets
one combined `boot.img` (A12-launch layout, no init_boot partition).

The ramdisk is the stock `initramfs-scripts-halium` one: its `init.sh` carries the GKI
module loader and cmdline module parameters, and its patches the userdata-resize fix and
the "find the Android image" fix the flashed-userdata install relies on (see
boot-images.md § Where the fixes live now). Cut flash kits from current bitbake images.

## Build commands

```sh
cd $BUILD_DIR && . ./setup-env

MACHINE=bluejay   bitbake luneos-bootimg-gki        # kernel + boot images
MACHINE=panther   bitbake luneos-bootimg-gki
MACHINE=mindphone bitbake luneos-dev-image          # full image (long)

# mindphone kernel (Tier B, in-tree BSP kernel):
MACHINE=mindphone bitbake linux-greentouch-mindphone
# → deploys zImage-mindphone.fastboot (= boot.img) under tmp/deploy/images/mindphone/
```

Repack inputs live under `tmp/deploy/images/`: e.g.
`tmp/deploy/images/halium-arm64/luneos-image-halium-arm64.rootfs.tar.gz` and
`tmp/deploy/images/<machine>/initramfs-android-image-<machine>.cpio.gz`.

## android-system-image recipes

- `android-system-image.inc` is fully on **`${UNPACKDIR}`** (`.../<pv>/sources`) — any new
  GSI recipe must use it, not `${WORKDIR}` (UNPACKDIR sweep commits `dde5391a` +
  `0b37a1ae`).
- The `.inc` consumes `${UNPACKDIR}/system.img` in place (`mv` → `simg2img` → `rm`), keeps
  the sparse→ext4 conversion and the `/android/{system,vendor,data,...}` symlink logic —
  already generation-agnostic.
- `ANDROID_SYSTEM_IMAGE_DESTNAME = "android-rootfs.img"` — correct because the generic
  `halium_arm64` GSI is **system-as-root** (`/init`, `/system`, `/vendor`, `/odm` at the
  image root), so `pre-start.sh` takes its `[ -e /android/init ]` branch. `/vendor` inside
  the GSI is a real empty directory (0755, gid 2000), a clean mount point for either a
  loop-mounted `vendor.img` or the device's stock vendor.
- The **selection pattern** (`android-system-image-sargo.bb`): two knobs pick the
  system image and the vendor; the default is the GSI over the phone's stock `/vendor`
  (mounted by `mount_device_vendor()` in initramfs-scripts-halium), the Treble
  arrangement:

```bitbake
SARGO_ANDROID_SYSTEM ?= "gsi"     # or "device": the old sargo-specific Halium 9 build
SARGO_ANDROID_VENDOR ?= "none"    # "none": mount the phone's own /vendor; "device": ship vendor.img

SRC_URI = ".../${SARGO_GSI_RELEASE}/${SARGO_GSI_TARBALL};name=gsi;subdir=gsi"
# the device tarball is fetched only when one of the two knobs asks for it
SRC_URI += "${@d.getVar('SARGO_DEVICE_URI') if 'device' in (d.getVar('SARGO_ANDROID_SYSTEM'), d.getVar('SARGO_ANDROID_VENDOR')) else ''}"

do_install:prepend() {
    cp ${UNPACKDIR}/${SARGO_ANDROID_SYSTEM}/system.img ${UNPACKDIR}/system.img
    rm -f ${UNPACKDIR}/vendor.img
    if [ "${SARGO_ANDROID_VENDOR}" = "device" ]; then
        cp ${UNPACKDIR}/device/vendor.img ${UNPACKDIR}/vendor.img
    fi
}
```

The copy sits in `do_install:prepend` rather than a `do_unpack` postfunc because the `.inc`
consumes `${UNPACKDIR}/system.img` in place, so re-copying keeps a re-run idempotent.

- mindphone points at its 32-bit GSI through the same include, with
  `HALIUM_LUNEOS_GSI16_ARCH = "halium_arm"` and its own PV/SHA in
  `android-system-image-mindphone.bb`.
- The 16.0 GSI in use is pinned once, in
  `meta-android/recipes-core/android-system-image/halium-luneos-gsi-16.inc`
  (`HALIUM_LUNEOS_GSI16_PV`/`_SHA256`/`_ARCH`, weak assignments a device may override);
  every `android-system-image-<device>` recipe requires it. Published releases: see
  gsi-building.md.

## mount-android.sh and the LXC container

**Dynamic partitions.** From Android 10, `system`/`vendor`/`product` are logical
partitions inside `super`, with a custom header (not LVM), mapped with `dm-linear` via
`droidian/parse-android-dynparts`. **Retrofit is the case that matters**: a device
launched before Android 10 and upgraded gets *retrofit* dynamic partitions — metadata on
`system`, extents spanning `system`+`vendor`, and **no partition named `super`, ever**.
sargo (launched on Android 9) is retrofitted from Android 10: AOSP `device/google/bonito`
sets `PRODUCT_RETROFIT_DYNAMIC_PARTITIONS := true` from `android-10.0.0_r1`, and the
LineageOS board config reads

```
BOARD_SUPER_PARTITION_METADATA_DEVICE := system
BOARD_SUPER_PARTITION_BLOCK_DEVICES   := system vendor
```

Retrofit is a device *class* (most phones were upgraded to 10/11 rather than launched on
it). `mount-android.sh` used to gate on a `super` partition, and `parse-android-dynparts`
refused multi-device layouts while hardcoding `argv[1]` as the device in every linear
target; both fixed in `03508c3e`. Single-`super` is a strict subset of the retrofit path
(`target_source` always 0), so the fix cannot regress launched-on-A10 devices.
`tests/loopback-retrofit-test.sh` (22 assertions on loop devices with real
device-mapper) pins the retrofit mapping and the Android 9 no-metadata behaviour (exit 0,
no dm nodes).

**Mount from systemd, not the initramfs** (Droidian's model): `mount-android.sh` runs as
`ExecStartPre` of `android-system.service` — udev, `dmsetup` and `parse-android-dynparts`
are unavailable in the initramfs. It:

- takes the A/B slot from `/proc/bootconfig` **or** `/proc/cmdline` (Android 12+ moved it);
- searches `by-partlabel`, `by-name`, `by-label`, `by-path`, `by-uuid`, `by-partuuid`,
  `by-id`, trying `<name>$slot` before `<name>`;
- maps dynamic partitions with `dmsetup create --concise` fed by `parse-android-dynparts`;
- validates the mount by checking that `/vendor/build.prop` exists rather than assuming;
- derives `product` and `odm` from the *vendor's* fstab once vendor is mounted;
- strips `context=` / `trusted=` mount flags.

**Container config** (`meta-android/recipes-core/android-system/`, `9b32def7`):

- `lxc.arch` is derived from `TARGET_ARCH` (was hardcoded `armhf` — wrong on arm64, but
  armhf targets still exist in the tree, so derive, don't flip); `lxc.uts.name = android`.
- binderfs mounted on the host and bound in as optional.
- APEX handled by UBports' `mount-apexes.py`, which pre-mounts the minimal
  runtime/art/i18n/vndk set the linker needs before the container starts. Required from
  Android 10 — libraries move into APEXes and libhybris cannot find them otherwise.
- `/apex`, `/odm`, `/vendor_dlkm` need no container entries — unlike Droidian, LuneOS
  mounts under `/android`, which *is* the container root (same inode). Droidian's
  reference config marks these `optional` so they cost nothing on older devices.
- LuneOS kernels leave `CONFIG_SYSVIPC` (hence `IPC_NS`) off, and `USER_NS` is KMI-poison
  on MediaTek mgk (q25, mp01), so **LXC must not unshare the IPC or user namespace** — the
  shipped `lxc-config` keeps both; `PID_NS` is available.
- LXC 4.0.12 on a 4.14/arm32 kernel: legacy clone kept `CLONE_PIDFD` → `EINVAL`; patched
  in the lxc recipe (found on mindphone).
- **Do not enable `lxc@android.service`.** `android-system.service` starts the container
  and is enabled via `basic.target.requires`; enabling the separate `lxc@android` unit gives
  two units one container, and its `lxc-start` exiting "Container is already running" makes
  systemd run its `ExecStop` and tear down the healthy one. `lxc@android.service: Failed
  with result 'timeout'` in the journal is the tell. (Found on athena; see
  device-athena.md.)

## 32-bit (arm) machines

- **Check the stock kernel's architecture first.** A 64-bit SoC can run a 32-bit kernel
  and userland (`bootopt=64S3,32S1,32S1` on MediaTek); such a device needs
  `TARGET_ARCH=arm`, a zImage, the arm defconfig and the `halium_arm` GSI. (Found on
  mindphone, first set up arm64; see device-mindphone.md.)
- `TARGET_ARCH=arm` + `tune-cortexa8` shares the halium sstate of hammerhead/tenderloin.
- **The webruntime tune split:** the distro builds webruntime (Chromium) with thumb
  disabled, so it lands in `cortexa8hf-neon-halium` while everything else is
  `cortexa8t2hf-neon-halium`. `meta-luneos/conf/distro/include/defaulttunes.inc` bridges
  the two per machine via `PACKAGE_EXTRA_ARCHS`; a new 32-bit machine must be added there
  (`DEFAULTTUNE:<machine>` + `PACKAGE_EXTRA_ARCHS:append:<machine>`), or the image dies at
  wam-clang with "sstate manifest could not be found". Do not retune the machine instead —
  an old `cortexa8hf-neon-halium` Chromium sstate predates the `INSANE_SKIP 32bit-time`
  change, its hashes can never match, and retuning invalidates every cached task anyway.
- Old BSP kernels against gcc 14/binutils 2.4x: see kernel-porting.md for the patch
  classes.

## Build failures worth remembering

1. `ModuleNotFoundError: No module named 'halium'` — modern bitbake does not put a layer's
   `lib/` on sys.path by itself; the layer needs `addpylib ${LAYERDIR}/lib halium` in
   `conf/layer.conf`.
2. `do_package` failed on a missing `packages-split` even with `PACKAGES = ""`. An
   image-only recipe needs `inherit nopackages` (deletes the packaging tasks), not just an
   empty package list.
3. `S = "${WORKDIR}"` is rejected outright by this Yocto ("no longer supported"); a recipe
   with no sources wants `S = "${UNPACKDIR}"`.
4. bash 5.3 (new in wrynose) cannot `source` sysfs uevent files — the failed source aborted
   `mdev-partlabel.sh` before its blkid branch, leaving `/dev/disk/by-partlabel` empty.
   Fixed (`23edbee8`) by parsing `/sys/.../uevent` instead of sourcing it. By-name
   partition symlinks are what let a generic build mount the stock vendor as
   `/dev/disk/by-partlabel/vendor$slot` instead of hardcoding `mmcblk0p*`.
5. `unifdef.c` declares `static bool constexpr;` — C23 made that a keyword; pin the host C
   standard or rename (hit on both sargo's 4.9 host tools and mindphone's 4.14 tree).

## Device-agnostic principles

When adding per-device config, follow the adaptation tiers (derive at runtime first,
`deviceinfo` second, shipped files last) and the placeholder rule — both in
architecture.md.

## Build-tree traps after the build directory was cleaned

- **Export `DISTRO=luneos`** (`setup-local` does). Without it `meta-luneui`'s mesa
  patches live in a `luneos/` override directory that the `nativesdk` variant does
  not search, and parsing stops with "Unable to get checksum ... file could not be
  found" long before any of your recipes.
- **Stale stamps are the norm after someone deletes `tmp/work` contents:**
  `do_package_write_ipk` failing on a missing `packages-split/...`, `do_configure`
  on a missing source tree or `meson.cross`, `cmake --install` with no
  `cmake_install.cmake`. `bitbake -c clean <recipe>` fixes the work directory. If
  the recipe then restores from sstate as an **empty package** (only `-dbg`, `-dev`,
  `-lic` appear in `deploy-ipks/` and the image fails with "nothing provides ...")
  use `-c cleansstate`: `clean` alone refills from the same bad cache entry.
  Build with `bitbake -k` so one pass lists every stale recipe.
- **One bitbake per build directory.** A second client waits behind the first
  ("No reply from server in 30s ... Retrying server connection") and then gives
  up; check `ps` for a foreign `bitbake` before assuming a hang, especially if
  more than one agent or terminal works in the tree.
- **A backgrounded `nohup bitbake &` ignores SIGINT.** Stop it with `kill -TERM
  <pid>` and then the compile tree below it. Never `pkill -f` or `pgrep -f` with a
  pattern that appears in your own command line (it matches and kills the
  shell, exit 144, or waits on itself forever): `pgrep -f "[b]itbake"`.
- **A patch fetched by URL cannot carry `Upstream-Status`**, which wrynose's
  patch-status QA requires. Keep a local copy of the commit in the recipe's
  directory with the header added.
- **The standard image has no `ar`**, so `appinstalld2` cannot install IPKs; the
  developer package group (`packagegroup-luneos-development`) brings `binutils`.
  The installer's own package database is separate, so an IPK with `Depends:` on a
  system package fails with "nothing provides ...".
- **Edit recipes between bitbake runs, not while one is starting.** A run that
  started a few minutes after a recipe edit failed with "Unable to connect to bitbake
  server" and the identical command worked on the next try. The server re-parsing
  is the suspected cause; it was not proven.
