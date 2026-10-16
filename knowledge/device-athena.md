# Device: athena (BlackBerry KEY2, SDM660)

BlackBerry KEY2 (`athena`, BBF100-8), Qualcomm SDM660, Tier B on a 4.19 kernel and a LineageOS 22 (A15) vendor; boots to the lock screen.

The first SDM660 / BlackBerry target. A 4.19 kernel forked to `shr-distribution/linux` branch `key2/4.19` builds under Yocto with GCC 15; an Android 15 vendor serves the Halium 16 GSI with no VNDK work, provided the vendor was built for the same kernel generation (kmi-crc-matching.md § Step 0). Worth reading for the boot-image window (boot-images.md § The kernel/ramdisk window — a build-time invariant), a `selinux=0` mount failure (kernel-porting.md § selinux=0: do not pass it on a Halium port) and a splash that never clears, even on a working boot.

## Status (as of 27 Sep 2026)

Hardware-verified on a BBF100-8 unless marked otherwise.

| Area | State | Notes |
|---|---|---|
| Boot | works | to the lock screen |
| Display / EGL | works | needs the LineageOS 22 vendor (§ Vendor and GSI) |
| Touch, power/volume, QWERTY | works | touchscreen is `event3`, not `event1` (§ Subsystem notes) |
| Touch-sensitive keys | declared | `keyboard-touch` in `MACHINE_FEATURES` installs kbdscroll; not verified on hardware |
| Wi-Fi | works | with our `wlan.ko` injected into `rootfs.img` |
| Audio | works | system sounds crackled on the FAST output; `pcm_output` now routed through `deep_buffer` (build-verified only) |
| Android container | works | |
| Bluetooth | broken | rfkill soft-block + BlueZ on the wrong `hci` (§ Subsystem notes) |
| Fingerprint | broken | `biomd` is HIDL-only; the vendor HAL is AIDL-only |
| NFC | broken | `nfcd` `registerForNotifications` fails; retest at the correct gbinder `ApiLevel` |
| Sensors | broken | no `sensors@2.0/@2.1` and no AIDL name in that boot; retest at the correct `ApiLevel` |
| Camera | broken | `announcing 0 droid camera(s)`; unresolved |
| Modem, GPS | untested | |

## Platform facts

| Fact | Value |
|---|---|
| Model | BlackBerry KEY2, **BBF100-8** (TCL), launched Jun 2018 |
| SoC | Qualcomm **SDM660**, arm64 (Cortex-A73/A53, ARMv8.0), Adreno 512 — `qcom,msm-id 0x13d`, `qcom,board-id 0xde000008` |
| Display | 4.5" **1080×1620** (3:2), ~433 ppi computed; LineageOS buckets it `TARGET_SCREEN_DENSITY := 384` |
| Stock Android | **8.1**, vendor API level 27 |
| Partitions | **non-A/B**, **no `super`**, real `recovery`; `/dev/block/bootdevice/by-name/*` exists |
| boot partition | 64 MiB |
| userdata | `fileencryption=ice` in stock fstab (Qualcomm ICE FBE) |
| Input | physical QWERTY `stmpe-keypad-bbry` whose keys are also a Synaptics touch surface (`touch_keypad`, 1080x525); focaltech FT8707 **and** `synaptics_dsx_bbry` touch |
| Wi-Fi / BT | `qcwcn` / WCN3990-class; `BOARD_HAS_QCA_FM_SOC := "cherokee"` |
| Debug channels | no reachable UART on a retail unit, no pstore (§ Kernel), fbcon does not take over: adb/gadget only |

**Variant warning:** SDM636 KEY2s exist (`msm-id 0x159`, board-ids `0xba000008` / `0xaa000008`); the /e/OS boot image carries dtbs for two of them. The 4.19 tree has no dts for those, so an SDM636 unit has **no matching device tree**.

## Kernel

Upstream `tim-ecoder/android_kernel_blackberry_sdm660-4p19`, branch `lineage23.2-athena`: 4.19.325 with an in-kernel Athena device tree (`sdm660-bbry-athena.dtsi`, camera dtsi, the BBRY input drivers), the tree the LineageOS 23.2 device tree selects (`TARGET_KERNEL_VERSION := 4.19`). Forked as `shr-distribution/linux` `key2/4.19`; recipe `linux-blackberry-athena_git.bb`, SRCREV `bc5d2089f85ea822e1311dfb581a80c514197074` (carries the `waitid(P_PIDFD)` backport, kernel-porting.md § `pidfd_open()` without `waitid(P_PIDFD)`). Released ROMs run both generations: /e/OS is a **4.4** build (`4.4.302-Key2`, clang 19), LineageOS 22 ships **4.19.325**. `android_kernel_blackberry_sdm660` (4.4) is the fallback.

**Toolchain.** The tree had only ever been built with clang; GCC 15 + GNU Make 4.4 needed the fixes in kernel-porting.md § Building a 4.19 CAF tree with a modern GCC and Make. Seven findings were real bugs in code LineageOS ships, fixed at source:

| Fix | Bug |
|---|---|
| `tfa9911` | `tfa98xx_get_i2c_status_id_string()` returned a pointer to a stack buffer |
| `amrwb_in` | missing braces — `AUDIO_GET_AMRWB_ENC_CONFIG` always returned `-EFAULT` |
| `ipa2 rt` | `memset(tmp, 0, SIZE/4)` on a `u32[SIZE/4]` — cleared a quarter of the buffer |
| `ipa debugfs` | `sizeof(buf) < count + 1` with `size_t count` — wraps at `SIZE_MAX`, 10 sites |
| `qcom pil` | `*ss_valid_seg_cnt--` decremented the pointer, not the count |
| `crypto ice` | format string split across two lines with no continuation |
| `kgsl` | `dev_err()` passed an argument the format string never consumed |

**Config delta (`luneos.cfg`), device-specific parts:**

- `CONFIG_BUILD_ARM64_APPENDED_DTB_IMAGE_NAMES="vendor/qcom/sdm660-internal-codec-mtp-athena"` with `CONFIG_IMG_GZ_DTB=y`. tim-ecoder's boot Makefile ignored that knob and appended every dtb (kernel-porting.md § The appended-DTB glob trap); the built image now carries one.
- `# CONFIG_IKHEADERS is not set`, `# CONFIG_KALLSYMS_ALL is not set`, `# CONFIG_FB_MSM_MDSS_XLOG_DEBUG is not set`, no ISO9660/UDF: size levers for the window (§ Boot image). `IKCONFIG` stays, so mer-kernel-check can run on `/proc/config.gz`.
- `# CONFIG_ARM64_USE_LSE_ATOMICS is not set`, to match the reference ROMs; it fixed nothing (kernel-porting.md § LSE atomics on ARMv8.0 SoCs). The same tree logs `can't patch jump_label` (`kernel/jump_label.c:385 __jump_label_update`) on every boot, working or not.
- `CONFIG_SECURITY_SELINUX_BOOTPARAM_VALUE` does not exist on this tree: it carries a backported 5.x LSM framework (kernel-porting.md § Fragment traps).
- `NETCONSOLE`/`NETCONSOLE_DYNAMIC` are on; safe here only because no prebuilt vendor network module loads (`wlan.ko` is ours). `FRAMEBUFFER_CONSOLE` is on and does nothing (§ Subsystem notes). `CONFIG_USB_CONFIGFS_ACM` is not in the defconfig, so the ACM console never appears; the gadget is RNDIS-only.
- **No pstore at all**: `CONFIG_PSTORE=n` in all four kernels inspected and no ramoops DT node. With no UART and no fbcon, a failure before the initramfs is mute. A ramoops node + `PSTORE_RAM` is the fix, but needs a carefully chosen reserved-memory region.

**Watchdog:** the Qualcomm watchdog driver is built in, and `CONFIG_QCA_CLD_WLAN=m` is the only module, so no boot step depends on a module load.

**Modules.** LineageOS 22 v1.21a ships `/vendor/lib/modules/wlan.ko`, but even with vermagic patched from `...-perf-g888495ee4a66` to ours it fails `disagrees about version of symbol module_layout`, and `CONFIG_MODULE_FORCE_LOAD` is not set. `wlan.ko` is built from the in-tree qcacld-3.0 and injected into `rootfs.img` (kmi-crc-matching.md § The rootfs.img injection route).

**Kernel cmdline fixes that got it booting**, in order:

1. Remove `swiotlb=1`: fatal on 4.19 before any console exists, harmless on the stock 4.4.
2. Remove `selinux=0`: with it, `mount(2)` returned ENOENT for every block-backed filesystem while tmpfs mounted and `fsck.ext4 -n` read the partition. Keep only `androidboot.selinux=permissive`. Evidence was a two-log comparison of identical kernel bytes:

   | | cmdline | dmesg | mount |
   |---|---|---|---|
   | our initrd | has `selinux=0` | no SELinux line at all | ENOENT |
   | Android recovery ramdisk | no `selinux=0` | `SELinux: Initializing.` | EXT4 mounts |

   No mechanism is confirmed. A denial would be EACCES, and with SELinux unregistered there should be no inode hooks. Suspect: the backported LSM framework (`CONFIG_LSM="..."`, `SECURITY_SELINUX_SIDTAB_HASH_BITS`, `SECURITY_LOCKDOWN_LSM` on 4.19; `BOOTPARAM_VALUE` replaced by a hardcoded `int selinux_enabled_boot __initdata = 1;`), where disabling the major LSM at boot may leave LSM blob offsets inconsistent.

LSE-off shipped in the same image as the `selinux=0` removal and was credited with the mount fix for one commit; the same kernel with LSE on mounts ext4 under Android's recovery ramdisk.

Current `ANDROID_BOOTIMG_CMDLINE` carries `androidboot.selinux=permissive printk.devkmsg=on console=tty0` after the stock Qualcomm tokens.

### Rejected paths

- **Kernel swap under a donor ramdisk "exonerated the kernel" twice.** Our 4.19 kernel under LineageOS's recovery ramdisk mounted `mmcblk0p77` (`EXT4-fs (mmcblk0p77): mounted filesystem with ordered data mode`) and reached `enforcing=1`, but only because the donor's cmdline lacked `selinux=0`. Method: debugging.md § Method.
- **Moving the ramdisk address to fit a bigger kernel.** `0x01000000` is proven on this bootloader by two independent working images; the fix was shrinking the kernel (§ Boot image).

## Boot image

Header **v0**, page size **4096**, verified field-for-field against the shipping /e/OS image, not read out of the BoardConfig:

```
header_version 0    page_size 4096
base 0x00000000 + kernel_offset 0x00008000
ramdisk 0x01000000   tags 0x00000100   second 0x00000000
BOARD_KERNEL_IMAGE_NAME = Image.gz-dtb        (appended dtb, no dtbo.img)
```

v0 with an appended dtb is boot-images.md § Header v0 with an appended device tree; `abootimg` needs `-c pagesize=4096` here. The UBports Halium port for the Xiaomi Mi A2 (`jasmine_sprout`, also SDM660) uses an identical offset set:

```
deviceinfo_flash_pagesize="4096"        deviceinfo_flash_offset_base="0x00000000"
deviceinfo_flash_offset_kernel="0x00008000"   deviceinfo_flash_offset_ramdisk="0x01000000"
deviceinfo_flash_offset_second="0x00f00000"   deviceinfo_flash_offset_tags="0x00000100"
deviceinfo_bootimg_header_version="0"         deviceinfo_bootimg_qcdt="false"
deviceinfo_kernel_cmdline="… selinux=0 console=tty0 …"
```

`second` is `0x00f00000` there and `0x00000000` in the real athena image; `second_size` is 0 either way. Do not copy their `selinux=0` (kernel-porting.md § selinux=0).

**The window.** `0x01000000 - 0x8000 = 16,744,448 B`. The first image was **24.9 MB** — a genuine violation, fixed — and the first flash hung at the splash. That the overrun caused the hang was never verified: the splash never clears on this device, and the 24.9 MB image was never retested once that was known. 8.07 MB of it was 27 appended device trees, 26 for other sdm630/sda630 boards. Levers, in order:

| Lever | Saving |
|---|---|
| append only `vendor/qcom/sdm660-internal-codec-mtp-athena` instead of all 50 `dtb-y` entries | ~7.7 MB |
| `# CONFIG_IKHEADERS is not set` | the largest single config item |
| `# CONFIG_KALLSYMS_ALL is not set` | few hundred KB |
| `# CONFIG_FB_MSM_MDSS_XLOG_DEBUG is not set`, drop ISO9660/UDF | modest |

Result: `Image.gz-dtb` **24,903,202 → 13,146,188 B**, one appended dtb, ramdisk at `0x01000000`, **3.60 MB** spare — more than the stock 4.4 image's 2.99 MB (13.76 MB kernel). That 13.1 MB kernel produced the 1406-line dmesg. The pre-fix image is reconstructible from the older `_deploy` sstate entry if anyone wants to settle the causal question.

The staging kit's `check-bootimg.sh` asserts the window and caught a dropped `ANDROID_BOOTIMG_RAMDISK_RAM_BASE` that silently fell back to the bbclass default `0x00000000`; restoring it then appeared to change nothing until `do_deploy` was forced (device-bringup-yocto.md § ANDROID_BOOTIMG_* changes do not always re-run do_deploy).

**AVB: nothing to disable.** Four checks: `unzip -l <rom>.zip | grep -i vbmeta` finds nothing in the /e/OS package; its updater-script writes only `boot`, `system`, `vendor`; its `boot.img` has no `AVBf` footer or `AVB0` blob; `BoardConfigCommon.mk` sets no AVB/VERITY/VBMETA vars on `lineage-22.2` or `lineage-23.2`. And aboot accepted and executed an unsigned LuneOS image. Rule: boot-images.md § AVB: does the stock vbmeta cover `boot`?

The kernel unpacks our ramdisk correctly: `Trying to unpack rootfs image as initramfs... Freeing initrd memory: 15440K`.

## Vendor and GSI

Stock vendor is Android 8.1 / VNDK 27 and cannot serve an Android 16 GSI. An A15 vendor has no `ro.vndk.version` and no VNDK payload (`ro.board.api_level=202404`, `ro.vendor.build.version.sdk=35`), so it needs no VNDK snapshot (architecture.md § Glossary, VNDK).

**Use the LineageOS 22 (v1.21a) vendor.** The /e/OS 4.1.1 A15 vendor (`e-4.1.1-a15-20260725-UNOFFICIAL-athena.zip`) is also SDK 35, but /e/OS athena is a 4.4-kernel build and its Adreno blobs abort against our 4.19:

```
E Adreno-GSL: ioctl_kgsl_device_getinfo_ext: Error -2 getting the IB_TIMEOUT property
W libEGL  : eglInitialize(...) failed (EGL_BAD_ALLOC)
   -> EGL Version -1.-1, EGL Error 3001 (EGL_NOT_INITIALIZED), grey screen
```

`KGSL_PROP_IB_TIMEOUT` is a 4.4-era ioctl; the LuneOS and LineageOS 4.19 kernels have byte-identical kgsl and neither serves it. LineageOS 22's `libgsl.so` (1,712,464 B vs /e/OS's 1,456,624 B) contains `KGSL_PROP_IB_TIMEOUT not available at build time` and tolerates the absence: `EGL Version 1.5 / Available configurations: 68`. Rule: kmi-crc-matching.md § Step 0 (the vendor must match the kernel version).

**Extracting it:** the OTA ships `vendor.new.dat.br`; Brotli-decompress, then apply `vendor.transfer.list`'s "new" commands into a flat image (block size 4096, ranges are pairs `[a,b)`). Result 671,100,928 B, md5 `da7ef852edc65bec207b6b2c71b30efb`. Flash it as-is, leave `system` alone, loop-mount the GSI from userdata.

**VINTF:** the /e/OS vendor manifest was 53 HALs, all `format="hidl"`, `target-level="5"` (FCM 5 = Android 11) against an Android 16 framework matrix; that fails strict VINTF/VTS, which Halium does not enforce. The LineageOS 22 vendor publishes on AIDL: `biometrics.fingerprint`, `nfc`, `wifi`, `wifi.supplicant`, `wifi.hostapd`, `power`, `vibrator`, `light`, `health`, `usb`, `usb.gadget`, `memtrack`, `media.c2`. Absent in that boot, asked for by HIDL name: `biometrics.fingerprint@2.1::IBiometricsFingerprint`, `sensors@2.0/@2.1::ISensors` (and the AIDL sensors name), `graphics.composer@2.2/2.3/2.4::IComposer`, `radio.config@1.2::IRadioConfig`. The rule: hal-userspace.md § Android 15 vendors are AIDL.

**gbinder:** the machine builds its own rootfs with `GBINDER_API_LEVEL` 35, but every athena kit shipped the shared halium-arm64 `rootfs.ext4`, so the device ran the API 31 preset. `luneos-device-config` now resolves the level at boot; the HAL retests above have not been run since.

## Yocto

Layer `meta-smartphone/meta-blackberry`, `MACHINE=athena`. Machine conf `conf/machine/athena.conf` (`MACHINE_FEATURES` include `keyboard-qwerty keyboard-touch nfc fingerprint camera-rear camera-front`; `PREFERRED_VERSION_android-headers-halium = "16.0%"`); kernel `recipes-kernel/linux/linux-blackberry-athena_git.bb` + `luneos.cfg`. The image is `tar.gz` only (no `ext4`).

```sh
MACHINE=athena bitbake linux-blackberry-athena    # kernel + boot image (<image>-athena.fastboot)
```

## Install

Non-A/B fastboot device. The kit's `install.sh` flashes `vendor` (the extracted LineageOS 22 image), `boot` and `userdata`; `system` is left alone and `userdata` carries `rootfs.img` + `android-rootfs.img` (installing.md). No vbmeta step (§ Boot image). Keep the kit's scripts outside any disk-cleaned area and treat images as regenerable: the kernel recipe's `_deploy` sstate entry holds the finished `.fastboot` image, so a wiped `tmp/deploy` costs an untar, not a rebuild.

## Subsystem notes

**Display / splash.** `FRAMEBUFFER_CONSOLE=y` + `console=tty0` do not put the log on the panel: `fb0` registers (`mdss_fb_register: FrameBuffer[0] 1080x1620 registered successfully!` at 1.12 s), the console stays `colour dummy device 80x25`, and `Console: switching to colour frame buffer device` appears nowhere in 1406 lines. Ruled out in the `key2/4.19` source: `FRAMEBUFFER_CONSOLE_DEFERRED_TAKEOVER` is not set; `mdss_fb_register()` uses `register_framebuffer()`; `fb_console_init()` registers the notifier at `subsys_initcall`; `DETECT_PRIMARY=y` leaves `primary_device == -1` on arm64 and should still reach takeover. Next cheap probe: `dmesg | grep -i fbcon`. The /e/OS and UBports builds carry `console=tty0` and are silent too. **The BlackBerry logo stays up in every case**, including a working boot with a live debug shell: it is not a symptom (kernel-porting.md § Framebuffer console as a Tier B debug channel).

**Input.** Seven nodes; the touchscreen is not the obvious one:

| node | name | what |
|---|---|---|
| event0 | `qpnp_pon` | power |
| event1 | `touch_keypad` | capacitive keys — the old placeholder pointed here |
| event2 | `stmpe_keypad` | physical QWERTY |
| **event3** | **`synaptics_dsx_2`** | **touchscreen** |
| event4 | `qti-haptics` | vibrator |
| event5 | `nav_key` | navigation |
| event6 | `gpio-keys` | volume |

Pinned by name in the `athena` adaptation (deviceinfo-reference.md § When the compositor starts but ignores the touchscreen).

**Wi-Fi.** `wlan.ko` from in-tree qcacld-3.0, injected into `rootfs.img` (§ Kernel). `connmand: Unknown option WpaSupplicantConfigFile` is a dead key in LuneOS's own `main.conf` (deviceinfo-reference.md § Dead configuration keys fail quietly).

**Bluetooth.** Two defects, both general (hal-userspace.md § Bluetooth):

```
bluebinder: Own hci index: 1
bluetoothd: Failed to set mode: Blocked through rfkill (0x12)
bluez adapter list: hci0 only, "powered":false
audiod: a2dpAdapterName = hci1, adapterName = hci0
```

Across one journal bluebinder took index 1 nine times, index 2 five times and index 3 once — never 0 — so BlueZ binds something else's `hci0`. And `systemd-rfkill` restores a saved soft-block every boot.

**Audio.** The HAL's FAST primary output runs 192-frame periods in a 384-frame (8 ms) buffer and underruns when the UI is busy (boot chime, volume keys crackle). `athena.conf` sets `WEBOS_PCM_OUTPUT_MASTER` so `pcm_output` uses `sink.deep_buffer` (1920-frame periods, 80 ms): UI sounds trade latency for no underruns.

**NFC.** The kernel side is fine:

```
nq-nci 6-0028: nfc_ldo_config: regulator entry not present   <- optional, returns 0
nq-nci 6-0028: nfcc_hw_check: - NFCC HW not Supported        <- default: arm, returns 0
nq-nci 6-0028: nqx_probe: probing NFCC NQxxx exited successfully
```

Reaching the chip-ID switch means the part answered NCI RESET over i2c. Recognised IDs are `NFCC_NQ_310`, `NQ_330`, `PN66T`, `SN100_A`, `SN100_B`; athena's is not among them, which is cosmetic. The real failure path (`err_nfcc_hw_check`, `NFCC HW not available`, `-ENXIO`) does not appear. **Do not edit the device tree for this** (debugging.md § Method, "read the return path"). Base `nq@28` is `arch/arm64/boot/dts/vendor/qcom/sdm660-mtp.dtsi:62`; athena overrides only pinctrl at `sdm660-bbry-athena.dtsi:887`. Userspace: `nfcd` logs `registerForNotifications(android.hardware.nfc.INfc/default)` failing, the same call as sunfish's stale-`ApiLevel` case; `hwservicemanager` (pid 34) served `android.hardware.camera.provider@2.4::ICameraProvider/legacy/0` in that boot, so HIDL transport was healthy (hal-userspace.md § Telling a routing bug from a missing backend).

**Fingerprint.** `servicemanager: Found android.hardware.biometrics.fingerprint.IFingerprint/default`, then `biomd: Failed to initialize HIDL fingerprint backend`: the HAL is alive, `biomd` has no AIDL backend (hal-userspace.md § Android 15 vendors are AIDL).

**Container.** `android-system.service` starts it; never enable `lxc@android.service` as well (device-bringup-yocto.md § mount-android.sh and the LXC container).

## Open issues

- Bluetooth `hci` index and rfkill (above).
- Fingerprint, NFC, sensors: whether they fail for one shared reason is **unverified** —
  that boot ran libgbinder on the API 31 preset against this A15 vendor (hal-userspace.md
  § The build-time setting cannot serve most devices, and once lied). Retest each with
  `ApiLevel` resolved correctly (hal-userspace.md § How it is handled now) before fixing
  them separately. Independent of the protocol, `biomd` needs an AIDL backend.
- `luneos.cfg` still sets `CONFIG_SYSVIPC=y`; LuneOS does not need it — drop it from the
  layer.
- Camera: `announcing 0 droid camera(s)`, not investigated.
- No pstore; fbcon takeover root cause unknown.
- Whether the 24.9 MB window overrun ever caused a hang (cheap to settle from sstate; nothing depends on it).

## Device-specific traps

- `sed -i` on the running device fails with "Device or resource busy" (it renames). Use `sed ... > <scratch> && cat <scratch> > <file>`, then `sync`. The rootfs is rw (`/.writable_image`), so `/etc` edits persist.
- `fastboot boot` does not reproduce a load-address bug (boot-images.md § Debug images).
- Bisect with a known-good kernel + our initramfs (`enable_adb`) before adding logging: on this device `enable_adb` panics to the debug gadget before userdata is looked up, so a missing `rootfs.img` does not affect the test. Diff the cmdlines (debugging.md § Method).
- A journal from a bring-up session must be sliced per boot: whole-file counts showed 954 `surface-manager` and 281 `keymaster-3-0` crashes, all in boots 1 and 4 and already fixed by the vendor swap, while the live `nfcd` registration failure fired once in all thirteen boots (debugging.md § Method).
- Never start a fragment comment line with `# CONFIG_` (kernel-porting.md § Fragment traps); it cost an hour here.

## Sources

- https://github.com/shr-distribution/linux/tree/key2/4.19
- https://github.com/tim-ecoder/android_kernel_blackberry_sdm660-4p19 (branch `lineage23.2-athena`)
- https://github.com/shr-distribution/meta-smartphone (`meta-blackberry`)
