# Boot Image Construction for LuneOS Ports

How to build, verify and flash LuneOS boot images for the three layout classes: legacy header v2, A12-launch GKI (ramdisk in boot) and A13-launch GKI (ramdisk in init_boot).

The classes as met in practice: mindphone (MT6739, header v2, Android 11), bluejay
(Pixel 6a, ramdisk still in `boot`) and panther (Pixel 7, ramdisk in its own
`init_boot` partition). Covers the initramfs overlay technique, the hardware-diagnosed
init patches (module ordering, module cmdline params, userdata resize), debug images,
and where every fix now lives. **Always unpack the stock factory image first and
verify the layout — every table below was verified from the actual images, not
assumed.**

---

## Boot header versions

| Header | Android generation | Notes |
|---|---|---|
| v0 | ≤ Android 8 | |
| v1 | Android 9 | |
| v2 | Android 10/11 | adds a `dtb` field (an AOSP dt_table, not a bare FDT) |
| v3/v4 | GKI (Android 12+) | v4 adds `boot_signature` for GKI certification; no dtb section exists |

- A11/A12: generic ramdisk in `boot`.
- **A13+ launch devices: `boot` = GKI kernel only; the generic ramdisk moved to
  `init_boot`** — replace only `init_boot`, leave stock `boot`/`vendor_boot` alone
  (if the stock GKI config were sufficient; in practice the kernel is rebuilt too,
  see kernel-porting.md).

Note the class is set by the **launch** Android version, not the running one:
bluejay runs Android 16 but launched on A12, so it has no `init_boot`.

---

## The kernel/ramdisk window — a build-time invariant

A boot header gives the kernel a *budget*, not just an address: the header asks the
bootloader to load the kernel at `base + kernel_offset` and the ramdisk at
`base + ramdisk_offset`, so a kernel longer than the gap overlaps the ramdisk's
load address.

```
window = ramdisk_offset - kernel_offset
```

On the common Qualcomm v0 layout (`base 0x0`, `kernel 0x8000`,
`ramdisk 0x01000000`) that window is **16,744,448 bytes** — and everything in the
kernel image counts, appended device trees included.

**Assert it at build time:**

```sh
python3 - "$IMG" <<'EOF'
import struct, sys
d = open(sys.argv[1], 'rb').read()
ks, ka, rs, ra, ss, sa, ta, ps, hv, ov = struct.unpack('<10I', d[8:48])
end = ka + ks
print(f"kernel {ks:,} B  ends 0x{end:08x}   ramdisk 0x{ra:08x}")
print("OVERLAP" if end > ra else f"fits, {ra-end:,} B spare")
EOF
```

**Whether an overlap matters depends on the bootloader.** Loaders that honour the
header offsets (the older Qualcomm `aboot` and its relatives) can be bound by it.
ABL, the UEFI-based Qualcomm loader that boots header v2 images on Android-10-launch
devices, relocates what it loads, and the offsets are close to advisory: surya
(POCO X3 NFC, SM7150-AC) has the same nominal 16,744,448 B window and its shipping
/e/OS kernel is 17,781,272 B, a megabyte over, booting every day. When a shipping
image for that exact device violates the window, believe the device.

**It has never been shown to cause a failure.** On athena a 24.9 MB image against
the 16.7 MB window coincided with a splash hang and was blamed for it; the splash on
that device never clears, so a dead kernel and a working boot look the same, and the
oversized image was never shown to have failed (see device-athena.md). Treat the
window as a cheap invariant to assert, not a diagnosis to reach for — and an image
that fits is never evidence that something else is the bug.

**Fix the kernel, not the address.** A published-and-working boot image for the
device (a stock ROM, or another distro's port) proves its offsets on that
bootloader. Moving `ramdisk_offset` up to buy room replaces a verified address with
an unverified one — a bad trade while a boot failure is already being debugged.
Shrink the image instead: trim the appended device trees first (usually the biggest
and most pointless chunk — see kernel-porting.md), then `CONFIG_IKHEADERS`,
`CONFIG_KALLSYMS_ALL`, vendor debug loggers. `CONFIG_DEBUG_INFO` is a red herring:
it lives in `vmlinux`, not in `Image`. On surya the two config levers took the
LuneOS kernel inside a window its own vendor kernel overruns:

| | bytes | vs window |
|---|---|---|
| stock /e/OS 4.14.356 | 17,781,272 | over by 1,036,824 |
| LuneOS, first build | 18,599,221 | over by 1,854,773 |
| LuneOS, `IKHEADERS`+`KALLSYMS_ALL` off | **14,782,385** | **1,962,063 spare** |

Cross-check the offsets against another project's port of the same SoC before
inventing them. UBports and Droidian both publish them as `deviceinfo`
(`deviceinfo_flash_offset_ramdisk` etc.); Droidian's `kernel-info.mk` calls the same
value `KERNEL_BOOTIMAGE_INITRAMFS_OFFSET`.

## Header v0 with an appended device tree (Qualcomm aboot)

Pre-Android-10 Qualcomm devices carry the device tree **concatenated onto the
compressed kernel** (`BOARD_KERNEL_IMAGE_NAME := Image.gz-dtb`) rather than in a
header section. There is no `dtb` field in a v0 header and often no `dtbo.img`.
aboot scans the blobs after the gzip stream and selects one by matching
`qcom,msm-id` (SoC id) and `qcom,board-id` (platform/subtype) against what the
hardware reports — so the set must contain the board, and only needs to contain
the board.

To read them back out of an image, decompress the gzip member and scan the
remainder for the FDT magic `d00dfeed`; `dtc -I dtb -O dts` then shows the
`model` / `msm-id` / `board-id` of each. Comparing that list against a working
image for the same device is the fastest way to confirm a board match.

`abootimg` is what builds v0 here, and it **defaults to 2048-byte pages and takes
no notice of `ANDROID_BOOTIMG_PAGESIZE`** — a 4096-byte-page v0 device needs
`ANDROID_BOOTIMG_EXTRA_ABOOTIMG_ARGS = "-c pagesize=4096"` or the sections land at
the wrong offsets. (Verified: `abootimg -c pagesize=4096` does produce a correct v0
header.) Only `android_bootimg_v2()` reads the pagesize variable.

## Class 1 — Legacy v2 (mindphone, MT6739, Android 11)

No vendor_boot, no init_boot, no super (non-dynamic partitions), A/B slots.
The whole first stage lives in the boot ramdisk → replacing it with the
LuneOS/Halium initramfs replaces the entire early boot; nothing is merged on top
(unlike GKI devices where vendor_boot fragments come first).

Stock layout (verified from the OTA payload):

```
header_version = 2          page_size = 2048
kernel:  load 0x40008000    (base 0x40000000 + kernel_offset 0x00008000)
ramdisk: load 0x45000000    (ramdisk_offset 0x05000000)
tags:    load 0x44000000    (tags_offset   0x04000000)
dtb:     load 0x44000000    (dtb_offset    0x04000000), size 69,220
second:  none
cmdline: "bootopt=64S3,32S1,32S1 buildvariant=userdebug"
os_version 11.0.0, os_patch_level 2022-03
```

boot partition: 25,165,824 bytes (24 MB) — the image must stay ≤ 24 MB.
Kernel must be a 32-bit zImage (armv7 build), not Image.gz/arm64.

The v2 `dtb` field is **not a bare FDT** — it is an AOSP **dt_table** (magic
`0xd7b7ab1e`, 1 entry, page_size 2048), the same format as dtbo.img. Reuse the
stock `unpacked-boot/dtb` verbatim, or wrap a self-built dtb with
`mkdtboimg.py create`. (There is also a separate 36 KB dtbo.img.)

### mkbootimg command

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

Sanity-check with `./unpack_bootimg.py boot-luneos.img /tmp/x` and diff the
printed header fields against the stock table.

In Yocto this is done by `kernel_android.bbclass` (v2 header support from the
Pixel 3a work), taking the prebuilt dt_table blob via `ANDROID_BOOTIMG_DTB =
"file://dt-table.img"`; `MACHINE=mindphone bitbake linux-greentouch-mindphone`
deploys `zImage-mindphone.fastboot` (= boot.img).

### AVB / vbmeta on legacy MTK

- Stock `vbmeta.img`: avbtool 1.1.0, SHA256_RSA2048-signed, **flags=0
  (verification enforced)**; descriptors chain `vbmeta_system` (rollback slot 2),
  `vbmeta_vendor` (slot 4) and **`boot` (slot 3)** — the stock boot.img carries
  its own signed vbmeta via an `AVBf` footer.
- A self-built boot.img therefore will NOT verify against stock vbmeta. With the
  bootloader unlocked, flash a verification-disabled vbmeta:
  ```
  avbtool make_vbmeta_image --flags 2 --padding_size 4096 --output vbmeta-disabled.img
  ```
  `--flags 2` sets only VERIFICATION_DISABLED; it is what the mindphone kit
  ships, and it boots. `fastboot --disable-verity --disable-verification flash
  vbmeta vbmeta.img` is **not** the same: it sets both bits (flags 3,
  HASHTREE_DISABLED | VERIFICATION_DISABLED), as do the radon and surya vbmeta
  images. Use flags 3 (`--flags 3`, or the two fastboot switches) unless a device
  is known to need otherwise.
- MTK lk in unlocked/orange state then boots the unsigned image. Optionally append
  an unsigned hash footer with avbtool so footer-expecting tooling stays happy;
  not required once verification is off.

Install (fastboot, no custom recovery exists for this device):

```
adb reboot bootloader            # or Vol-Down + Power
fastboot flashing unlock         # once; needs OEM-unlock toggle; wipes data
fastboot flash vbmeta   vbmeta-disabled.img
fastboot flash boot_a   boot-luneos-mindphone.img
fastboot flash boot_b   boot-luneos-mindphone.img
fastboot flash userdata userdata-luneos.img
fastboot reboot
```

Regenerate the userdata image after a rootfs rebuild with:
`mke2fs -q -F -t ext4 -L userdata -d <dir with rootfs.img> userdata-luneos.img 3600m`.
`android-rootfs.img` must sit **next to** rootfs.img on userdata (halium
file_layout), not only inside the rootfs.

### The `skip_initramfs` trap (Android 8–10 vendor kernels)

Many A8–A10 vendor kernels honor a `skip_initramfs` cmdline option (set by the
bootloader for normal boot) and **bypass the packed ramdisk entirely** — a
repacked boot.img then never runs your init, with nothing to show why. Fix in
kernel source: revert the "Add skip_initramfs command line option" / "call
free_initrd() when skipping init" patches in `init/initramfs.c`, or force
`do_skip_initramfs = 0` (SFOS hadk-hot,
https://sailfishos.wiki/books/hardware/page/hadk-hot). mindphone (A11) never hit
this, but any A8–A10 Tier B device will — check for it *before* concluding the
kernel or ramdisk is broken.

---

## Class 2 — A12-launch GKI (bluejay, Pixel 6a)

Stock layout (bp4a.251205.006, verified): no `init_boot`. `boot` (67 MB partition
listed; 64 MB budgeted) is header **v4, kernel only, ramdisk size 0**.
`vendor_boot` is v4 with **two ramdisk fragments**: `vendor_ramdisk00` type
PLATFORM (25 MB — first-stage init + recovery, full `/init`, sepolicy,
`first_stage_ramdisk/`) and `vendor_ramdisk01` type DLKM (5.9 MB — early Tensor
modules: aoc, exynos, UFS etc. under `lib/modules`). dtb lives in vendor_boot
(536 KB); separate `dtbo.img`; real `super`; `vendor_dlkm` partition.

**Boot flow consequence:** the bootloader concatenates vendor_boot fragments
first, then the `boot` ramdisk on top — later cpio entries win. So a repacked
`boot.img` = stock-compatible kernel + **LuneOS initramfs as the boot ramdisk**
overrides vendor `/init`, while the dlkm fragment still lands in `lib/modules` of
the merged initramfs — our initramfs can modprobe the vendor early modules (UFS!)
without shipping any.

Shipped artifact: `boot-bluejay-luneos.img` (23.5 MB, fits the 64 MB boot
partition), header v4, kernel = Tier A GKI 6.1.172, ramdisk = LuneOS initramfs.
Flash model: `fastboot flash boot <ours>` + vbmeta with
`--disable-verity --disable-verification`; vendor_boot/dtbo/vendor/super stay
stock; rootfs.img + Halium 16 GSI system.img live as files in unencrypted
userdata.

Vendor cmdline facts worth knowing (from vendor_boot): `console=ttySAC0,115200`,
`printk.devkmsg=on`, bootconfig `androidboot.load_modules_parallel=true`,
`androidboot.boot_devices=14700000.ufs`, plus `<module>.param=` options like
`ufs_pixel_fips140.fips_first_lba=…` and `exynos_drm.panel_name=samsung-s6e3fc3_6a`
that the init patch must pass through (below).

---

## Class 3 — A13-launch GKI (panther, Pixel 7)

Confirmed from the factory image (bp4a.251205.006):

| image | content |
|---|---|
| `boot.img` | hdr v4, **kernel 16,565,921 B, ramdisk size 0**, empty cmdline |
| `init_boot.img` | hdr v4, **kernel 0, ramdisk 2,657,135 B**, os 16.0.0 / 2025-12 |
| `vendor_boot.img` | v4, one PLATFORM ramdisk (24.5 MB), dtb size 0, long gs201 cmdline (`earlycon=exynos4210,0x10A00000 console=ttySAC0,115200 … fips140.load_sequential=1 exynos_drm.load_sequential=1`), bootconfig `load_modules_parallel=true`, `boot_devices=14700000.ufs` |
| `vendor_kernel_boot.img` | v4, ramdisk 6,210,314 B (**204 modules** in `lib/modules`) + **dtb 886,583 B** |

vs bluejay:

| | bluejay (A12 launch) | panther (A13 launch) |
|---|---|---|
| generic ramdisk | inside `boot` | **`init_boot`** (own partition, 8 MB) |
| kernel modules ramdisk | `vendor_boot` fragment #2 (DLKM) | **`vendor_kernel_boot`** (own partition, 64 MB) |
| `boot` | kernel + (our) ramdisk, 64 MB | kernel only, 64 MB, hdr v4 |
| AVB | vbmeta | + chained `BOARD_AVB_INIT_BOOT_*`, rollback index loc 4 |

Consequence: **two images instead of one** — `fastboot flash boot` (our GKI
kernel, no ramdisk) + `fastboot flash init_boot` (our LuneOS initramfs).
`vendor_boot`, `vendor_kernel_boot`, `dtbo`, `super` stay stock. Merge order
still puts the init_boot ramdisk last, so our `init` wins and `lib/modules`
(from vendor_kernel_boot) is there to modprobe.

Built images and headroom:

| file | bytes | partition | headroom |
|---|---|---|---|
| `boot-panther-luneos.img` | 16,912,384 | `boot` (64 MB) | 47.9 MB |
| `init_boot-panther-luneos.img` | 6,639,616–6,647,808 | `init_boot` (**8 MB**) | ~1.66 MB |
| `boot-panther-luneos-debug.img` | 23,547,904 | `fastboot boot` only | — |

**Watch the init_boot size** — the ramdisk fits with ~1.6 MB spare; lz4 instead
of gzip is the escape hatch if it ever grows. The debug image is self-contained
(kernel + ramdisk + `enable_adb`) so it works regardless of what the bootloader
does with `init_boot` during `fastboot boot`.

---

## Initramfs construction: overlay, not repack

Do not unpack-and-repack the base initramfs — that loses ownership/suid. Instead
**concatenate a gzip cpio member** onto the base cpio.gz containing only the
changed files (later cpio entries win). The bluejay ramdisk = base
`initramfs-android-image` cpio.gz + `init-overlay.cpio.gz` with the patched
`init` (later also `halium-boot.sh`). The overlay diff
(`overlay/init-gki-modules.diff` in the build repo) is verified to reproduce the
patched init byte-exact.

An alternative shape worth knowing: Droidian kernels can ship boot-time hook
functions in `debian/initramfs-overlay/scripts/halium-hooks`, executed before
the rootfs loads (documented use cases: encryption and display fixups). That is
a first-class **per-device hook file** doing the same job as our init-overlay
patches — a cleaner home for device quirks than growing the shared `init`
(https://docs.droidian.org/porting-guide/kernel-compilation/).

### Init patch history — three hardware-diagnosed bugs, keep all fixes

**v2 — fixpoint module loader.** The stock LuneOS initramfs loads no early
modules at all (`mount_kernel_modules` is a no-op) — fine on sargo where storage
is built-in, **fatal on GKI devices** (UFS driver is a module). First attempt
insmod'd `/lib/modules/modules.load` in list order → kernel panic
(`exynos4_timer_resources: unable to determine tick clock rate`): `clk_exynos_gs`
at line 15 needs symbols from `cmupmucal` at line 45. **`modules.load` is NOT
dependency-ordered** — stock init resolves deps via modules.dep
(libmodprobe, `load_modules_parallel=true`). v2 made repeated passes over the
remaining list until a pass makes no progress (bluejay: 88/203, 37/115, 26/78),
logging per-pass progress to kmsg and WARNING any module that never loaded
(never silence insmod errors with 2>/dev/null — that hid the diagnosis). Also:
after module load, poll sysfs PARTNAME up to 10 s for `userdata*` — UFS probes
async and `mountroot` has no retry.

**v3 — module cmdline parameters.** Second panic at 2.3 s:
`ufs-pixel-fips140: Invalid module params: first_lba=0 last_lba=0` → `FMP self
test failed`. Root cause: **the kernel applies `module.param=` cmdline options
only to built-ins**; modprobe parses `/proc/cmdline` for loadables, plain
`insmod` does not. `module_cmdline_args()` collects matching `<module>.*=`
tokens from /proc/cmdline for each module and passes them to insmod, treating
`-`/`_` as equivalent in the module name (modprobe semantics: file is
`ufs-pixel-fips140.ko`, cmdline says `ufs_pixel_fips140.`). This also carries
`exynos_drm.panel_name=` for the display.

**v4 — proper upfront dependency resolution.** The fixpoint loop was treating a
symptom: `module-order.py` showed **335 hard-dependency pairs listed backwards
across 99 modules** on bluejay (332 pairs / 107 modules on panther), plus **~15
`softdep pre:` edges** that no symbol dependency implies — and softdeps are
*invisible* to a retry loop (insmod succeeds, it just probes in the wrong order;
`exynos-drm` after `phy-exynos-mipi` and `exynos_pd` after `clk_exynos_gs` are
in that set — display and power-domain ordering). v4 resolves the order up front
the way modprobe does, in ~40 lines of busybox awk: each `modules.dep` line
holds the module's full dependency closure, nearest first and deepest last
(verified self-ordered per build), so emit the line reversed, then the module's
`softdep pre:` entries, then the module itself. The fixpoint loop stays behind
it as a safety net for anything whose dependency ships in `vendor_dlkm` (loaded
later). Verified host-side by extracting the awk back out of `init` and running
it under busybox awk against both devices' real
modules.dep/modules.load/modules.softdep — identical to the independent Python
resolver, 203/204 modules, 0 violations.

### The userdata-resize-on-UFS bug

`resize_userdata_if_needed()` in `halium-boot.sh` computed the partition size
with `case $path in /dev/mmcblk*) … /dev/disk*) …` — but `mountroot` sets
`path=$(readlink -f $part)`, which on a UFS device resolves to **`/dev/sd*`**.
Neither case matches, and the filesystem is silently left at its image size.
Harmless with `fastboot format:ext4 userdata` + push; **fatal to the
shipped-userdata-image flow**, which relies on a small image growing to the
~100 GB partition. Fix: read `/sys/class/block/<dev>/size` (512-byte sectors,
present for every block device including partitions), keep the old greps as
fallback, warn to kmsg if neither yields a size.

### Debug images

Same image + cmdline `enable_adb` → init panics into the initramfs adbd debug
shell. On Pixels, `fastboot boot boot-<dev>-luneos-debug.img` runs it without
flashing — that is the push/rescue channel. If boot hangs on any halium device,
the initramfs panics into an adb gadget named "Halium initrd — Failed to boot";
`adb shell` then and read `/dev/kmsg`.

Heritage note: hybris-boot (the ancestor of Halium's initramfs) signals the boot
*stage* through its debug channel — telnet on port **23** means still in the
initrd (pre-switch_root), port **2323** means post-switch_root, and marker files
(`init_enter_debug` / `init_enter_debug2` on the data partition) halt boot at a
chosen point deliberately (https://github.com/mer-hybris/hybris-boot). The LuneOS
initramfs (`initramfs-scripts-halium` `init.sh`) has the first: on its debug path it
starts telnetd at `192.168.2.15` port 23 and announces the stage in the USB
gadget's iSerial string. There is no halt-boot flag file. The full debug flow is
in debugging.md.

---

## Verification

- Unpack every produced image (`unpack_bootimg.py` for v0–v2; the factory images
  for v3/v4 comparisons) and diff header fields against the stock table for the
  device.
- The Yocto v3/v4 writer (`meta-android/lib/halium/bootimg.py`) was validated the
  only way worth trusting: it reproduces all four shipped shapes — kernel-only,
  ramdisk-only, kernel+ramdisk, kernel+ramdisk+`enable_adb` — **byte-identical to
  AOSP `mkbootimg.py`**.
- Expected shapes: header v4, header_size 1584; panther's boot has `ramdisk=0`,
  its init_boot has `kernel=0`; bluejay ships one boot image
  (`ANDROID_BOOTIMG_INIT_BOOT = "0"`), panther a pair (`= "1"`).

---

## Where the fixes live now

- **`initramfs-scripts-halium`** (upstream LuneOS repo): `init.sh` carries the
  dependency-ordered module loader and the cmdline module parameters (verified
  byte-identical to the hand-patched init);
  `0002-halium-size-userdata-from-sysfs-not-proc-partitions.patch` carries the
  resize fix; `0001-halium-find-the-Android-image-instead-of-assuming-whe.patch`
  (30 Aug) fixes the "userdata image with only rootfs.img in it does not boot"
  case the flashed-userdata install relies on. Build initramfs from bitbake to
  get all of them: `MACHINE=<machine> bitbake initramfs-android-image`.
- **`luneos-bootimg-bluejay`** build repo (github.com/Herrie82/luneos-bootimg-bluejay): self-contained
  end-user build of the boot image only — `build-bootimg.sh` (repo sync → ACK
  pin → fragment → modules.bzl trim → kernel-only bazel build → initramfs patch
  → mkbootimg ×2), `luneos_defconfig`, `overlay/init-gki-modules.diff`,
  `tools/{kmi-crc-check,symvers-drift}.py`, `tools/module-order.py`,
  `tools/extract-vendor-modules.sh`.
- **Yocto machines**: `MACHINE=bluejay bitbake luneos-bootimg-gki` (same for
  panther) builds kernel and boot images together → `tmp/deploy/images/<machine>/`.
  The ACK android14-6.1 kernel is built in-tree by
  `meta-android/recipes-kernel/linux-halium-gki/linux-halium-gki_6.1.bb` with
  Google's prebuilt clang (r487747c), plain kbuild, no OE toolchain. Supporting
  files: `meta-android/lib/halium/bootimg.py`,
  `meta-android/classes/kernel_android.bbclass` (routes header ≥3 to it; stops
  splitting an appended dtb for v3+), `meta-android/classes/gki_bootimg.bbclass`
  (packs the kernel from `GKI_KERNEL_PROVIDER ?= "linux-halium-gki"`, or an
  out-of-tree Image named by `GKI_KERNEL_IMAGE`, with the machine initramfs),
  `meta-android/recipes-bsp/gki-bootimg/luneos-bootimg-gki_1.0.bb` (gated on
  `GKI_BOOTIMG = "1"` in the machine conf), `meta-google/conf/machine/{bluejay,panther}.conf`
  (`PREFERRED_VERSION_linux-halium-gki = "6.1%"`).
- Yocto gotchas hit on the way: a layer needs `addpylib ${LAYERDIR}/lib halium`
  in `conf/layer.conf` for its `lib/` to be importable; an image-only recipe
  needs `inherit nopackages` (an empty `PACKAGES` still fails `do_package`);
  `S = "${WORKDIR}"` is rejected — use `S = "${UNPACKDIR}"`.

## Flash kits (reference shape)

Pure-fastboot install, no `fastboot boot` + `adb push` dance (the bluejay and
panther staging kits):

```
adb reboot bootloader
./install.sh     # vbmeta (verification off) → boot [→ init_boot] → userdata → reboot
```

Kit contents: boot image(s), debug image, `userdata-luneos.img`
(3,774,873,600 B ext4 labeled `userdata` with `rootfs.img` +
`android-rootfs.img` side by side, grown on first boot by the initramfs),
stock-copy `vbmeta.img` flashed with verity/verification off, `make-userdata.sh`,
and a distributable `luneos_<device>_<date>.tar.gz`. Only bluejay's `boot`
differs from panther's pair — no `init_boot` on an A12-launch device — so its
install.sh flashes one image where panther's flashes two.
