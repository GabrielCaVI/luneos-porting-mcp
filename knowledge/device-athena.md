# Device: athena (BlackBerry KEY2, SDM660) — Tier B, and the boot-image window

BlackBerry KEY2 (`athena`, BBF100-8), Qualcomm SDM660, Tier B on a 4.19 kernel and a LineageOS 22 (A15) vendor; boots LuneOS to the lock screen.

The first SDM660 / BlackBerry target, and the port that produced the **boot-image window rule** in boot-images.md. A 4.19 kernel forked to `shr-distribution/linux` branch `key2/4.19` builds clean under Yocto with GCC 15; an Android-15 vendor serves a Halium 16 GSI with **zero VNDK work**, provided its kernel generation matches ours. An early splash hang coincided with the kernel overrunning the ramdisk load address — the overrun was real and is fixed, but was never shown to cause the hang: on this device the splash never clears, even on a working boot.

## Platform facts

| Fact | Value |
|---|---|
| Model | BlackBerry KEY2, **BBF100-8** (TCL), launched Jun 2018 |
| SoC | Qualcomm **SDM660**, arm64, Adreno 512 — `qcom,msm-id 0x13d`, `qcom,board-id 0xde000008` |
| Display | 4.5" **1080×1620** (3:2), ~433 ppi computed; LineageOS buckets it `TARGET_SCREEN_DENSITY := 384` |
| Stock Android | **8.1**, vendor API level 27 |
| Partitions | **non-A/B**, **no `super`**, real `recovery`; Qualcomm, so `/dev/block/bootdevice/by-name/*` exists |
| boot partition | 64 MiB |
| userdata | `fileencryption=ice` in stock fstab (Qualcomm ICE FBE) |
| Input | physical QWERTY `stmpe-keypad-bbry` (doubles as a trackpad); focaltech FT8707 **and** `synaptics_dsx_bbry` touch |
| Wifi/BT | `qcwcn` / WCN3990-class; `BOARD_HAS_QCA_FM_SOC := "cherokee"` |

**Variant warning:** SDM636 KEY2s exist (`msm-id 0x159`, board-ids `0xba000008` / `0xaa000008`) — the /e/OS boot image carries dtbs for two of them. The 4.19 tree has no dts for those, so an SDM636 unit has **no matching device tree at all**.

## The kernel

`tim-ecoder/android_kernel_blackberry_sdm660-4p19`, branch `lineage23.2-athena` — 4.19.325 with a real in-kernel Athena device tree (`sdm660-bbry-athena.dtsi`, camera dtsi, the BBRY input drivers). It is what the LineageOS 23.2 device tree selects (`TARGET_KERNEL_VERSION := 4.19`).

Released ROMs run both generations: /e/OS for athena is a **4.4** build (`4.4.302-Key2`, clang 19), while LineageOS 22 ships and boots **4.19.325**. `android_kernel_blackberry_sdm660` (4.4) is the fallback; 4.4 is no obstacle for Halium (tissot and mido are 4.9).

Forked as `shr-distribution/linux` `key2/4.19`. The tree had never been built with anything but clang, so GCC 15 + GNU Make 4.4 both needed work — see kernel-porting.md for the generic traps. **Seven of the findings were real bugs in code LineageOS ships today**, fixed at source rather than silenced:

| Fix | Bug |
|---|---|
| `tfa9911` | `tfa98xx_get_i2c_status_id_string()` returned a pointer to a stack buffer |
| `amrwb_in` | missing braces — `AUDIO_GET_AMRWB_ENC_CONFIG` always returned `-EFAULT` |
| `ipa2 rt` | `memset(tmp, 0, SIZE/4)` on a `u32[SIZE/4]` — cleared a quarter of the buffer |
| `ipa debugfs` | `sizeof(buf) < count + 1` with `size_t count` — wraps at `SIZE_MAX`, 10 sites |
| `qcom pil` | `*ss_valid_seg_cnt--` decremented the pointer, not the count |
| `crypto ice` | format string split across two lines with no continuation |
| `kgsl` | `dev_err()` passed an argument the format string never consumed |

Only `wlan.ko` (qcacld-3.0) is built as a module, and it is the one that matters. LineageOS 22 v1.21a does ship `/vendor/lib/modules/wlan.ko`, but it will not load: even with vermagic patched from `...-perf-g888495ee4a66` to ours, `insmod` gives

```
wlan: disagrees about version of symbol module_layout
```

`module_layout`'s CRC encodes `struct module` itself, so the configs genuinely differ. `CONFIG_MODULE_FORCE_LOAD` is not set and forcing it risks memory corruption. So the driver comes from our in-tree qcacld-3.0 build — which sidesteps the force-load/vermagic misery mindphone hit.

## Vendor and GSI — the Android-15 shortcut

Stock athena vendor is Android 8.1 / VNDK 27 and cannot serve an Android 16 GSI. The way out generalises well beyond this device:

> **Android 15 removed VNDK.** An A15 vendor image has no `ro.vndk.version` and no VNDK payload at all — just `ro.board.api_level=202404` and `ro.vendor.build.version.sdk=35`. So it needs **no VNDK snapshot ported into the GSI**, which is otherwise the expensive part (mindphone needed a v30 port).

**Use the LineageOS 22 (v1.21a) vendor — the vendor must match the KERNEL version, not just the Android version.** This is the fix that got graphics working. The /e/OS 4.1.1 A15 vendor (`e-4.1.1-a15-20260725-UNOFFICIAL-athena.zip`) and the LineageOS 22 vendor are both Android 15 (`ro.vendor.build.version.sdk=35`), so the zero-VNDK reasoning holds for both. But /e/OS athena is a **4.4-kernel** build and its Adreno blobs are 2018-era. Against our 4.19 kernel they abort:

```
E Adreno-GSL: ioctl_kgsl_device_getinfo_ext: Error -2 getting the IB_TIMEOUT property
W libEGL  : eglInitialize(...) failed (EGL_BAD_ALLOC)
   -> EGL Version -1.-1, EGL Error 3001 (EGL_NOT_INITIALIZED), grey screen
```

`KGSL_PROP_IB_TIMEOUT` is a 4.4-era ioctl. Both the LuneOS and LineageOS 4.19
kernels have byte-identical kgsl and neither serves it. LineageOS 22 v1.21a is
itself a 4.19 build and its `libgsl.so` (1,712,464 B vs /e/OS's 1,456,624 B)
contains the string `KGSL_PROP_IB_TIMEOUT not available at build time` - it
tolerates the absence. With the LineageOS 22 vendor:

```
EGL Version 1.5 / Available configurations: 68
```

**Rule: pick the vendor whose kernel version matches the kernel you boot.**
Android version parity is necessary, not sufficient.

Extracting it: the OTA ships `vendor.new.dat.br` (Brotli sparse dat) - Brotli
decompress, then apply `vendor.transfer.list`'s "new" commands into a flat image
(block size 4096, ranges are pairs `[a,b)`). Result 671,100,928 B,
md5 `da7ef852edc65bec207b6b2c71b30efb`. Flash it as-is, leave `system` alone,
loop-mount the GSI from userdata — sargo's shape, with **no vendor rebuild**.

The /e/OS vendor's `/vendor/etc/vintf/manifest.xml` was **53 HALs, every one `format="hidl"`**, `target-level="5"`; the LineageOS 22 vendor publishes several HALs on AIDL instead (see the status board). `target-level="5"` is FCM level 5 (Android 11) against an Android 16 framework matrix. That fails strict VINTF/VTS; Halium does not enforce them.

## Boot image and the kernel/ramdisk window

Header **v0**, page size **4096**, verified field-for-field against the shipping /e/OS image (not read out of the BoardConfig):

```
header_version 0    page_size 4096
base 0x00000000 + kernel_offset 0x00008000
ramdisk 0x01000000   tags 0x00000100   second 0x00000000
BOARD_KERNEL_IMAGE_NAME = Image.gz-dtb        (appended dtb, no dtbo.img)
```

The UBports Halium port for the Xiaomi Mi A2 (`jasmine_sprout`, also SDM660) uses an **identical** offset set, which is good independent confirmation. Its `deviceinfo` is worth keeping as the reference:

```
deviceinfo_flash_pagesize="4096"        deviceinfo_flash_offset_base="0x00000000"
deviceinfo_flash_offset_kernel="0x00008000"   deviceinfo_flash_offset_ramdisk="0x01000000"
deviceinfo_flash_offset_second="0x00f00000"   deviceinfo_flash_offset_tags="0x00000100"
deviceinfo_bootimg_header_version="0"         deviceinfo_bootimg_qcdt="false"
deviceinfo_kernel_cmdline="… selinux=0 console=tty0 …"
```

`second` is `0x00f00000` there and `0x00000000` in the real athena image — ours matches the device, theirs the BoardConfig default. `second_size` is 0 either way, so it does not matter.

**A real defect, not a proven cause.** The first flash hung at the BlackBerry splash, and the kernel image measured **24.9 MB** against a window of `0x01000000 - 0x8000 = 16,744,448 B` — a genuine violation, fixed. But the causal story (aboot writes the ramdisk through the middle of the kernel and jumps into wreckage) was never verified: **the splash on this device never clears**, so it looks the same for a dead kernel and a working boot, and the 24.9 MB image was never re-tested once that was known. The kernel that produced the 1406-line dmesg is the 13.1 MB one. For reference the stock 4.4 image is 13.76 MB and clears the window by 2.99 MB.

The pre-fix image is still reconstructible from the older `_deploy` sstate entry if anyone wants to settle it; nothing currently depends on the answer.

**8.07 MB of the 24.9 MB was 27 appended device trees, 26 of them for other sdm630/sda630 boards** — see kernel-porting.md for the `DTB_OBJS` glob trap that makes the trim config a no-op. The fix is the trim plus config slimming, **not** moving the ramdisk: `0x01000000` is proven on this bootloader by two independent working images, and swapping a verified address for an unverified one while debugging a boot failure is the wrong trade.

Size levers that mattered, in order:

| Lever | Saving |
|---|---|
| append only `vendor/qcom/sdm660-internal-codec-mtp-athena` instead of all 50 `dtb-y` entries | ~7.7 MB |
| `# CONFIG_IKHEADERS is not set` — the embedded kernel-headers tarball, Android-only | the largest single config item |
| `# CONFIG_KALLSYMS_ALL is not set` (keep `IKCONFIG` — `/proc/config.gz` is how mer-kernel-check gets run on the real config) | few hundred KB |
| `# CONFIG_FB_MSM_MDSS_XLOG_DEBUG is not set`, drop ISO9660/UDF | modest |

`CONFIG_DEBUG_INFO` is a red herring — debug info lives in `vmlinux`, not `Image`.

**Result, measured (19 Sep 2026):** `Image.gz-dtb` **24,903,202 → 13,146,188 B**, one
appended dtb instead of 27, ramdisk kept at the proven `0x01000000`. It now clears the
window by **3.60 MB — more margin than the stock 4.4 image has (2.99 MB)**, despite
being a 4.19 kernel. This is the image that produced the 1406-line dmesg.

The check itself is `kit/check-bootimg.sh` and it is worth running on every image:
it caught a dropped `ANDROID_BOOTIMG_RAMDISK_RAM_BASE` (silently defaulting the
ramdisk load address to 0x0) that the build reported no error for. See
device-bringup-yocto.md for why that change did not re-run `do_deploy`.

## Framebuffer console: tried, and it does NOT work here

**Disproven on hardware (20 Sep 2026). Do not repeat this reasoning.**

The idea was sound on paper: a retail KEY2 has no reachable debug UART, `CONFIG_FB_MSM`/
`FB_MSM_MDSS` are already in the stock defconfig, and `FRAMEBUFFER_CONSOLE` only depends
on `FB` — so `FRAMEBUFFER_CONSOLE=y` plus `console=tty0` ought to put the kernel log on
the panel. It was built that way and it does not happen:

```
[0.001449] Console: colour dummy device 80x25
[0.001465] console [tty0] enabled
[1.122001] mdss_fb_register: FrameBuffer[0] 1080x1620 registered successfully!
```

`fb0` registers fine at 1.12 s, the console is still the **dummy** device, and
`Console: switching to colour frame buffer device` appears **nowhere in 1406 lines** of
dmesg. `CONFIG_FRAMEBUFFER_CONSOLE=y` and `console=tty0` are both set.

The /e/OS and UBports builds carry `console=tty0` too, and it does not work for them
either: **enabling fbcon is not what is missing**.

Root cause not established. What has been ruled out, from the source at `key2/4.19`:

- `CONFIG_FRAMEBUFFER_CONSOLE_DEFERRED_TAKEOVER` is **not** set, so `deferred_takeover`
  is compiled to `false` and `fbcon_fb_registered()` should fall straight through to
  `do_fbcon_takeover()`.
- `mdss_fb_register()` uses `register_framebuffer()` (mdss_fb.c), which fires
  `FB_EVENT_FB_REGISTERED`.
- `fb_console_init()` runs from `fbmem_init` (`subsys_initcall`) and registers the fbcon
  notifier, so the notifier is in place well before fb0 appears at 1.12 s.
- `CONFIG_FRAMEBUFFER_CONSOLE_DETECT_PRIMARY=y` leaves `primary_device == -1` on arm64
  (no arch `fb_is_primary_device()`), which takes the `info_idx == -1` branch and should
  still reach takeover.

So the plumbing is present and the takeover silently does not occur. `dmesg | grep -i
fbcon` on the device is the next cheap probe.

**The consequence that actually matters:** on this phone the BlackBerry logo stays up in
*every* case — including a fully working boot with a live debug shell. The splash is not
a symptom. It carries no information about where boot got to, and any reasoning that
treats "stuck on the logo" as evidence of failure is unsound on this device. Use adb and
dmesg; the screen is not a debug channel here.

Related, and confirmed good: the kernel unpacks our ramdisk correctly —
`Trying to unpack rootfs image as initramfs... Freeing initrd memory: 15440K`.

## AVB: nothing to do, and nothing to extract

Worth recording because the instinct is to go hunting for OEM firmware. athena
launched on Android 8.1, so AVB 2.0 *exists* as an era — but this device tree does
not use it and the bootloader does not enforce it once unlocked. Four independent
checks, all cheap:

| Check | Result |
|---|---|
| `unzip -l <rom>.zip \| grep -i vbmeta` | nothing — the /e/OS package ships none |
| updater-script partitions written | `boot`, `system`, `vendor` only |
| `AVBf` footer / `AVB0` blob in its `boot.img` | neither — plain unsigned image |
| `BoardConfigCommon.mk` AVB/VERITY/VBMETA vars | none, on `lineage-22.2` or `lineage-23.2` |

Plus the empirical one: an unsigned LuneOS boot image was *accepted and executed*
by aboot (it ran and produced dmesg).

Generalises: before assuming a device needs a verification-disabled vbmeta, check
whether the community ROM that already boots on it ships or writes one. If it does
not, and its boot image carries no AVB footer, there is nothing to disable.

## Traps

- **The `merge_config.sh` comment trap.** A comment reading `# CONFIG_DUMMY=y  kept at the stock value` is parsed as a *directive* and silently unsets the symbol — `merge_config.sh` matches `^(# )?CONFIG_[A-Za-z0-9_][= ]`. Never start a comment line in a fragment with `# CONFIG_`. Cost an hour here.
- **Flash-kit directories on `/media` get cleaned.** The staging dir was wiped twice by disk cleanups. Keep the *scripts* on the root disk and treat the images as regenerable — the kernel recipe's `_deploy` sstate entry still holds the finished `.fastboot` boot image, so a wiped `tmp/deploy` costs an untar, not a rebuild.
- **`fastboot boot` is not the same test as `fastboot flash boot`** — RAM-booting uses fastboot's own load addresses, so it will not reproduce a load-address bug.
- **Bisect the boot image before adding logging.** A boot image built from a *known-good* kernel plus *our* initramfs (with `enable_adb`) separates kernel from initramfs in a single flash. On this device `enable_adb` makes the Halium initrd `panic` straight to its debug gadget before it looks for userdata, so a missing `rootfs.img` does not affect the test. **It is not single-variable:** the donor boot image brings its own command line. On athena the donor's lacked `selinux=0`, which was the actual bug, so the swap "exonerated the kernel" by changing the cmdline. Diff the two `Kernel command line:` lines before concluding anything; only a swap that *fails* is conclusive on its own.

## Findings from the boot (20 Sep 2026)

LuneOS boots to the lock screen on a BBF100-8: display, touch, power and volume
work.

### athena has no pstore, which is why this took so long

`CONFIG_PSTORE=n` in all four kernels inspected and there is no ramoops DT node.
With no UART on a retail unit and no working fbcon, **a failure before userspace
is completely mute**. Adding a ramoops node plus `PSTORE_RAM` would have turned
much of this investigation into one log read. Do this early on any device with
no debug UART.

### Input map

Seven nodes, and the touchscreen is not the obvious one:

| node | name | what |
|---|---|---|
| event0 | `qpnp_pon` | power |
| event1 | `touch_keypad` | capacitive keys - the old placeholder pointed here |
| event2 | `stmpe_keypad` | physical QWERTY |
| **event3** | **`synaptics_dsx_2`** | **touchscreen** |
| event4 | `qti-haptics` | vibrator |
| event5 | `nav_key` | navigation |
| event6 | `gpio-keys` | volume |

Pinned by name in the `athena` luneos-device-config adaptation.

### Editing files on the running device

`sed -i` fails with "Device or resource busy" - it renames. Use
`sed ... > /tmp/x && cat /tmp/x > <file>`, then `sync`. The rootfs is rw
(`/.writable_image` present), so `/etc` edits persist.

## Status board (20 Sep 2026)

**Boots to the lock screen.** Display, touch, power/volume keys, physical QWERTY.

| works | broken | cause |
|---|---|---|
| display, EGL | fingerprint | `biomd` is HIDL-only; vendor is AIDL |
| touch, keys, QWERTY | NFC | `nfcd` passes an AIDL-shaped name to a HIDL call |
| WiFi (with `wlan.ko` injected) | sensors | `sensors@2.0/@2.1` and the AIDL name both absent |
| Android container | Bluetooth | rfkill soft-block + BlueZ on the wrong `hci` |
| | camera | `announcing 0 droid camera(s)`; unresolved |

Whether fingerprint, NFC and sensors share one root cause is **unverified**: that
boot ran libgbinder on the API 31 preset against this A15 vendor (hal-userspace.md,
the A15 AIDL section). Resolve `ApiLevel` correctly (device-fajita.md § Android 15
vendors report a *dated* API level) and retest each before fixing them separately.
What stands regardless: HIDL-only `biomd` cannot use an AIDL-only fingerprint HAL.

### Kernel fixes that got it booting, in order

1. Remove `swiotlb=1` - fatal on 4.19, harmless on the stock 4.4.
2. Remove `selinux=0` - this is the one that fixed `mount(2)` returning ENOENT
   for every block-backed filesystem. Keep `androidboot.selinux=permissive`.
3. `# CONFIG_ARM64_USE_LSE_ATOMICS is not set` - kept because it matches the
   references, **not** because it fixed anything. It was credited with the mount
   fix for one commit; the same kernel with LSE enabled mounts ext4 correctly
   under Android's recovery ramdisk.

Both 2 and 3 shipped in one image, which is how the wrong one got the credit.

### NFC: the kernel is fine

```
nq-nci 6-0028: nfc_ldo_config: regulator entry not present   <- optional, returns 0
nq-nci 6-0028: nfcc_hw_check: - NFCC HW not Supported        <- default: arm, returns 0
nq-nci 6-0028: nqx_probe: probing NFCC NQxxx exited successfully
```

Reaching that chip-ID switch means the part answered NCI RESET over i2c, so it
is powered, addressed and talking. The recognised IDs are `NFCC_NQ_310`,
`NQ_330`, `PN66T`, `SN100_A`, `SN100_B`; athena's is not among them, which is
cosmetic. The real failure path is `err_nfcc_hw_check` / *"NFCC HW not
available"* / `-ENXIO`, and it does not appear. **Do not edit the device tree
for this** - a DT change was nearly made on the opposite reading.

Node paths, for reference: base `nq@28` is
`arch/arm64/boot/dts/vendor/qcom/sdm660-mtp.dtsi:62`; athena overrides only
pinctrl at `sdm660-bbry-athena.dtsi:887`.

### WiFi

`wlan.ko` comes from in-tree qcacld-3.0 and must be injected into `rootfs.img` -
see the generic-rootfs module section in kernel-porting.md. LineageOS 22's own
`wlan.ko` will not load (see The kernel), so ours is the only one.

Also `connmand: Unknown option WpaSupplicantConfigFile` - a dead key in LuneOS's
own `main.conf`; see deviceinfo-reference.md.

### Do not enable lxc@android

`android-system.service` starts the container (`lxc-start -n android … /init`)
and is enabled via `basic.target.requires`. `lxc@android.service` is a separate
unused unit; enabling it gives two units one container, and `lxc-start` exiting
*"Container is already running"* makes systemd run that unit's `ExecStop` and
tear down the healthy one. A `lxc@android.service: Failed with result 'timeout'`
in the journal is the tell.
