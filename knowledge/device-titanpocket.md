# Device: titanpocket (Unihertz Titan Pocket, MediaTek MT6771)

Unihertz Titan Pocket (`titanpocket`), MediaTek MT6771 (Helio P70), Tier B on its Android 11 vendor: boots to the UI with a source-built kernel; subsystems in bring-up.

The first kernel ever booted from its source tree: Unihertz publish no kernel source, and the Ubuntu Touch port for this phone still packs the stock prebuilt kernel. The tree is TheKit's reverse-engineered MediaTek ALPS 4.14. It is also the device that showed Tier B has an ABI to keep: a force-loaded stock Wi-Fi module panicked a kernel whose config had moved a struct (kmi-crc-matching.md § Struct layouts).

## Status (as of 6 Oct 2026)

| Area | State | Notes |
|---|---|---|
| Kernel boot, container | works (hardware) | |
| Display / UI | works | brightness was inverted until the CP2166 backlight fix |
| Keyboard | works | Pocket's own AW9523 key matrix (all 27 reported key pairs match); Fn acts as Ctrl |
| Touch | driver probes | Goodix GT1151QM |
| Wi-Fi | connects in the 5 Oct log | WPA handshake completed; a separate report of the AP rejecting the handshake is not explained |
| Bluetooth | `hci0` present | not tested further |
| Modem / telephony | `/ril_0` Powered | ofonod segfaulted on SIMs with an ISIM app (VoLTE SIMs); fixed in a separately shipped ofono build |
| Audio | fails | `module-droid-card` initialisation failed in the 5 Oct log |
| Camera | both sensors announced | "announcing 2 droid cameras"; no photo taken yet |
| Fingerprint | sensor detected | Sunwave, `read chip is ok: 0x8201`; enrol untested |
| NFC | untested since fix | polling restricted to NFC-A/B |
| GPS, charging | untested | battery driver registers |

## Platform facts

| Fact | Value | Source |
|---|---|---|
| SoC | MediaTek MT6771 (Helio P70), arm64 | `titanpocket.conf` |
| Display | 3.1" 716x720, 327 ppi | `titanpocket.conf` |
| Storage | UFS | |
| Android | 11 stock, vendor API 30 (VNDK 30); latest ROM `2024051420_g66v71c2k_dfl_tee` (14 May 2024) | |
| Partitions | dynamic (`super`), not A/B; boot partition 32 MiB | |
| Stock kernel | 4.14.186, prebuilt; no GPL source from Unihertz | |
| Input | AW9523 I²C keyboard matrix (4-row QWERTY), Goodix GT1151QM touchscreen | kernel tree |
| Panel / backlight | `R63308_CASCADEMDZ40` (reverse-engineered), CP2166 backlight (reads the display PWM inverted) | kernel tree |
| Cameras | rear ov16880, front ov8865 | kernel tree |
| Fingerprint / NFC | Sunwave (TEE, TrustKernel); ST21NFC (`android.hardware.nfc@1.2-service-st`) | |
| Product property | `ro.product.vendor.device` = `Titan_pocket` (names the adaptation directory) | luneos-device-config |
| ramoops (from lk's cmdline) | `mem_address=0x54410000 mem_size=0xe0000 console_size=0x40000 pmsg_size=0x10000` | kernel log |
| Key combos | fastboot: Volume Up while plugging in USB; BROM/preloader: Volume Down while plugging in | |

## Kernel

`linux-unihertz-titanpocket` (meta-unihertz, shared body in `linux-unihertz-alps-a11.inc` /
`linux-unihertz-mt6771.inc`): github.com/shr-distribution/linux branch
`unihertz-mt6771/4.14/halium-11.0`, SRCREV `8d83bc9a`, `KV = "4.14.186"`. The base is TheKit's
`halium-11.0` branch of github.com/ubuntu-touch-unihertz-titan/kernel-alps-mt6771 at
`ba3ad72c6c2d` (an AOSP `android-4.14-stable` tree plus one squashed ALPS drop from another
MT6771 OEM, with the device drivers recovered from the stock binary). The Titan Slim shares the
tree, the branch and the dtb; only the defconfig differs (`titanpocket_defconfig`, regenerated
from the phone's `/proc/config.gz`). Built with OE's GCC (15.3.0) instead of the clang r383902
the tree was written against.

LuneOS commits on the branch:

| Patch | Kind |
|---|---|
| 0001 demote 35 benign newer-GCC warning classes | plumbing: 80 Makefiles carry a bare `-Werror`; `strict-prototypes`, `pointer-to-int-cast`, `int-conversion`, `implicit-*`, `return-type` stay errors |
| 0002 drop bogus `inline` on `ksm_flock`/`blk_crypto_flock` | real bug: exported and called across translation units while declared `inline` (= `always_inline`) |
| 0003 remove the duplicate `set_selection` | real bug, exposed by `CONFIG_VT=y` (the Unihertz defconfigs disable VT); kept the copy that takes `sel_lock` |
| 0004 `lcm_init()` → `lcm_init(void)` | real bug in the panel driver |
| 0005 dpmaif pointer casts through `uintptr_t` | real bug: 64-bit pointers narrowed to `u32` in trace lines |
| 0006 eight K&R definitions given `(void)` | real bugs |
| 0007 `cmdq_pkt_get_curr_buf_va` returns `NULL`, not `-ENOMEM` | real bug: a `void *` function returning `-ENOMEM` |
| later | CP2166 backlight inversion; Sunwave fingerprint driver v2.2.38 (from Teracube; `CONFIG_SUNWAVE_FP=y`) with sensor detection enabled for TrustKernel phones as stock has it; ov16880 (from TheKit's Titan branch) and ov8865 (from Teracube) with the ov16880 EEPROM entry and the rear camera's AVDD on its GPIO-switched regulator as stock; the Pocket's own AW9523 key matrix (read from the stock kernel) and Fn as Ctrl |

Config: `luneos.cfg` (the standard delta, kernel-porting.md § The config delta) plus
`CONFIG_FRAME_WARN=4096` (GCC gives `mtk_battery_core.c` a 2144-byte frame) and
`CONFIG_DEBUG_INFO` off. `titanpocket_defconfig` names `ov16880_mipi_raw` and `ov8865_mipi_raw`,
which the base tree did not contain (it ships only `gc02m0`, `gc2375h`, `gc5035`); patch 0010
adds them and `titanpocket-imgsensor.cfg` lists them.

**Vendor modules.** The stock connectivity modules (`wmt_drv`, `wlan_drv_gen3`, `bt_drv`,
`gps_drv`, `fmradio_drv`) are force-loaded by the Android container
(`CONFIG_MODULE_FORCE_LOAD=y`, taint `FO`), so every option that changes a struct they use
must match stock. Kept at stock, with the measurement in kmi-crc-matching.md § Struct layouts
(config diff and the `kheaders.ko` layout probe, 1439 structs compared):

| Option | Struct | State |
|---|---|---|
| NETCONSOLE → NETPOLL, NET_POLL_CONTROLLER | `net_device`, `net_device_ops` | off |
| CGROUP_NET_PRIO | `net_device` (`priomap`) | off |
| BLK_CGROUP (→ CGROUP_WRITEBACK with MEMCG) | `inode` | off |
| CGROUP_PERF | `perf_event`, `perf_cpu_context` (used by `met.ko`) | off |

FANOTIFY (`user_struct` tail padding) and CGROUP_DEVICE (cgroup-core internals) stay on: the
probe shows those changes harmless here. All `mtk_wcn_*` imports resolve to `wmt_drv.ko`.
MODVERSIONS CRCs are useless as a check on this reconstructed tree (15–90 mismatches per
module, `printk` included).

### Rejected paths

- **NETCONSOLE as a debug channel.** It was in the first `luneos.cfg`; 22 s into every boot
  the container's force-load of `wlan_drv_gen3` panicked:

  ```
  mtk_wmtd_worker: Unable to handle kernel paging request at 0055aa8d704b2800
  pc : 0x55aa8d704b2800   lr : __dev_xdp_attached+0x48/0xa0
   rtnl_fill_ifinfo <- rtmsg_ifinfo <- register_netdevice <- register_netdev
   <- [wlan_drv_gen3] <- wmt_lib_init [wmt_drv]
  ```

  NET_POLL_CONTROLLER inserts three `ndo_*` pointers into `struct net_device_ops`, so the
  stock-laid-out ops table was read at the wrong offsets (kmi-crc-matching.md § NETCONSOLE
  and NET_POLL_CONTROLLER).
- **Instrumenting the initramfs to find that panic.** Five flash rounds showed nothing,
  because the panic came after switch_root. Reading ramoops out of DRAM found it in one read
  (Debugging below).

## Boot image

Header v2, MediaTek style, built by `kernel_android.bbclass`. Shipped image, verified against
stock:

| Field | Value |
|---|---|
| header version / page size | 2 / 2048 |
| kernel | 10,424,310 B @ `0x40080000`, gzip `Image.gz` |
| ramdisk | 6,650,204 B @ `0x55000000` |
| second | none, address `0x40f00000` |
| tags / dtb | `0x54000000` |
| dtb | 114,158 B, AOSP dt_table (`d7b7ab1e`, one entry of 114,094 B), md5 `1c0ec5e5c084e9bbb559ea99651a2e56` — byte-identical to stock, and to the Titan Slim's |
| os_version | ours 11.0.0 / 2022-03 (`0x16000163`); the 2024-05-14 stock boot.img carries 2022-09 (`0x16000169`); lk boots ours |
| cmdline | `bootopt=64S3,32N2,64N2 buildvariant=user log_buf_len=4M printk.devkmsg=on` |
| total | 17,192,960 B payload, then an unsigned AVB hash footer, padded to the 32 MiB partition |

- **Gzip is required in practice**: UBports' packer prefers `Image.gz`, and the UT adaptation
  gzips the stock kernel before packing, so that is what this lk has always been handed.
- **lk passes the header cmdline through**: `log_buf_len=4M` and `printk.devkmsg=on` arrive in
  `/proc/cmdline` (5 Oct log). No 20-character drop as on the G99.
- **AVB**: the stock vbmeta (SHA256_RSA2048, flags 0) chains `vbmeta_system` (location 2),
  `vbmeta_vendor` (4) and `boot` (3) to Unihertz's key, and the stock boot.img has its own
  signed footer. The kit flashes the stock vbmeta with flags 3; lk then logs the expected
  `HASH_MISMATCH`, `img_auth_required = 0`, orange state, and boots ours. The unsigned footer
  (`ANDROID_BOOTIMG_AVB_PARTITION_SIZE = "33554432"`, meta-android `lib/halium/avb.py`,
  byte-identical to `avbtool add_hash_footer`) matches stock's and UBports' shape.
- Not carried from the UBports cmdline: `security=apparmor`, `rodata=0` (only for inserting
  modules into the stock kernel), `init=/init`.

## Vendor and GSI

Stock Android 11 vendor (VNDK 30) → the generic Halium 16 GSI
`halium-luneos-16.0-20260910-1-halium_arm64`, the same file sargo, athena, q25 and radon run;
it carries `com.android.vndk.v30`, so no VNDK work was needed. Composer is HIDL
(`android.hardware.graphics.composer@2.1-service`). The phone keeps its own `vendor`, `super`,
`dtbo`, modem and firmware.

## Yocto

Layer `meta-unihertz` (Titan, Titan Pocket and Titan Slim; shared `unihertz-mt6771.inc`),
`MACHINE=titanpocket`. The machine builds only the boot image; the rootfs is the generic
`halium-arm64` one and the GSI travels beside it.

```
MACHINE=titanpocket bitbake initramfs-android-image
MACHINE=titanpocket bitbake linux-unihertz-titanpocket     # boot.img (kernel + initramfs)
```

Machine facts: `KERNEL_IMAGETYPE = "Image.gz"`, `SERIAL_CONSOLE = "921600 ttyMT0"` (no
debug UART is reachable without opening the phone), boot partition by-name under
`/dev/block/platform/bootdevice/by-name/`. `MACHINE_FEATURES` includes `keyboard-qwerty`,
`nfc`, `fingerprint` and no camera feature yet, although the kernel now builds both sensors.
Device adaptation: `luneos-device-config` `adaptations/Titan_pocket/sparse/etc/libncicore.conf`
(Tier 2).

## Install

Fastboot (bootloader must be unlocked). Kit: `boot-titanpocket-luneos.img`,
`boot-titanpocket-luneos-debug.img` (`enable_adb`), `boot-titanpocket-luneos-faillog.img`
(`initrd_log_fail initrd_log_part=cache`), `vbmeta-disabled.img` (stock vbmeta, flags 3),
`userdata-luneos.img` (5.0 GB ext4: `rootfs.img` + `android-rootfs.img`, grows on first boot),
`vbmeta-stock.img` and `boot-stock.img` for reverting, `dump-expdb.sh`, `make-userdata.sh`.

- `install.sh [--debug|--faillog]` checks `fastboot getvar product` and `unlocked`, then
  flashes vbmeta → boot → userdata (wiped) → reboot.
- `flash-boot.sh --normal|--debug` (default: faillog) updates vbmeta + boot only, keeping
  userdata.
- No `fastboot boot`: MediaTek lk frequently lacks it, so the debug image is flashed.
- Revert: `fastboot flash vbmeta vbmeta-stock.img`, `fastboot flash boot boot-stock.img`,
  `fastboot -w` (both from the 2024-05-14 ROM; an older firmware should use its own). If the
  phone does not enumerate, SP Flash Tool or mtkclient over the preloader: write `vbmeta`,
  `boot` and `userdata` only, never `preloader` (installing.md § MediaTek BROM/preloader).

## Subsystem notes

### Debugging this device

Nothing enumerates on USB when it bootloops, there is no pstore console to read afterwards,
and expdb's kedump region came back as zeros (twice) while lk's own log showed `lk boot
reason = 4` (`kernel_panic`, `exp_type 0x2`). What worked (method: debugging.md § MediaTek:
read ramoops straight out of DRAM over the preloader):

- `mtk da peek 0x54410000 0xe0000 --filename pstore.bin`, catching the preloader **while it
  bootloops** (holding Power or the Volume-Down BROM route from power-off loses DRAM). The
  console zone was at +0x4f000, pmsg at +0xd0000; the other ~80 4 KiB zones were empty
  dmesg-dump slots. pmsg showed the container up and surface-manager loading the vendor
  hwcomposer, so the rest of the port was healthy.
- `dump-expdb.sh` reads DRAM first, then `mtk r expdb,cache` in the same session, and decodes
  lk's `[AVB]` lines, the boot-image load, kernel panics, initramfs and `fs_mgr`.
- The faillog image logs to `cache` (debugging.md § Recording the initramfs to a spare
  partition). The first faillog `cache.bin` came back as untouched ext4: its logger started
  only after module load. With `initrd_log_part=` it starts right after `/proc`, `/sys` and
  devtmpfs. The empty record was itself the clue: the panic came after switch_root.

### `/cache` and the first bootloop

The first hardware boot started the container, which then died in `fs_mgr` (`mke2fs returned
256`, `failed to format cache`) and rebooted in a loop. The initramfs bind-mounted `/cache`
from userdata only when the mountpoint did not exist, and a GSI ships `/cache` as a real empty
directory (inode 17, mode 0770, `system:cache`), so the container's init tried to mount the
phone's own cache partition. Fixed in `initramfs-scripts-halium` patch 0004 (the `/proc/mounts`
test UBports carry in their Pocket/Slim adaptation); `dmesg | grep -i cache` shows
`bound /userdata/cache to /android/cache`.

### NFC

nfcd registers `nfc0`, but every `RF_DISCOVER` was answered `STATUS_REJECTED` ("[nci]
WARNING! > RF_DISCOVER_RSP error 1"): the ST21NFC refuses NFC-F. The Tier 2
`libncicore.conf` restricts polling to `Poll-A, Poll-B` (mer-hybris/nfcd-pn54x-plugin#5,
mer-hybris/libncicore#21); FeliCa cards will not read.

### Fingerprint

The Sunwave driver found the sensor once TrustKernel-phone detection was enabled; biomd then
asked 2 s after start, while the vendor service was still setting up its secure session, and
gave up for the boot. biomd now waits up to 30 s.

## Open issues

- Audio: `module-droid-card` fails to initialise.
- Camera capture, fingerprint enrol, NFC tag reads, GPS: untested.
- Wi-Fi: one report of a rejected handshake against a log that shows a completed one.
- Keyboard punctuation unverified: Qt reads only `EV_KEY`, never `MSC_SCAN` (as on q25), so
  audit what the driver reports.
- `MACHINE_FEATURES` lacks `camera-rear`/`camera-front`.
- Expect the display scaling (grid unit, device pixel ratio) to need tuning by eye in the
  Tier 1 adaptation, as q25's 720x720 did.

## Sources

- https://github.com/shr-distribution/linux/tree/unihertz-mt6771/4.14/halium-11.0
- https://github.com/ubuntu-touch-unihertz-titan/kernel-alps-mt6771
- https://github.com/ubuntu-touch-unihertz-titan/unihertz-titanslim-pocket
- https://github.com/NotKit/titanpocket-kernel-4.14
- https://github.com/mer-hybris/libncicore/issues/21
