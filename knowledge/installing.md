# Installing LuneOS on Ported Devices (Flash Kits)

How LuneOS is installed: flash kits that write vbmeta, a boot image (plus init_boot on A13-launch devices) and a userdata image, leaving stock partitions alone.

LuneOS installs without touching the device's `system`, `vendor`, `vendor_boot`, `dtbo` or `super` partitions: you flash a verification-disabled `vbmeta`, a LuneOS boot image (and on A13-launch devices an `init_boot` image), and a `userdata` image containing the LuneOS rootfs and the Halium GSI as plain files. Stock Android's vendor stays in place and provides the HALs; the install is reversible. This document holds the general model, the vbmeta flags, the kit layout, the flash steps per layout class, the other install routes (MediaTek BROM, lk2nd, Samsung Download mode) and the anti-rollback constraints that can brick a device if ignored. Each device's own kit and quirks are in its device file.

## The general model

```
adb reboot bootloader        # or the device's key combo
./install.sh                 # vbmeta (verification off) → boot [→ init_boot] → userdata → reboot
```

- `fastboot flash vbmeta` verification-disabled (a self-built boot image never verifies against a stock vbmeta that chains `boot`; see below).
- `fastboot flash boot` — and on A13-launch devices also `fastboot flash init_boot` (kernel and ramdisk live in separate partitions there).
- `fastboot flash userdata userdata-luneos.img` — an ext4 image holding `rootfs.img` + `android-rootfs.img`.
- `userdata` must end up **unencrypted** (FBE is on by default from Android 10); flashing the prebuilt ext4 image satisfies this.
- Everything else stays stock. Reverting = reflash stock boot/vbmeta and wipe the files.

## vbmeta: flags 2 vs flags 3

```
avbtool make_vbmeta_image --flags 2 --padding_size 4096 --output vbmeta-disabled.img
```

sets flags 2, VERIFICATION_DISABLED only; it is what the mindphone kit ships, and it
boots. `fastboot --disable-verity --disable-verification flash vbmeta vbmeta.img` is
**not** equivalent: it sets flags 3 (HASHTREE_DISABLED | VERIFICATION_DISABLED), as the
radon and surya vbmeta images do. Prefer flags 3 (`--flags 3`, or the two fastboot
switches) for new kits. An empty unsigned AVB image (256-byte header, `algorithm_type 0`,
zero-padded to 4096) is trivially regenerable, so a kit can ship its own rather than
redistributing a vendor's. Whether a device needs a vbmeta at all, and how to read the
stock one: boot-images.md § AVB: does the stock vbmeta cover `boot`?

## Flash kits

Every fastboot kit has the same pure-fastboot shape — no `fastboot boot` + `adb push` dance:

| File | |
|---|---|
| `boot-<device>-luneos.img` | boot image (A13-launch: kernel only, ramdisk=0) |
| `init_boot-<device>-luneos.img` | A13-launch devices only: ramdisk only |
| `boot-<device>-luneos-debug.img` | kernel + ramdisk + `enable_adb`, for `fastboot boot` only |
| `userdata-luneos.img` | ext4 labeled `userdata` (~3.8 GB), with `rootfs.img` + `android-rootfs.img` side by side |
| `vbmeta.img` | stock copy flashed with verity/verification off, or a generated verification-disabled image |
| `install.sh` | vbmeta → boot [→ init_boot] → userdata → reboot |
| `make-userdata.sh` | rebuilds the userdata image after a rootfs rebuild |
| `luneos_<device>_<yyyymmdd>.tar.gz` | the whole kit, distributable |

Contents of the userdata image:

- `rootfs.img` — the deploy ext4 of `luneos-image-halium-arm64` (universal rootfs, ~2.6–3 GB).
- `android-rootfs.img` — the Halium GSI `system.img` (raw ext4, system-as-root). **The name matters** (`halium-boot.sh` checks `/tmpmnt/android-rootfs.img`), and the halium `file_layout` puts it **next to** `rootfs.img` on userdata. mindphone instead carries it inside `rootfs.img` and boots, so both layouts are in use (device-mindphone.md).

Rebuild command (adjust size):

```
mke2fs -q -F -t ext4 -L userdata -d <dir with rootfs.img> userdata-luneos.img 3600m
```

The small image **grows to the real partition size on first boot** — only with an
initramfs that carries the UFS resize fix (boot-images.md § The userdata-resize-on-UFS
bug). The alternative flow — `fastboot format:ext4 userdata`, `fastboot boot` the debug
image and `adb push` the two images into the mounted partition — still works and
sidesteps the resize path, since the format sizes the filesystem to the partition. Cut
kits from current bitbake images: the bitbake initramfs carries every fix the
flashed-userdata install relies on.

## Flash steps per layout class

The classes are defined in boot-images.md.

**A12-launch GKI (ramdisk in `boot`; e.g. bluejay):** vbmeta → boot → userdata → reboot.
One boot image.

**A13-launch GKI (`init_boot`; e.g. panther):** vbmeta → boot (our GKI kernel, no
ramdisk) → init_boot (our initramfs, kernel=0) → userdata → reboot. `vendor_boot`,
`vendor_kernel_boot`, `dtbo`, `super` stay stock.

**Legacy header v2, A/B, no custom recovery (e.g. mindphone):**

```
adb reboot bootloader            # or the device's key combo
fastboot flashing unlock         # once; needs the OEM-unlock toggle in Android; wipes data
fastboot flash vbmeta   vbmeta-disabled.img
fastboot flash boot_a   boot-luneos-<device>.img
fastboot flash boot_b   boot-luneos-<device>.img
fastboot flash userdata userdata-luneos.img
fastboot reboot
```

Flash **both** boot slots to keep A/B consistent.

## Other install routes

### MediaTek BROM/preloader: SP Flash Tool / mtkclient, no fastboot

Some MediaTek devices are flashed over the BROM/preloader link only — SP Flash Tool on
Windows, `mtkclient` on Linux — with no fastboot step and no `fastboot getvar` to
interrogate the device. Rules (found on radon, the FuriPhone FLX1s; see
device-radon.md):

- Write partitions **by name** (`mtk w <name> <file>`), never by offset (`wo`/`wf`): a
  wrong offset overwrites what follows, and on these SoCs that can include the
  preloader — the one genuinely hard-to-recover MediaTek brick.
- Partition sizes come from `mtk printgpt`; the active slot lives in `misc` and is
  unknowable from the host, so write both slots; unlock state is not exposed.
- **Read the vendor's own flash package before deciding a device needs no vbmeta** —
  a kernel package's "no vbmeta" setting says nothing about what the flash package
  writes.
- **Scatter-file sizes for the LAST partition are nominal** (`userdata` declared 3 GiB on
  MT6877 and MT6789 against far larger real partitions); treat a reported `userdata` at or
  below the nominal figure as suspect and ask, rather than refusing.
- **MTK lk does not verify the boot header's SHA-1 `id` field**; do not chase an `id`
  mismatch on a MediaTek device.
- `expdb` is the debugging channel when USB never comes up, readable over the same link
  (debugging.md § Stage 0); save a baseline from a healthy phone first.
- When no factory image is published, back up `boot_a`/`boot_b` before flashing; that
  is the only cheap way back.

### lk2nd (old Qualcomm devices with a Samsung or other locked SBL)

- lk2nd lives in the first 512 KiB of the boot partition and boots the real boot image
  from 0x80000. `fastboot flash boot` inside lk2nd writes behind it; `fastboot boot`
  RAM-boots and passes the previous bootloader's arguments on (including
  `androidboot.mode=charger`).
- **Never dd a boot image to the start of the partition** — it overwrites lk2nd. Keep a
  copy of lk2nd's 512 KiB; restore over Samsung Download mode with
  `heimdall flash --BOOT <lk2nd 512 KiB + boot.img>`.

Device detail (charger-mode boots on the Samsung SBL, the postinst that did overwrite
lk2nd): device-a3-2015-halium.md.

### Samsung Download mode (Odin, TWRP)

Samsung's lk speaks Odin only. What worked (found on SM-T220; see device-sm-t220.md):

- **Unlock once** via Developer options → OEM unlocking, then the Vol Up long-press at
  the Download-mode warning screen. The Knox bit is set.
- **Odin (`odin4` for Linux, built from `main`; the release fails multi-part files)** is
  fine for `boot` and `vbmeta` (unsigned header, verification-disabled flag); do not
  trust it for a multi-GB `userdata` (it left holes in the rootfs image).
  `SW REV CHECK FAIL: [userdata]` on the screen is cosmetic.
- **Boot partition from a running LuneOS:** `dd` the image to `boot`, read it back and
  compare checksums, keep a copy of the old partition.
- **Rootfs through TWRP:** `adb -s <serial> push` to `/data/rootfs.img.new`, verify the
  checksum on the device, then rename the current `rootfs.img` to `rootfs.img.prev` and
  the new file into place. Push over USB, not Wi-Fi ssh. Use `adb -s` always.

## Debug boot images

Every kit ships `boot-<device>-luneos-debug.img`; `fastboot boot` runs it without
flashing. Construction, the exceptions (MediaTek lk without `fastboot boot`) and the
boot-failure gadget: boot-images.md § Debug images.

## Anti-rollback (ARB) — read before flashing anything on a Pixel

Pixel bootloaders enforce anti-rollback: flashing a factory build older than the ARB level
on the device risks a **permanent brick**, including through the inactive-slot fallback, so
keep both slots consistent and never flash older than what is installed. The LuneOS boot
image pairs with a specific stock vendor build (kernel modules, cmdline, vendor HALs):
match the factory image you analysed to what is on the device, and redo the analysis if the
device is on a newer build. Device specifics: device-bluejay.md § Install,
device-panther.md § Install.

## Installer end state (not yet built)

`luneos-installer` (Python, host-side): detect the device (`fastboot getvar product`, `ro.product.device`, `ro.vndk.version` or `ro.vendor.build.version.sdk` — `ro.board.api_level` is a YYYYMM date on A15+ vendors — `ro.boot.slot_suffix`, boot header version from the stock boot.img) → look up `devices/<codename>/deviceinfo`; unknown devices get "generic GKI" mode (pull the stock boot/init_boot off the device, repack with the LuneOS initramfs, warn loudly) → download universal `rootfs.img`, `system-gsi-<vndk>.img`, boot images → flash vbmeta/boot/init_boot, format userdata unencrypted, push the two images → reboot.
