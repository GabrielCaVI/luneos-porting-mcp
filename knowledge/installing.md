# Installing LuneOS on Ported Devices (Flash Kits)

LuneOS installs without touching the device's `system`, `vendor`, `vendor_boot`, `dtbo` or `super` partitions: you flash a verification-disabled `vbmeta`, a LuneOS boot image (and on A13-launch devices an `init_boot` image), and a `userdata` image containing the LuneOS rootfs and the Halium GSI as plain files. Stock Android's vendor stays in place and provides the HALs; the install is reversible. This document records the general model, the "athena-shape" pure-fastboot kit layout, the per-device flash sequences for bluejay (Pixel 6a), panther (Pixel 7) and mindphone (MT6739), debug-image workflow, and the anti-rollback constraints that can brick a device if ignored.

## The general model

```
adb reboot bootloader        # or the device's key combo
./install.sh                 # vbmeta (verification off) → boot [→ init_boot] → userdata → reboot
```

- `fastboot flash vbmeta` with `--disable-verity --disable-verification` (a self-built boot image never verifies against stock vbmeta).
- `fastboot flash boot` — and on A13-launch devices also `fastboot flash init_boot` (kernel and ramdisk live in separate partitions there).
- `fastboot flash userdata userdata-luneos.img` — an ext4 image holding `rootfs.img` + `android-rootfs.img`.
- `userdata` must end up **unencrypted** (FBE is on by default from Android 10); flashing the prebuilt ext4 image satisfies this.
- Everything else stays stock. Reverting = reflash stock boot/vbmeta and wipe the files.

## The athena-shape kit (current standard)

All three staged kits (`/media/herrie/LuneOS/athena-staging/`, `bluejay-staging/`, `panther-staging/`) now share the same pure-fastboot shape — no `fastboot boot` + `adb push` dance. Kit contents (panther example):

| File | |
|---|---|
| `boot-<device>-luneos.img` | boot image (panther: kernel only, ramdisk=0) |
| `init_boot-<device>-luneos.img` | panther only: ramdisk only (8 MB partition, ~1.66 MB spare) |
| `boot-<device>-luneos-debug.img` | kernel + ramdisk + `enable_adb`, for `fastboot boot` only |
| `userdata-luneos.img` | 3,774,873,600 B ext4 labeled `userdata`, with `rootfs.img` + `android-rootfs.img` side by side |
| `vbmeta.img` | stock copy, flashed with verity/verification off |
| `install.sh` | vbmeta → boot [→ init_boot] → userdata → reboot |
| `make-userdata.sh` | rebuilds the userdata image after a rootfs rebuild |
| `luneos_<device>_<yyyymmdd>.tar.gz` | the whole kit, distributable (e.g. `luneos_panther_20260904.tar.gz`, `luneos_bluejay_20260904.tar.gz`) |

Contents of the userdata image:

- `rootfs.img` — the deploy ext4 of `luneos-image-halium-arm64` (universal rootfs, ~2.6–3 GB).
- `android-rootfs.img` — the Halium GSI `system.img` (raw ext4, system-as-root). **The name matters** (`halium-boot.sh` checks `/tmpmnt/android-rootfs.img`), and it must sit **next to** `rootfs.img` on userdata (the halium `file_layout`), not only inside the rootfs.

Rebuild command (from the mindphone kit; adjust size):

```
mke2fs -q -F -t ext4 -L userdata -d <dir with rootfs.img> userdata-luneos.img 3600m
```

The small image **grows to the real partition size on first boot** via `resize_userdata_if_needed()` in `halium-boot.sh`. Known fixed bug: the original code matched only `/dev/mmcblk*` and `/dev/disk*` paths when computing the partition size from `/proc/partitions`; on a UFS device `readlink -f` resolves to `/dev/sd*`, neither case matched, and the filesystem was silently left at image size — harmless with the old format-and-push flow, **fatal to the shipped-image flow**. Fixed generically: read `/sys/class/block/<dev>/size` (512-byte sectors, present for every block device), old greps as fallback, warn to kmsg if neither works. Make sure any initramfs you ship carries this fix.

## Per-device sequences

### bluejay (Pixel 6a — A12-launch layout, one boot image)

Kit: `/media/herrie/LuneOS/bluejay-staging/`. No `init_boot` on an A12-launch device, so `install.sh` flashes one boot image where panther flashes two; everything else in the two kits is the same file, hardlinked. Userdata partition is ~110 GB; the 3.77 GB image grows on first boot.

```
adb reboot bootloader
./install.sh          # vbmeta (verification off) -> boot -> userdata -> reboot
```

(The original bluejay flow — `fastboot format:ext4 userdata`, then `fastboot boot` the debug image and `adb push` 3.1 GB of images into the mounted partition — still works and sidesteps the resize path entirely, since the format sizes the fs to the partition. It was replaced by the pure-fastboot kit on 4 Sep 2026.)

### panther (Pixel 7 — A13-launch layout, boot + init_boot)

Kit: `/media/herrie/LuneOS/panther-staging/`. Two images instead of one: `boot` gets our GKI kernel (no ramdisk), `init_boot` gets our LuneOS initramfs (kernel=0). `vendor_boot`, `vendor_kernel_boot`, `dtbo`, `super` stay stock. `install.sh` flashes vbmeta → boot → init_boot → userdata → reboot. Image sizes: `boot-panther-luneos.img` 16,912,384 B (64 MB partition), `init_boot-panther-luneos.img` ~6.65 MB (8 MB partition — watch the headroom; lz4 instead of gzip is the escape hatch if the ramdisk grows).

### mindphone (MT6739 — header v2, A/B, no custom recovery)

Everything goes through fastboot; there is no custom recovery for this device. Artifacts in `gsigki/mindphone/images/`: `boot-luneos-mindphone.img` (= the deploy's `zImage-mindphone.fastboot`, kernel + LuneOS initramfs), `vbmeta-disabled.img`, `userdata-luneos.img` (3.0 GB rootfs).

```
adb reboot bootloader            # or Vol-Down + Power
fastboot flashing unlock         # once; needs OEM-unlock toggle in Android; wipes data
fastboot flash vbmeta   vbmeta-disabled.img
fastboot flash boot_a   boot-luneos-mindphone.img
fastboot flash boot_b   boot-luneos-mindphone.img
fastboot flash userdata userdata-luneos.img
fastboot reboot
```

AVB details: stock `vbmeta.img` is SHA256_RSA2048-signed with flags=0 (verification enforced) and chains `vbmeta_system`, `vbmeta_vendor` and **`boot`** (the boot image carries its own AVB footer), so a self-built boot.img will NOT verify. With the bootloader unlocked, flash a verification-disabled vbmeta made with:

```
avbtool make_vbmeta_image --flags 2 --padding_size 4096 --output vbmeta-disabled.img
```

(or `fastboot --disable-verity --disable-verification flash vbmeta vbmeta.img`). MTK lk in unlocked/orange state then boots the unsigned image. Optionally append an unsigned hash footer with avbtool so footer-expecting tooling stays happy — not required once verification is off. Flash **both** boot slots to keep A/B consistent.

### radon (FuriPhone FLX1s, MT6877) — SP Flash Tool / mtkclient, NOT fastboot

Kit: `~/webos/LuneOS/staging/radon-staging/`. **The first kit here that does not
use fastboot at all.** The FLX1s is flashed over MediaTek's BROM/preloader link
— SP Flash Tool on Windows, `mtkclient` on Linux. There is no fastboot step in
the install and no `fastboot getvar` to interrogate the device with, which
changes several habits this document otherwise assumes.

Entering flash mode: power fully **off**, hold **Volume Down**, plug in USB. A
bootlooping device presents its preloader on each cycle and mtkclient polls for
exactly that.

```
./backup-stock.sh     # reads boot_a/boot_b/expdb - writes nothing
./install.sh          # boot_a + boot_b -> userdata
```

Partitions are written **by name** (`mtk w <name> <file>`), never by offset.
mtkclient's `wo`/`wf` are deliberately unused: a wrong offset overwrites what
follows, and on this SoC that can include the preloader — the one genuinely
hard-to-recover MediaTek brick.

What differs from every fastboot kit, and why:

| | fastboot kits | radon |
|---|---|---|
| Partition sizes | `fastboot getvar partition-size:x` | parsed from `mtk printgpt` (`name: Offset 0x…, Length 0x…`) |
| Which slot is active | `fastboot getvar current-slot` | **unknowable from the host** — it lives in `misc`. Both slots are written by default |
| Unlock state | `fastboot getvar unlocked` | not exposed; BROM does not care |
| vbmeta | flashed with `--disable-verity --disable-verification` | flashed, from a **generated** empty unsigned AVB image with `flags 0x3` — byte-identical to the one FuriLabs ship |
| `super` | untouched | untouched, and here it matters more: **FuriLabs' own vendor image lives in it** and the port runs against that vendor |

**Read the vendor's own flash package before deciding a device needs no
vbmeta.** The first version of this kit flashed none, reasoning from
`DEVICE_VBMETA_REQUIRED = 0` in FuriLabs' *kernel* packaging. That variable only
says the kernel .deb builds no vbmeta — their *flash* package ships one anyway
(`merged/vbmeta.img`, `is_download: true` in the scatter), and it is an empty
**unsigned** AVB image with `flags = 0x3`
(HASHTREE_DISABLED | VERIFICATION_DISABLED), `release_string "avbtool 1.2.0"`,
4096 bytes. Writing it is what lets an unsigned self-built kernel boot.

That file is trivially regenerable — a 256-byte header, `algorithm_type 0`,
`flags 3`, zero-padded to 4096 — and a generated copy comes out byte-identical,
so a kit can ship its own rather than redistributing the vendor's.

**MediaTek scatter sizes for the LAST partition are nominal.** The MT6877
scatter declares `userdata` as 3 GiB (`0xc0000000`) while FuriLabs themselves
ship a 6.4 GiB `userdata.img` against it — and the MP01 (MT6789) declared the
same 3 GiB for a partition the device reported as 108.8 GiB. An install script
should treat a reported `userdata` size at or below the nominal figure as
suspect and ask, rather than refusing and sending the operator off to shrink an
image that did not need shrinking.

**MTK lk does not verify the boot header's SHA-1 `id` field.** FuriLabs' own
shipping `boot.img` has an `id` that matches its contents under no v0/v1/v2
scheme, and it boots — most likely because they rebuild the ramdisk into an
already-packed image. Do not spend time chasing an `id` mismatch on a MediaTek
device.

`expdb` is the debugging channel when USB never comes up — same as mp01, and
readable over the same preloader link that did the flashing:

```
( cd ~/mtkclient && python3 mtk.py r expdb expdb.bin )
strings expdb.bin | grep -iE 'kernel|panic|watchdog' | tail -40
```

`backup-stock.sh` saves a *baseline* expdb from a healthy phone, which is what
separates "this line is the failure" from "this line is always there".

**There is no published factory image for this device.** FuriLabs ship their
kernel as a Debian package (`linux-bootimage-furiphone-radon`), not a
downloadable `boot.img`, so backing up `boot_a`/`boot_b` before flashing is the
only cheap way back. `restore-stock.sh` writes it back.

## Debug boot images and boot-failure entry points

- Every kit ships `boot-<device>-luneos-debug.img`: the same image with `enable_adb` on the cmdline → init drops into the **initramfs adbd debug shell**. It is self-contained (kernel + ramdisk + cmdline), so `fastboot boot boot-<device>-luneos-debug.img` runs it **without flashing anything** — regardless of what the bootloader does with `init_boot` during `fastboot boot`. This is the first tool to reach for when a device doesn't come up. **Two exceptions**: MediaTek lk often does not implement `fastboot boot` at all (mp01 flashes the debug image instead of booting it), and radon has no fastboot whatsoever — there the debug image is written to `boot_a` with mtkclient.
- If normal boot hangs in the initramfs, it panics into an adb gadget named "Halium initrd — Failed to boot" — `adb shell` then and read `/dev/kmsg`.
- Old mindphone note: the initramfs `machine.conf` had copy-pasted `mmcblk0p27/28` values — harmless (only the panic path uses `system_partition`) but should be by-name paths.

## Anti-rollback (ARB) — read before flashing anything on a Pixel

- **bluejay:** bootloader ARB was bumped by Android 13 (Oct 2022) and **again by the May 2025 update**. A device on Android 16 cannot boot anything older than the May-2025 A15 build; flashing older factory images risks a **permanent brick**, including via the inactive-slot fallback trap — keep both slots consistent. Consequence: no downgrade ladder on bluejay; the port targets the 6.1 kernel + Android 16 vendor + Halium 16 GSI, full stop.
- **panther:** same shape. The device must be on `bp4a` (the build ported against) or downgradable to it; never flash older than the installed build. If a device shows up on a newer build (cp1a/cp2a = Android 17), redo the factory-image analysis against that build — ARB forbids going back to bp4a.
- General rule for the boot-image ports: the LuneOS boot image pairs with a specific stock vendor build (kernel modules, cmdline, vendor HALs). Match the factory image you analyzed to what is on the device.

## What the boot images contain (context)

- **bluejay:** `boot-bluejay-luneos.img` = header v4, Tier A GKI 6.1.172 kernel (`android14-6.1-2026-06_r7` + `luneos_defconfig`, 203/203 factory-module KMI-compatible) + LuneOS initramfs as the boot ramdisk. The bootloader merges vendor_boot's ramdisk fragments first, then ours on top — our `init` wins, and the vendor's early modules (`lib/modules`, UFS included) are present for our init to load.
- **panther:** the identical kernel binary (stock bluejay and panther kernels are sha256-identical — one GKI per KMI), split across `boot` (kernel only) and `init_boot` (initramfs only). Initramfs is device-agnostic — bluejay's verbatim.
- **mindphone:** header v2, 32-bit ARM zImage (armv7 build, NOT Image.gz/arm64), stock dt_table dtb reused verbatim, stock cmdline `bootopt=64S3,32S1,32S1 buildvariant=userdebug`, must stay ≤ 24 MB. Sanity-check with `unpack_bootimg.py` and diff header fields against the stock table.

Since 4 Sep 2026 the bluejay/panther images come out of bitbake (`MACHINE=<dev> bitbake luneos-bootimg-gki`) rather than hand-run mkbootimg, and the staging kits were re-cut from those; `ANDROID_BOOTIMG_INIT_BOOT = "1"` in the machine conf is what splits panther's pair. The bitbake initramfs also carries a fix the hand-built kits predated: `0001-halium-find-the-Android-image-instead-of-assuming-whe.patch` (30 Aug), which fixes exactly the "userdata image with only rootfs.img in it does not boot" case the flashed-userdata install relies on — always cut kits from current bitbake images.

## Installer end state (plan §8, not yet built)

`luneos-installer` (Python, host-side): detect the device (`fastboot getvar product`, `ro.product.device`, `ro.board.api_level`, `ro.boot.slot_suffix`, boot header version from the stock boot.img) → look up `devices/<codename>/deviceinfo`; unknown devices get "generic GKI" mode (pull the stock boot/init_boot off the device, repack with the LuneOS initramfs, warn loudly) → download universal `rootfs.img`, `system-gsi-<vndk>.img`, boot images → flash vbmeta/boot/init_boot, format userdata unencrypted, push the two images → reboot.

## lk2nd devices (Galaxy A3 (2015), 8 Oct 2026)

- lk2nd lives in the first 512 KiB of the boot partition and boots the real boot image from 0x80000.
  `fastboot flash boot` inside lk2nd writes behind it; `fastboot boot` RAM-boots and passes the previous
  bootloader's arguments on (including `androidboot.mode=charger` when the SBL started in charger mode).
- **Do not let anything dd a boot image to the start of the partition.** android-kernel-bootimg's postinst
  did, once, from a pending first-boot configure; it now writes 512 KiB in when it finds lk2nd there.
  Restore over Download mode: `heimdall flash --BOOT <lk2nd 512 KiB + boot.img>`; keep a copy of lk2nd's
  512 KiB.
- **Samsung SBL + cable + hard reset = charger mode** (`androidboot.mode=charger androidboot.baseband=lpm`),
  including lk2nd's `fastboot reboot`. Get a normal boot with a warm reboot that carries an argument
  (`reboot2 normal`-style RESTART2 from an initramfs shell, `systemctl reboot --reboot-argument=normal`
  from LuneOS), or a hard reset without the cable. The initramfs should hold and charge in charger mode
  (meta-smartphone#6).
