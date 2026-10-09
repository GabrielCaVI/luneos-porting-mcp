# Device: panther (Google Pixel 7, Google Tensor G2 gs201)

Google Pixel 7 (`panther`), Tensor G2 gs201, GKI Tier A on bluejay's kernel binary; images built and KMI-verified host-side, never flashed.

The sibling of the bluejay port (device-bluejay.md): same KMI, literally the same kernel, but an A13-launch device, so it exercises the `init_boot` split that bluejay cannot. It is also the device with the one real HAL regression against bluejay: the composer is AIDL only.

## Status (as of 30 Sep 2026)

| Area | State | Notes |
|---|---|---|
| Boot images | built, header-verified (host-side) | no panther hardware has run them |
| Vendor modules | 204/204 load-compatible (host-side) | `kmi-crc-check.py` against `vendor_kernel_boot` |
| Everything else | untested | |

## Platform facts

Read from factory image `panther-bp4a.251205.006` (Android 16 QPR2, sha256 `4455f800…07d3e`).

| Fact | Value |
|---|---|
| SoC / GPU | Google Tensor G2 gs201 / Mali-G710 (big-Valhall) |
| Launch layout | A13-launch: generic ramdisk in `init_boot` (8 MB partition), early modules + dtb in `vendor_kernel_boot` (64 MB partition) |
| Stock kernel | sha256 `2be4a595a21371800d989059ae2bb2085ca8df45d44fa86f0d9ab79629ca2ceb` = bluejay's: `6.1.145-android14-11-gc1de4747ac59-ab14219743`, clang 17.0.2 |
| AVB | vbmeta + chained `BOARD_AVB_INIT_BOOT_*`, rollback index location 4 |
| Factory flash list | `fastboot-info.txt` lists `flash init_boot` and `flash vendor_kernel_boot`; `android-info.txt` requires `partition-exists=vendor_kernel_boot` |

## Kernel

Panther's stock kernel is byte-identical to bluejay's (kernel-porting.md § One kernel per
KMI), so the LuneOS Tier A kernel is bluejay's: ACK `android14-6.1-2026-06_r7` (6.1.172) +
`luneos_defconfig`, built by `linux-halium-gki_6.1.bb` with Google's clang 17 r487747c.
`panther.conf` sets `GKI_BOOTIMG = "1"` and `PREFERRED_VERSION_linux-halium-gki = "6.1%"`.
No rebuild and no second sync were needed. The manifest branch
`android-gs-pantah-6.1-android16` has the same project set and is only needed for option B.

KMI check against the device's own modules:

```
python3 kmi-crc-check.py <kernel build dir>/Module.symvers vkb-modules
→ 204 modules checked, 0 would fail to load
```

That includes `vh_mm.ko`/`vh_sched.ko` (the bumped ACK tag covers panther too). The poison
list (`FANOTIFY`, `NET_L3_MASTER_DEV` off) transfers unchanged. `modules.load` is
non-topological here as well: 332 hard-dependency pairs backwards across 107 of 204 modules,
plus 15 softdep edges (`clk_exynos_gs.ko` at line 16, its exporter `cmupmucal.ko` at line 45),
so the initramfs's dependency-resolving loader is required (boot-images.md § Init patch
history).

## Boot image

Layout class: boot-images.md § Class 3 — A13-launch GKI.

| Stock image | Content |
|---|---|
| `boot.img` | hdr v4, kernel 16,565,921 B, ramdisk size 0, empty cmdline |
| `init_boot.img` | hdr v4, kernel 0, ramdisk 2,657,135 B, os 16.0.0 / 2025-12 |
| `vendor_boot.img` | v4, one PLATFORM ramdisk (24.5 MB), dtb size 0, long gs201 cmdline (`earlycon=exynos4210,0x10A00000 console=ttySAC0,115200 … fips140.load_sequential=1 exynos_drm.load_sequential=1`), bootconfig `load_modules_parallel=true`, `boot_devices=14700000.ufs` |
| `vendor_kernel_boot.img` | v4, ramdisk 6,210,314 B (204 modules in `lib/modules`) + dtb 886,583 B |

| vs bluejay | bluejay (A12 launch) | panther (A13 launch) |
|---|---|---|
| generic ramdisk | inside `boot` | `init_boot` (own partition, 8 MB) |
| early modules | `vendor_boot` DLKM fragment | `vendor_kernel_boot` (own partition) |
| `boot` | kernel + our ramdisk | kernel only |

Built images:

| File | Bytes | Partition | Headroom |
|---|---|---|---|
| `boot-panther-luneos.img` | 16,912,384 | `boot` (64 MB) | 47.9 MB |
| `init_boot-panther-luneos.img` | 6,639,616–6,647,808 | `init_boot` (8 MB) | ~1.66 MB |
| `boot-panther-luneos-debug.img` | 23,547,904 | `fastboot boot` only | — |

`vendor_boot`, `vendor_kernel_boot`, `dtbo` and `super` stay stock; the init_boot ramdisk is
merged last, so our `init` wins and `lib/modules` from `vendor_kernel_boot` is there to load.
**Watch the 8 MB init_boot budget**; lz4 instead of gzip is the escape hatch. The debug image
is self-contained (kernel + ramdisk + `enable_adb`), so it works whatever the bootloader does
with `init_boot` during `fastboot boot`. The initramfs is device-agnostic (bluejay's) and
carries the userdata-resize fix, whose bug was found on panther's kit (boot-images.md § The
userdata-resize-on-UFS bug).

## Vendor and GSI

Same bp4a vendor build as bluejay, with one regression (rule: hal-userspace.md § HIDL vs AIDL):

- **Composer: HWC3 / AIDL `android.hardware.graphics.composer3` V4** (`hwc3-default.xml`,
  `android.hardware.composer.hwc3-service.pixel`). There is no HIDL composer on gs201, so
  panther cannot use the sargo/bluejay HIDL display path. It needs libhybris' composer3
  support (PR #578, #609: merged, exposed through the unchanged `hwc2_compat_*` C API so the
  QPA plugin needs no change), which no shipping port exercises yet. **The biggest single
  risk on panther.**
- Gralloc (AIDL allocator v2 + `mapper.pixel.so`, `gralloc.default.so` still present), GPU
  (Mali-G710), audio HIDL 7.1, GNSS HIDL 2.1 brcm, camera provider HIDL 2.7: as bluejay.
- Radio: AIDL `IRadio*` per slot (+ HIDL `@1.2::ISap`) — check ofono-binder-plugin's AIDL
  support. Sensors AIDL multihal V3, Bluetooth AIDL `IBluetoothHci`: as bluejay.

No VNDK → Halium 16 GSI (`halium_arm64`); gbinder ApiLevel from the vendor at boot.

## Yocto

Layer `meta-google`, `MACHINE=panther` (device-bringup-yocto.md § GKI device machines):

```
MACHINE=panther bitbake luneos-bootimg-gki     # boot, init_boot, debug image
```

`ANDROID_BOOTIMG_INIT_BOOT = "1"` in `panther.conf` is what splits kernel and ramdisk.

## Install

Pure fastboot (installing.md § Flash steps per layout class): `install.sh` flashes vbmeta
(verity/verification off) → `boot` → `init_boot` → `userdata-luneos.img` (3,774,873,600 B
ext4 with `rootfs.img` + `android-rootfs.img`) → reboot; `make-userdata.sh` rebuilds the
userdata image. rootfs and GSI are the same files as in the bluejay kit.

**Anti-rollback:** the device must be on `bp4a` or downgradable to it; never flash older
than the installed build. A device that arrives on a newer build (cp1a/cp2a = Android 17)
needs the factory-image analysis redone against that build (installing.md § Anti-rollback).

## Open issues

- Nothing flashed or booted yet. First checks on a boot: `journalctl -b | grep -i "gbinder
  ApiLevel"`, `dmesg | grep -iE "disagrees about version|Unknown symbol"` (expect nothing),
  `lsmod | wc -l` (expect ~204).
- AIDL composer3 under libhybris: unexercised by any port.
- Mali-G710 under libhybris: unproven; carry the same Mali patch set as bluejay.

## Sources

- https://android.googlesource.com/kernel/manifest (branch `android-gs-pantah-6.1-android16`)
- https://developers.google.com/android/images (factory image `panther-bp4a.251205.006`)
