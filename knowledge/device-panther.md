# Device: panther (Google Pixel 7)

Google Pixel 7 (`panther`), Google Tensor G2 (gs201), GKI Tier A sharing bluejay's kernel; images built and KMI-verified host-side, never flashed on hardware.

Sibling of the bluejay port — same KMI, literally the same kernel binary — but an **A13-launch device**, so it exercises the `init_boot` split that bluejay cannot. Everything below is host-side verified from the factory image.

## Platform facts (factory `panther-bp4a.251205.006`, Android 16 QPR2 — sha256 `4455f800…07d3e`)

| Fact | Value |
|---|---|
| SoC / GPU | Google Tensor G2 (gs201) / Mali-G710 (big-Valhall, same unproven-under-hybris question as G78) |
| Launch layout | **A13-launch**: generic ramdisk in **`init_boot`** (8 MB partition), kernel modules in **`vendor_kernel_boot`** (64 MB, own partition) |
| `boot.img` | hdr v4, kernel 16,565,921 B, **ramdisk size 0**, empty cmdline |
| `init_boot.img` | hdr v4, **kernel 0**, ramdisk 2,657,135 B |
| `vendor_boot.img` | v4, one PLATFORM ramdisk (24.5 MB), dtb 0, long gs201 cmdline (`earlycon=exynos4210,0x10A00000 console=ttySAC0,115200 … fips140.load_sequential=1 exynos_drm.load_sequential=1`), bootconfig `load_modules_parallel=true`, `boot_devices=14700000.ufs` |
| `vendor_kernel_boot.img` | v4, ramdisk 6,210,314 B (**204 modules**) + dtb 886,583 B |
| AVB | vbmeta + chained `BOARD_AVB_INIT_BOOT_*`, rollback index location 4 |

`fastboot-info.txt` lists `flash init_boot` and `flash vendor_kernel_boot`; `android-info.txt` requires `partition-exists=vendor_kernel_boot`.

## The kernel is bluejay's, byte for byte

```
sha256(panther unpacked-boot/kernel) == sha256(bluejay unpacked-boot/kernel)
= 2be4a595a21371800d989059ae2bb2085ca8df45d44fa86f0d9ab79629ca2ceb
Linux 6.1.145-android14-11-gc1de4747ac59-ab14219743, clang 17.0.2
```

One GKI per KMI, shipped identically on gs101 and gs201 — so our Tier A kernel (`linux-halium-gki_6.1.bb` in meta-android: ACK `android14-6.1-2026-06_r7` = 6.1.172 + `luneos_defconfig` incl. UEVENT_HELPER, Google's clang 17 r487747c; `panther.conf` sets `PREFERRED_VERSION_linux-halium-gki = "6.1%"`) is a **drop-in, no rebuild, no second 10 GB sync**. The manifest branch `android-gs-pantah-6.1-android16` exists in the same tree (`private/devices/google/{gs201,pantah}`, `build_pantah.sh`) — only needed if we ever go option B (own vendor modules).

## KMI check — 204/204, zero mismatches

```
python3 kmi-crc-check.py <kernel build dir>/Module.symvers  vkb-modules
→ 204 modules checked, 0 would fail to load
```

Including `vh_mm.ko`/`vh_sched.ko` (the bumped ACK tag covers panther too). The KMI-poison list (`FANOTIFY`, `NET_L3_MASTER_DEV` stay off) transfers unchanged. `modules.load` is non-topological here as well — **332 hard-dependency pairs backwards across 107 of 204 modules, plus 15 softdep edges** (`clk_exynos_gs.ko` line 16, exporter `cmupmucal.ko` line 45) — so the init v4 dependency-resolving loader is required, same as bluejay.

## Images built

| file | bytes | partition | headroom |
|---|---|---|---|
| `boot-panther-luneos.img` | 16,912,384 | `boot` (64 MB) | 47.9 MB |
| `init_boot-panther-luneos.img` | ~6.64 MB | `init_boot` (**8 MB**) | ~1.66 MB |
| `boot-panther-luneos-debug.img` | 23,547,904 | `fastboot boot` only | — |

Two flashes instead of bluejay's one: `fastboot flash boot` (kernel only) + `fastboot flash init_boot` (LuneOS initramfs). `vendor_boot`, `vendor_kernel_boot`, `dtbo`, `super` stay stock; merge order still puts the init_boot ramdisk last so our `init` wins and `lib/modules` (from vendor_kernel_boot) is present. The debug image is self-contained (kernel + ramdisk + `enable_adb`) so `fastboot boot` works regardless of what the bootloader does with init_boot. **Watch the 8 MB init_boot budget** — lz4 instead of gzip is the escape hatch if the ramdisk grows.

Yocto: `MACHINE=panther bitbake initramfs-android-image` + `luneos-bootimg-gki` produce all three images (header v4); `ANDROID_BOOTIMG_INIT_BOOT = "1"` in `panther.conf` is what splits them. The initramfs is panther's own and carries the module loader + the userdata-resize fix (that bug — UFS `/dev/sd*` never matching the resize cases — was found on panther's kit).

## Vendor HAL surface — one genuine regression vs bluejay

- **Composer: HWC3 / AIDL `android.hardware.graphics.composer3` V4** (`hwc3-default.xml`) — there is **no HIDL composer on gs201**. panther cannot use the sargo/bluejay-proven HIDL display path; it needs libhybris' AIDL composer3 support (PR #578 Jan 2026, #609 Mar 2026 — merged, but no shipping port exercises it yet). **Biggest single risk on panther.**
- Gralloc: as bluejay (AIDL allocator V2 + `mapper.pixel.so`, `gralloc.default.so` still present).
- Radio: AIDL `IRadio*` per slot (+ HIDL `@1.2::ISap`) — check ofono-binder-plugin's AIDL support.
- Sensors AIDL multihal V3, Bluetooth AIDL `IBluetoothHci` — same caveats as bluejay.
- Audio HIDL 7.1, GNSS HIDL 2.1 brcm, camera provider HIDL 2.7 — as bluejay.

## Flash kit

The device's staging kit (athena-shape, pure fastboot): `install.sh` = vbmeta (verity/verification off) → boot → init_boot → `userdata-luneos.img` (3,774,873,600 B ext4, `rootfs.img` + `android-rootfs.img` side by side) → reboot; `make-userdata.sh`; distributable `luneos_panther_20260904.tar.gz`. rootfs/GSI shared with the bluejay kit.

## Open / cautions

- Nothing flashed or booted — no panther hardware connected yet.
- **ARB**: if a device arrives on a newer build (cp1a/cp2a = Android 17), redo the analysis against that factory image — going back to bp4a is forbidden.
- Mali-G710 under libhybris: unproven; carry the same Mali patch set as bluejay.
