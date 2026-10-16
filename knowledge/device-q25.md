# Device: q25 (Zinwa Q25 / Q25 Pro, MT6789)

Zinwa Q25 / Q25 Pro (`Q25`), BlackBerry Classic restomod on MediaTek Helio G99 (MT6789), Tier A on MediaTek's mgk kernel: KMI-clean kernel and boot image build and run on hardware.

The first MediaTek Tier A target and the first LuneOS port onto a square screen
(3.5" 720x720, physical QWERTY and trackpad). It produced the method's sharpest
correction: **"GKI device" does not imply "an ACK kernel will do"** — MT6789 ships
MediaTek's *mgk* GKI derivative, an ACK build failed 344 of 344 stock vendor modules,
and the device's own tree failed 0 (kernel-porting.md § Step 1: Check that the stock
kernel really is GKI). Also the device behind "vermagic must match exactly when
busybox insmod loads the storage modules" (kmi-crc-matching.md § Step 0 — ask the
modules, they know) and "MACHINE_FEATURES-gated packages never reach the generic
rootfs" (device-bringup-yocto.md § The generic `halium-arm64` machine). Same SoC and
kernel generation as the MP01 (device-mp01.md).

## Status (as of 7 Oct 2026)

Hardware results below come from meta-zinwa's commits and the Q25 adaptation; the
phone ran a 3.9-day uptime by 6 Oct 2026.

| Area | State | Notes |
|---|---|---|
| Boot, container | works (hardware) | kernel and boot image KMI-verified 0/344, vermagic matching |
| Keyboard | works (hardware) | symbol layers, Sym-tap emoji key and BlackBerry-key-as-Ctrl patched into `bbqX0kbd`; toolbelt keycodes measured (Subsystem notes) |
| Trackpad scrolling | untested on hardware | kbdscroll reads relative pads now; never exercised on the device |
| Display / UI | runs | `deviceinfo_display_dpi=291`, `device_pixel_ratio=1.6` are arithmetic, untuned |
| Audio | partly | output gains set and measured in the codec log; **this unit's loudspeaker is dead in hardware** (silent under stock Android too); earpiece needs a local mixer append |
| IR transmitter | present | `/dev/lirc0` (`mtk-pwm-ir-tx`), `LIRC_CAN_SEND_PULSE`, read on the phone |
| Connectivity combo | running | `stp_dump3` stubbed (busy-looped at ~11,500 calls/s) |
| Wifi, BT, modem, camera, GPS, NFC, fingerprint, charging | not recorded | |

## Platform facts

From the device's LineageOS device tree (`LineageOS/android_device_xelex_Q25`,
`lineage-23.2`), its GPL kernel tree (`LineageOS/android_kernel_xelex_mt6789`), the
Droidian port, and the stock firmware (`OS-new-camera-0120-Q25-GMS.zip`, build
`SP1A.210812.016`, 20 Jan 2026 — see Install for where to get it).

| Fact | Value |
|---|---|
| Codename / vendor | `Q25` (capital Q; `ro.product.vendor.device=Q25` in `q20_v12_factory/vendor.prop`), `xelex`. Board name `q20_v12_factory` |
| SoC / GPU | MediaTek Helio G99 = **MT6789**, Mali (`ro.hardware.vulkan=mali`); EGL driver `libGLES_meow.so` (`ro.hardware.egl=meow`) |
| CPU | arm64, cortex-a76 + cortex-a55, armv8-2a |
| RAM / storage | 12 GB, 256 GB UFS (228 GiB userdata stock; the scatter nominally says 3 GiB) |
| Panel | 3.5" 720x720 IPS, `panel-q20-hd720-lcm-dsi-vdo.ko`. True 291 ppi; LineageOS ships density 193 |
| Stock Android | **12** (`SP1A.210812.016`): `ro.vndk.version=31`, `ro.board.first_api_level=31`, `ro.vendor.build.version.sdk=31`. The Android 14 *fingerprint* on system/product/odm is an attestation spoof |
| Kernel | `5.10.198-android12-9-gfcab0aff02db`, clang **r416183b** (12.0.5), `Image.gz` → KMI **android12-5.10 generation 9**. `CONFIG_MODVERSIONS=y`, `MODULE_SIG_FORCE` not set |
| Partitions | A/B, dynamic (`super` 9216 MiB), `metadata` 32 MiB. `init_boot_a/b` exist in the scatter (8 MiB) but are **unused** |
| AVB | enabled, boot rollback index 1, vbmeta + vbmeta_system + vbmeta_vendor |
| Console | `8250_mtk.ko` → `ttyS0`; no debug UART exposed; stock vendor_boot cmdline asks for `console=tty0` |
| Wi-Fi / BT | connac1x combo, `gen4m_6789`, control node `/dev/wmtWifi` |
| Modem | single SIM (`ro.telephony.sim.count=1`), VoLTE/VoWiFi props present; `q20v1_a_ulwctg_cogps` |
| SPL | 2024-03-05 |
| Vendor modules | **344 unique**: 180 in the vendor_boot ramdisk + 184 in `vendor_dlkm_a` (32.2 MiB, inside super). `/vendor/lib/modules` is an absolute symlink to `/vendor_dlkm/lib/modules`; connectivity modules are `insmod`ed from the vendor init rc, not `modules.load` |
| Camera | `imx111_mipi_raw` + `s5kjn1_mipi_raw` |
| Touch | `mtk_touchscreen_hodafonehw.ko`, the only touch device |
| Charging | mt6358_battery + hodafone_battery, upm6922/upm6722 chargers, mt6375 PD |
| Backlight IC | varies by unit: `ocp2131` early, `rt4831a` final (`ocp2131_drv.ko` ships) |

## Kernel

- **Tree:** `LineageOS/android_kernel_xelex_mt6789`, branch `lineage-23.2`, SRCREV
  `2a873a3511ee0eeead1442e60145093192a4535d` (5.10.198 — exactly the stock kernel's
  version), recipe `linux-zinwa-q25_git.bb`. Built with the device's own
  four-fragment config chain (`gki_defconfig` + `mgk_64_k510_defconfig` (646 lines,
  280 `CONFIG_MTK*`) + `entry_level.config` + `q20_v12_factory.config`) plus
  `files/luneos.cfg`; stock vendor_boot and vendor_dlkm stay, only the kernel is
  replaced. `LUNEOS_KERNEL_FRAGMENT = "0"` (passed with `bitbake -R`) builds the
  stock baseline — do that first whenever a KMI check fails.
- **Toolchain:** clang r416183b, the stock kernel's own version string, via
  `GKI_CLANG_DIR:q25` / `GKI_BUILD_TOOLS_DIR:q25` machine-scoped in local.conf
  (the unscoped values are android14-6.1's r487747c). `fetch-gki-toolchain.sh`
  fetches the prebuilts (~3 GB).
- **The bisect** (all against the 344-module set, `kmi-crc-check.py`):

  | Kernel | Result |
  |---|---|
  | ACK 5.10.250 (Halium fork) + `gki_defconfig` + droidian + LuneOS fragments | **344 of 344 would fail** |
  | device tree 5.10.198, device config chain, no LuneOS delta | **0 would fail** |
  | + an early LuneOS delta that also enabled `USER_NS` (and options LuneOS no longer sets) | **344 would fail** |
  | + LuneOS delta as shipped | **0 would fail** ← shipped |

  **KMI-poison on MediaTek mgk android12-5.10 / MT6789: `CONFIG_USER_NS`**, bisected
  only as part of a group, so its own share is unmeasured; it stays off. Clean:
  `PID_NS`, `CHECKPOINT_RESTORE`, `DEVTMPFS(+MOUNT)`, `FHANDLE`,
  `TMPFS_XATTR`/`POSIX_ACL`, `AUTOFS_FS`, `VT`, `QUOTA_NETLINK_INTERFACE`,
  `UEVENT_HELPER`, `STATIC_USERMODEHELPER=n`, the netfilter/PPP/L2TP block, the
  bluez/vhci set, `VETH`. LXC must not unshare the IPC or user namespaces.
- **Stock config** (IKCONFIG, 2,669 options): `mer_verify_kernel_config` gives 23
  errors / 54 warnings; 21 are covered by `luneos.cfg`, the other two are deliberate
  — `NET_L3_MASTER_DEV` off (`l3mdev_ops` in `struct net_device`, touched by every
  vendor wifi module) and `DUMMY` (checker quirk; keep Android's `y`). Other stock
  facts: `STATIC_USERMODEHELPER=y` (the fragment unsets it so `request_module()`
  works), `VT`/`BT_HCIVHCI` unset (the fragment sets both), `DEBUG_INFO_BTF` unset
  (no pahole), **`OVERLAY_FS=y`**, `ANDROID_BINDERFS=y`, `USB_CONFIGFS_RNDIS` and
  `ECM` both `y`, `CONFIG_MODULE_FORCE_LOAD` unset. Re-check the deployed
  `kernel-config` once (expect only the deliberate errors above).
- **Vermagic:** `files/vermagic.cfg` sets `CONFIG_LOCALVERSION="-android12-9-gfcab0aff02db"`
  with `LOCALVERSION_AUTO` off, and `do_configure:prepend` writes an empty
  `.scmversion` (else `setlocalversion` appends `+`). Merged unconditionally,
  including for the baseline. Without it the port would not have booted although
  every CRC matched: the storage and USB controllers (`ufs-mediatek-mod.ko`,
  `phy-mtk-ufs.ko`, `mtk-mmc.ko`, `musb_hdrc.ko`) are vendor_boot modules loaded by
  the initramfs's busybox `insmod`, which has no `--force-vermagic`. The tree
  produced `5.10.198-g2a873a3511ee` before the fix (kmi-crc-matching.md § Step 0 —
  ask the modules, they know).
- **ThinLTO:** `KERNEL_LTO_THIN = "1"` in q25.conf (the device config's
  `LTO_CLANG_FULL` makes the `vmlinux.o` link ~20 min of one core). Kernel 20.4 →
  16.0 MB, KMI-neutral, re-verified 0/344. Set `"0"` if a shipped image must match
  the vendor's codegen. Editing `luneos.cfg` at all, comments included, costs a full
  rebuild.
- **Command line:** `CONFIG_CMDLINE` carries what LuneOS needs (`console=tty0`, the
  cgroup-v1 pair; it also still carries `selinux=0`, see Open issues), because MediaTek's G99 lk drops the first 20
  characters of the boot-image cmdline (kernel-porting.md § The kernel command
  line). `ANDROID_BOOTIMG_CMDLINE` is `????????????????????log_buf_len=4M
  printk.devkmsg=on cgroup_disable=net_prio`; `net_prio` is disabled to pre-empt the
  deadlock measured on the MP01 (device-mp01.md § Kernel).
- **Own module:** the patched `bbqX0kbd.ko` (66 KB) goes into the initramfs
  (`ANDROID_EXTRA_INITRAMFS_IMAGE_INSTALL = "linux-zinwa-q25"`); `init.sh`'s
  `stage_our_kernel_modules()` copies `/usr/lib/modules/*.ko` over the vendor's
  real `/lib/modules/` before anything is modprobed, and `load_kernel_modules()`
  loads in the vendor's `modules.load` order (it is line 129 of 160). Look for
  `initrd: installed 1 of our own kernel modules over the vendor's` in kmsg. The
  module cannot be swapped on a running device: `rmmod bbqX0kbd` takes the kernel
  down. Rules: kmi-crc-matching.md § The initramfs route.
- **Not shipping the vendor's modules wholesale:** the CRCs already match 344/344,
  so nothing is gained, and on the MP01 (same SoC) embedding the 180 vendor_boot
  modules left lk no longer starting our init (device-mp01.md § Rejected paths).
- **Module audit:** our build produces 333 of the 344 stock modules. Missing:
  `met.ko` + 9 × `met_*_api.ko` (MediaTek tracing, absent from the tree) and
  `fpsgo.ko` (we build `mtk_fpsgo.ko` from `fpsgo_v3/`) — none matters. The
  `bbqX0kbd_main.o_shipped` next to the source is ignored: kbuild's `%.o: %.c`
  wins, and our module carries the stock binary's 43 text symbols. Mali's sibling
  Makefiles name `mali_mgm_$(MTK_PLATFORM_VERSION)` / `mali_prot_alloc_...` from an
  unexported variable, which produced `mali_mgm_.ko`; the recipe passes
  `MTK_PLATFORM_VERSION=mt6789` (kmi-crc-matching.md § The initramfs route).
- **5.10 kbuild traps** (`CROSS_COMPILE` for clang's target, `LLVM_IAS=1`,
  `PYTHON=python3`, `CROSS_COMPILE_COMPAT`) were found here and are general:
  kernel-porting.md § 5.10 kbuild gotchas.

### Rejected path: ACK android12-5.10

The first kernel was ACK from the Halium/Droidian fork
`gitlab.com/deathmist/kernel-android-common`, branch `common-android12-5.10-droidian`
(18 patches on ACK android12-5.10-lts @ 5.10.250), pinned at `da8ef85f`, with its
`droidian.config` over `gki_defconfig` and the LuneOS fragment on top — the kernel
the Droidian port runs. Its MT6789-relevant patches:

| Patch | Why it matters |
|---|---|
| gki_quirks: `find_get_pid` hook for `mali_kbase(_mt6789)` | with `PID_NS=y` the Mali driver's pid lookups must resolve globally; without it, no GPU |
| gki_quirks: `snd_soc_jack_report` hook for `mt6358_accdet` | headset detection on the MT6358 codec |
| binder: ignore `txn_security_ctx` | the usual Halium hwbinder-stability patch |
| bluetooth: don't send `READ_SYNC_TRAIN_PARAMS` | ditto for BT |
| module.c: force-load on symbol-version failure | escape hatch Droidian leans on |

`droidian.config` also enables options its own comments call *"ABI-breaking when
enabled for MT6789"* (`FANOTIFY`, `NF_TABLES`, `HUGETLBFS`,
`NETFILTER_XT_MATCH_NFACCT`; the wiki adds `CGROUP_PIDS` and `POSIX_MQUEUE`); LuneOS
keeps all six off. `mali_kbase_mt6789.ko` and `mt6358-accdet.ko`, the two modules
those quirks exist for, are in the `vendor_dlkm` half. **Rejected because it scored
344 of 344 stock modules failing**, `module_layout` included: the stock kernel has
`CONFIG_ARCH_MEDIATEK=y` and ~1,200 options `gki_defconfig` lacks, on a tree carrying
`drivers/misc/mediatek` and `drivers/gpu/mediatek` out of tree, so no ACK build
matches its CRCs.

## Boot image

Header **v4**, 64 MiB `boot`; kernel + **non-zero ramdisk** (stock: kernel
20,174,525 B, ramdisk 1,189,717 B), so the generic ramdisk rides in `boot`; no
`init_boot` (`ANDROID_BOOTIMG_INIT_BOOT = "0"`). Stock boot cmdline is **empty**
(`bootopt=...` is in vendor_boot's, which stays stock). `ANDROID_BOOTIMG_OS_VERSION =
"0x18000183"` reproduces 12.0.0 / 2024-03; never lower it. Both stock ramdisks are
**gzip**, which is what `initramfs-android-image` produces (unlike the MP01's lz4).
`gki_bootimg.bbclass` takes `GKI_KERNEL_IMAGE_NAME = "Image.gz"`.

vendor_boot (stock, untouched): 64 MiB, v4, one 18.9 MB gzip ramdisk fragment, dtb
184,000 B, cmdline `bootopt=64S3,32N2,64N2 buildvariant=user`, 180 early modules
incl. `bbqX0kbd.ko` and `8250_mtk.ko`.

Our image reproduces every stock header field except the sizes and the cmdline:
27,066,368 B with full LTO, **23,470,080 B (22.4 MiB)** for the current
ThinLTO image with the patched keyboard driver.

## Vendor and GSI

Android 12 vendor, VNDK 31 → the generic Halium 16 `halium_arm64` GSI
(`halium-luneos-16.0-20260910-1` carries `com.android.vndk.v31`); no VNDK-snapshot
work. MediaTek A12 vendor keys in the adaptation, carried over from the MP01 and also
found in radon's: `deviceinfo_force_hwc2="1"` (`ro.hardware.hwcomposer=mtk_common`),
`deviceinfo_hybris_prefer_vndk="1"` (verified here: the Q25's own
`/vendor/lib64/libnvram.so` imports `android::base::Basename(const std::string&)`,
which the 16 GSI's libbase no longer exports — without it pulseaudio crashes),
`deviceinfo_audio_sample_rate="48000"`, and
`deviceinfo_bluebinder_ext_features_page_2_mask="0x0400000000000000"` (the chip
claims Synchronization Train support and rejects the read, aborting hci init).

## Yocto

Layer `meta-smartphone/meta-zinwa`, `MACHINE=q25`; the rootfs is the shared
`MACHINE=halium-arm64` image — **not** a `luneos-dev-image` built for `MACHINE=q25`.

| File | Role |
|---|---|
| `conf/machine/q25.conf` | boot image only (like bluejay); `GKI_BOOTIMG = "1"`, `GKI_KERNEL_PROVIDER = "linux-zinwa-q25"`, `Image.gz`, header v4, cmdline, ThinLTO, `bbqX0kbd` in the initramfs |
| `recipes-kernel/linux/linux-zinwa-q25_git.bb` + `files/luneos.cfg`, `vermagic.cfg`, `0001`-`0003` keyboard patches | the kernel |
| `recipes-core/udev/udev-extraconf/70-q25.rules` | `Q25_keyboard` tagging; `wmtWifi`/`stpbt`/`stpgps`/`conninfra_dev`/`accdet` ownership; installed into the generic rootfs |
| `recipes-core/luneos-device-config/.../Q25-deviceinfo` | Tier 1: key devices, DPI, pixel ratio, toolbelt keys, mixer init, MediaTek keys; installed as `adaptations/Q25` + lowercase symlink |
| `recipes-core/android-system/.../stubbed-services-q25` | `stp_dump3` |

meta-android pieces it relies on: `luneos-bootimg-gki` (gated on `GKI_BOOTIMG`),
`GKI_KERNEL_IMAGE_NAME` in `gki_bootimg.bbclass`, and `/dev/mali0` 0666
`system:graphics` in `65-android.rules` (without it only root gets a GL context). nyx
selection is in `nyx-modules-machines.inc` (nyx-modules.md § Module selection: `nyx-modules-machines.inc`).
kbdscroll ships on the generic rootfs for `halium-arm64`/`halium-arm`, because a
package gated on `trackpad` in q25.conf could never reach this device
(device-bringup-yocto.md § The generic `halium-arm64` machine); its profiles are
selected at runtime by codename (`by-codename/q25.conf`).

```sh
MACHINE=q25 bitbake linux-zinwa-q25          # Image.gz + Module.symvers + kernel-config
MACHINE=q25 bitbake initramfs-android-image
MACHINE=q25 bitbake luneos-bootimg-gki       # boot-q25-luneos.img, -debug.img
MACHINE=halium-arm64 bitbake luneos-dev-image
```

## Install

Stock firmware: `drive.zinwa.com` redirects to a public Google Drive folder
(`Q25-P26-Q27-res`); take `OS-Images / Q25 / MassProduction / With-GMS /
OS-new-camera-0120-Q25-GMS.zip` (2.53 GiB, a full SP Flash Tool package with the
partitions' `.prop` files loose), not the OTA one. Direct download:
`https://drive.usercontent.google.com/download?id=14F9dbToL6euSiRKtBRJ_l6PGQYne0QNl&export=download&confirm=t`.
`extract-vendor-modules.sh` pulls the 344 modules out of vendor_boot and
`vendor_dlkm_a`; `lpunpack.py` is a minimal liblp reader for hosts without
`lpunpack`/`simg2img` (`debugfs -R rdump` then extracts without root).

Kit (`q25_20260930.zip`, 1.22 GiB):

| File | |
|---|---|
| `boot-q25-luneos.img` | 23,470,080 B; `kernel.release` = `5.10.198-android12-9-gfcab0aff02db`, patched keyboard driver |
| `boot-q25-luneos-debug.img` | `enable_adb` variant, flashed (not RAM-booted) |
| `userdata-luneos.img` | 4.2 GiB ext4 labelled `userdata`: `rootfs.img` (halium-arm64) + `android-rootfs.img` (Halium 16 GSI) side by side; grows on first boot |
| `vbmeta.img` | Zinwa's stock vbmeta |
| `install.sh`, `make-userdata.sh`, `README.md`, `SHA256SUMS` | |

- **No `fastboot boot` anywhere:** MediaTek's lk frequently does not implement it,
  so the debug image is flashed and the rootfs goes in as a prefilled `userdata`
  image (`fastboot flash userdata`, the route the Droidian port proves here).
- `install.sh` checks the lock state first (a locked MediaTek lk refuses critical
  partitions individually with "No support by lock control") and reports partition
  sizes (the scatter's 3 GiB `userdata` is nominal).
- A/B: Android keeps slot A, LuneOS takes slot B; switch with `fastboot
  --set-active=other reboot`. Slot B first needs the stock firmware (everything but
  `logo`, `super` and `boot_b`; the Q25 wiki has the list), then:

  ```sh
  fastboot --disable-verity --disable-verification flash vbmeta_b vbmeta.img
  fastboot set_active b
  fastboot flash boot_b   boot-q25-luneos.img
  ```

- Alternatives to the userdata image: a microSD partition (Droidian's default), or
  a `linux` partition carved with `mtkclient` and a wiki GPT blob.
- The GSI tarball in `DL_DIR` unpacks to a **raw** ext4 `system.img` — a rename,
  not a `simg2img`.
- Anti-rollback: unknown; assume it exists and never flash older firmware.

## Subsystem notes

### Keyboard

`drivers/input/keyboard/bbqX0kbd/` — Zinwa's fork of wallComputer's driver, I2C to
an RP2040 running solderparty `i2c_puppet` firmware; the source is published (the
Droidian wiki assumes otherwise).

- **One** input device, `Q25_keyboard`, carrying `EV_KEY`, `EV_REL` (`REL_X`/`REL_Y`)
  and `BTN_LEFT`/`BTN_RIGHT`: QWERTY, toolbelt keys and trackpad on one node, so key
  devices are pinned by name (`mtk-pmic-keys;mtk-kpd` for power and volume).
- `/proc/q20_switch_key_mouse`: `0` (default) = trackpad is a relative pointer, `1` =
  d-pad emulation. `/proc/q20_spec_power_flag`: `1` = wake on `Call end`, at some
  idle cost. `/proc/firmware_upgrade`: `1` then `2` while holding `Call end` = MCU
  mass-storage `.uf2` update; without holding it, "PC mode" over USB.
- `bbqX0kbd.ko` is in `modules.load.ramdisk`, so the keyboard works in the initramfs.
- The hardware reports uppercase ASCII scancodes; Android maps them via
  `MSC_SCAN` and `.kl`/`.kcm`, while Qt's evdevkeyboard reads only `EV_KEY`, and the
  stock driver's layer maps cover only digits (behind a latched num-lock) and
  navigation/volume — so stock gives Qt no punctuation. There is no per-device keymap
  route (`generate_qmap` emits a fixed table).
- **`0001-bbqX0kbd-Q20-symbol-layers.patch`** maps both layers to keycode + shift
  state from the diagram in `bbq20kbd_pmod_codes.h` (printed above = Alt, below =
  Sym); `q20_layers=0` restores stock. It declares the new keycodes in
  `input->keybit` (the input core drops undeclared keys), remembers what was emitted
  per scancode (so releasing Alt first does not leave a symbol held), injects
  `KEY_LEFTSHIFT` only when no physical shift is down, and stops reporting Alt and
  Sym (layer selectors, not modifiers).
- **`0002-bbqX0kbd-sym-tap-emoji-key.patch`**: Sym tapped alone (no other key between
  press and release) sends `KEY_EMOJI_PICKER`.
- **`0003-bbqX0kbd-blackberry-key-as-ctrl.patch`**: the keyboard advertises no Ctrl
  at all, so the BlackBerry logo key becomes `KEY_LEFTCTRL` (verified through Qt:
  `Qt::Key_Control` with `ControlModifier`, Ctrl+A/C/V reached a web app as DOM
  events). The phone therefore has no launcher key.
- Toolbelt, measured from the driver trace: Answer `0x06` → `KEY_SEND`
  (`Qt::Key_Call`); BlackBerry `0x11` → `KEY_LEFTCTRL`; Back `0x07` → `KEY_BACK`;
  Hangup `0x12` → `KEY_HOMEPAGE`, remapped with
  `deviceinfo_key_actions="Key_HomePage=call.hangup"` (ends a call, otherwise locks
  the phone); Mute (mtk-kpd) `KEY_MUTE`. Layout `deviceinfo_keyboard_layout="QWERTY"`.
- `keyd` (the Droidian port's `q25-qwerty`/`qwertz`/`azerty` configs) remains the
  deferred alternative for switchable layouts, one-shot modifiers and user-editable
  config; the driver route works in the initramfs and a TTY with no daemon or grab.

### Trackpad (kbdscroll)

The LuneOS shell scrolls under a finger, and the pad reports only relative
`REL_X`/`REL_Y` int8 deltas, so kbdscroll gained a relative mode: first movement
after stillness is touch-down, `rel-lift-ms` (120 ms) of stillness is lift, deltas
accumulate into a virtual surface (`rel-width`/`rel-height`, default the screen
size), and everything downstream is the absolute path's code. It does **not** grab
the device (the pad and the QWERTY are one node). `profiles/q25.conf`:
`cursor-modifier = rightalt` (Alt is the symbol layer) and `arrows = uinput`. Not run
on hardware; test with `kbdscroll --list` (is `Q25_keyboard` the pad, reported
`relative`?) then `kbdscroll --debug` (expect `relative contact down`, `touch at
x,y`, `relative contact up: N ms still`).

### Audio

The HAL routes through the audio DSP over `audio_ipi` and touches no ALSA control,
so the kernel leaves "Lineout Volume" at 0, the minimum of a -10..+8 dB range.
`deviceinfo_alsa_mixer_init="Lineout Volume=10,10;Headset Volume=10,10;Handset
Volume=10"` sets unity (index 10 = 0 dB); `mt6358` logs `set_speaker_gain()` with
the new value on each power-up, and the driver re-applies the cached control. This
unit's loudspeaker is dead in hardware, so the speaker level is unverified by ear.
"RCV Mux" is Open at boot and nothing switches it; on a unit with a dead speaker
append `;RCV Mux=Voice Playback;Handset Volume=14` locally to hear the earpiece.

### MediaTek connectivity

The mindphone-era `mtk-connectivity` approach transfers (mirror the vendor `.ko`,
load host-side, poke `/dev/wmtWifi`, fix `/dev/stpbt`; BT MAC from
`/mnt/vendor/nvdata/APCFG/APRDEB/BT_Addr`; the `/data/nvram` symlink; the
`fstab.<ro.hardware>` selection fix). Two things had to change for connac1x, both
found from the Q25's vendor partition (hal-userspace.md § MediaTek connectivity):

- `modules.load` lists only `connadp.ko` and `c2k_usb_f_via_gps.ko` of the family;
  the real drivers are `insmod`ed by the vendor rc — `wmt_drv.ko` and `connfem.ko`
  `on boot`, the rest behind `vendor.connsys.driver.ready=yes`, property-templated.
  `mtk-load-modules.sh` now derives the ordered list from the rc files:
  `connfem wmt_drv bt_drv_connac1x fmradio_drv_mt6631_6635 gps_drv_stp gps_pwr
  wmt_chrdev_wifi wlan_drv_gen4m_6789`.
- `mtk-connectivity-bt.service` required `bt_drv.ko` or `conninfra.ko`; the Q25 has
  `bt_drv_connac1x.ko` and no `conninfra.ko`, so it is now a glob.

The absolute `/vendor/lib/modules` → `/vendor_dlkm/lib/modules` symlink is fine:
`mount-android.sh` mounts `vendor_dlkm` at host `/vendor_dlkm` (checked on the real
images: `etc/build.prop` and `lib/modules/modules.load` present). Not carried over
from mindphone: `bluebinder`'s `mt6739-le-commands.conf` (a different controller);
`mtk-ril-watchdog` (mindphone-only in meta-greentouch) — the Q25's
`vendor.ril-daemon-mtk` has the same `oneshot` + `disabled` pair, so it is the fix if
telephony dies once and stays dead, but it would need moving to meta-android.

## Open issues

- Tune `deviceinfo_display_dpi` / `deviceinfo_device_pixel_ratio` on the square panel
  (1.875 trades width for height if 1.6 is too tight).
- Exercise kbdscroll on the device; check whether suppressing Alt/Sym loses any
  shortcut worth having.
- `mtk-kpd`'s input name comes from `KPD_NAME` in an unread header — confirm with
  `grep -h '^N: Name' /proc/bus/input/devices`.
- Re-tune "Lineout Volume" on a Q25 whose speaker works.
- Record the wifi, BT, modem, camera and charging results.
- `luneos.cfg`'s `CONFIG_CMDLINE` still carries `selinux=0`, against kernel-porting.md
  § selinux=0: do not pass it on a Halium port; drop it and rely on
  `androidboot.selinux=permissive`.
- Battery: if the phone powers off within a minute on a charger, check
  `/sys/class/power_supply/battery/capacity` (the MP01's symptom).

## Device-specific traps

Inherited from the Droidian port — check before calling any of these a LuneOS bug:

- Headset needs replugging if present at boot; the mic is always routed from the jack
  (kernel-workaround artefacts on Droidian).
- Hotspot needs `echo A > /dev/wmtWifi`, not the UI toggle.
- Signal strength is under-reported by the modem stack.

## Sources

- https://github.com/LineageOS/android_device_xelex_Q25
- https://github.com/LineageOS/android_kernel_xelex_mt6789
- https://wiki.lineageos.org/devices/Q25/
- https://github.com/JamiKettunen/droidian-zinwa-q25 (+ its wiki)
- https://gitlab.com/deathmist/halium-gki/-/tree/q25-droidian
- https://gitlab.com/deathmist/kernel-android-common/-/tree/common-android12-5.10-droidian
