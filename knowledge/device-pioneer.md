# Device: pioneer (Sony Xperia XA2, SDM630)

Sony Xperia XA2 (`pioneer`), Qualcomm SDM630, Tier B on LineageOS's 4.19 kernel and the phone's own LineageOS vendor (24.0, Android 17, first; 23.2, Android 16, as the fallback) with the Halium 16 GSI. Built host-side; never flashed.

The first Sony target, and the first port whose vendor (Android 17) is newer than the GSI (16.0). The kernel tree is unusually friendly: Sony's `common.config` already carries the `skip_initramfs` override, ramoops and a built-in qcacld-3.0, so three of the usual Tier B fights (boot-images.md § The `skip_initramfs` trap, no crash channel, `wlan.ko` CRCs) never start. Worth reading for a board file that disagrees with the shipped boot image, a shipped kernel that overruns its own ramdisk address, a vendor that reports the model number instead of the codename, and a clang build on an arm64 host.

## Status (as of 27 Oct 2026)

| Area | State | Notes |
|---|---|---|
| Kernel build | works | clang 19.1.1 standalone, then bitbake (§ Kernel) |
| Boot image | built | header verified field-for-field against the shipped LineageOS boot.img (§ Boot image) |
| Rootfs + kit | built | `luneos-dev-image` (halium-arm64) on an arm64 host; kit `luneos_pioneer_20261028.zip` (§ Install) |
| Boot | untested | |
| Everything else | untested | |

## Platform facts

Measured on an **H4113** running `lineage-24.0-20261015-NIGHTLY` (adb, 27 Oct 2026) unless marked; otherwise from the LineageOS wiki source (`lineage_wiki/_data/devices/pioneer.yml`) and `device/sony/nile-common`.

| Fact | Value |
|---|---|
| Models | H3113, H3123, H3133 (single SIM), H4113, H4133 (dual SIM); released Feb 2018. The H4113's cmdline carries `cei_simslot_id=dsds` |
| SoC | Qualcomm **SDM630**, 8× Cortex-A53 (ARMv8.0), Adreno 508; Ganges platform (`ARCH_SONY_GANGES`), `nile-common` in LineageOS |
| Display | 5.2" **1080×1920**, ~424 ppi computed; `TARGET_SCREEN_DENSITY ?= 420`; Truly TD4322 command-mode DSI panel (`mdss_dsi_td4322_truly_fhd_cmd` on the cmdline) |
| Launch Android | 8.0 (`ro.product.first_api_level=26`); Sony's last OTA is Android 9, and LineageOS requires that firmware first |
| Vendor | LineageOS 24.0: `ro.vendor.build.version.sdk=37`, `ro.board.api_level=202604`, no `ro.vndk.version` |
| Device identity | `ro.product.vendor.device=H4113` — the **model number**, not `pioneer` (§ Yocto) |
| Bootloader | Sony `xboot` (`1310-0301_X_Boot_SDM630_LA3.0_P_38`), unlocked: `verifiedbootstate=orange` |
| Storage | **eMMC** (`androidboot.bootdevice=c0c4000.sdhci`); `boot_a/_b` = `mmcblk0p38/39`, `vendor_a/_b` = `p70/71`, `system_a/_b` = `p78/79`, `userdata` = `p76` |
| Partitions | **A/B**, **no `super`**, recovery-as-boot, **no `vbmeta`** partition at all; userdata FBE (`ro.crypto.type=file`) under LineageOS |
| Active slot | `_b` on the measured unit |
| Kernel modules | none: no `/vendor/lib/modules`, `lsmod` empty |
| Wi-Fi / BT | `qcwcn`, BT 5.0; `WIFI_DRIVER_STATE_CTRL_PARAM := "/dev/wlan"` (the athena "ON" pattern; `wlan-dynamic-start` gates itself at runtime) |
| Fastboot | phone off, hold Volume Up, plug USB: LED turns blue |

**`/proc/cmdline` is four sources concatenated**, all accounted for: the kernel's `CONFIG_CMDLINE` (`cgroup_disable=pressure`), the dtb's `chosen/bootargs` (`rcupdate.rcu_expedited=1 core_ctl_disable_cpumask=0-7`, from `sdm630.dtsi`), the boot image's cmdline (nile-common's `BOARD_KERNEL_CMDLINE`, byte for byte), then xboot's additions — among them `root=/dev/dm-0 dm="system none ro,0 1 android-verity /dev/mmcblk0p79"`, `want_initramfs` and `androidboot.slot_suffix`. With an initramfs present the kernel ignores `root=` and `dm=`.

**No `skip_initramfs`.** xboot passes `want_initramfs` instead, so `INITRAMFS_IGNORE_SKIP_FLAG` is belt and braces here. It has a consequence for the initramfs: `init.sh` boots Android recovery when `skip_initramfs` is absent **and** `/recovery/init` exists. pioneer must therefore never add `initramfs-android-recovery` (tissot's `ANDROID_EXTRA_INITRAMFS_IMAGE_INSTALL`), or every boot goes to recovery.

## Kernel

`LineageOS/android_kernel_sony_sdm660`, **4.19.325**. `lineage-23.2` and `lineage-24.0` are the same commit (`ee6b64dc037d6003e3164d17b16e68cc6aa616ba`, 10 Oct 2026), and the phone runs exactly it (`4.19.325-cip136-st20-perf-gee6b64dc037d`), so one kernel serves both vendors. Config is the three fragments `device/sony/pioneer/BoardConfig.mk` names: `vendor/sdm660-perf_defconfig` + `vendor/sony/common.config` + `vendor/sony/pioneer.config`, then `luneos.cfg`.

**Already in Sony's `common.config`** (not repeated in `luneos.cfg`):

| Option | Why it matters |
|---|---|
| `INITRAMFS_IGNORE_SKIP_FLAG=y` | a `skip_initramfs` from the bootloader would be ignored (xboot does not pass one anyway, § Platform facts) |
| `PSTORE_RAM`, `PSTORE_CONSOLE` (deflate) | ramoops: a crash before the initramfs is recoverable from `/sys/fs/pstore` on the next boot (root needed) |
| `QCA_CLD_WLAN=y` | qcacld-3.0 is built in: no vendor `wlan.ko`, nothing to CRC-match |
| `BUILD_ARM64_APPENDED_DTB_IMAGE`, `IMG_GZ_DTB` | `Image.gz-dtb` |
| `PROC_CMDLINE_APPEND_ANDROID_FORCE_NORMAL_BOOT=y` | appends `androidboot.force_normal_boot=1` to `/proc/cmdline` for Android's first-stage init; inert for LuneOS |

**Appended DTB.** `arch/arm64/boot/Makefile` has the glob trap (kernel-porting.md § The appended-DTB glob trap), but `MACH_SONY_PIONEER` enables only `vendor/somc/sdm630-ganges-pioneer.dtb`, so exactly one blob is appended — the shipped image carries one too (309,033 B after the gzip stream). The `pioneer_dsds` dtb is not built, and the dual-SIM H4113 boots LineageOS on the single one.

**Toolchain: clang, built on an arm64 host.** LineageOS builds this kernel with Android clang **22.0.2** (r596125; the shipped banner), and on a Qualcomm tree GCC miscompiles the SCM call (kmi-crc-matching.md § Step 4), so the recipe reuses sunfish's clang wiring. Google's prebuilt clang is x86_64-only; on an aarch64 build host Ubuntu's `clang-19`/`lld-19`/`llvm-19` (19.1.1) work, via `GKI_CLANG_DIR:pioneer = "/usr/lib/llvm-19"`. Under clang the config turns on `LTO_CLANG` (ThinLTO) and `SHADOW_CALL_STACK`, as the shipped kernel has.

**One source fix:** `fs/notify/fanotify/fanotify.c` uses `old_memcg` without declaring it (a `set_active_memcg()` backport). LineageOS never enables `FANOTIFY`, so it only fails once a distro does; recipe patch `0001-fanotify-declare-old_memcg-in-fanotify_alloc_event.patch`. Nothing else failed with clang 19.

**Config delta (`luneos.cfg`)**: athena's fragment minus `SYSVIPC` (not needed), minus athena's LSE-off line, plus `UEVENT_HELPER`, `USB_CONFIGFS_ACM` and `# CONFIG_IKHEADERS is not set` (size table below). `NETCONSOLE`/`NETCONSOLE_DYNAMIC` are on: safe, since no vendor module loads at all. `LUNEOS_KERNEL_FRAGMENT = "0"` builds LineageOS's config verbatim as the control.

**Checked against the shipped IKCONFIG** (`IKCFG_ST` blob in the boot_b kernel, diffed with a merged `.config`): 61 symbols differ, 42 set by the fragment and 18 their dependency fallout (VT → `DUMMY_CONSOLE`/`HW_CONSOLE`, `NETCONSOLE` → `NETPOLL`, ACM → `U_SERIAL`, `CHECKPOINT_RESTORE` → `PROC_CHILDREN`, squashfs defaults). The last one was **`ARM64_LSE_ATOMICS`: on in the shipped kernel**, off in ours because the fragment had copied athena's LSE-off line. athena's reference ROM had LSE off; this one has it on, so the line was dropped. The rule in kernel-porting.md § LSE atomics is "match the reference ROM", and the reference is per device.

**Size**, `Image.gz-dtb`, against the shipped 19,927,413 B:

| Build | Size | |
|---|---|---|
| fragment, LSE off (standalone clang 19) | 19,822,973 B | |
| fragment, LSE on (bitbake) | 20,148,609 B | 221 KB over: refused by `do_deploy` |
| fragment, LSE on, **`# CONFIG_IKHEADERS is not set`** | **16,664,439 B** | shipped; 3.26 MB under |
| control: LineageOS config verbatim (`LUNEOS_KERNEL_FRAGMENT = "0"`) | 19,943,314 B | 15.9 KB over; kept only as an A/B baseline |

`IKHEADERS` is an xz tarball that does not shrink in `Image.gz`, which is why turning it off buys 3.5 MB; LuneOS has no eBPF tooling that needs it. The control build shows our clang 19 reproduces LineageOS's clang 22 kernel to within 0.08%.

## Boot image

**The shipped image disagrees with the board file**, and the shipped image wins (as on sunfish). boot_b, sha256 `662a5e0757fddfbb95cef20395beae8cc1d3d0d47bc4ce0562ea48b4d00c0810`:

| Field | nile-common BoardConfig | **shipped boot_b** |
|---|---|---|
| header / page | v0 (unset) / 4096 | v0 / 4096 |
| kernel | base 0x80000000 + 0x8000 | **0x80008000** |
| ramdisk | + `BOARD_RAMDISK_OFFSET` 0x02000000 | **0x81000000** |
| tags | + `BOARD_KERNEL_TAGS_OFFSET` 0x01E00000 | **0x80000100** |
| second | — | 0x00000000, size 0 |
| cmdline | `BOARD_KERNEL_CMDLINE` | identical |
| os_version | — | 17.0.0, patch 2026-10 |
| AVB | `BOARD_AVB_ENABLE := false` | no footer |
| ramdisk | | gzip, 16,579,685 B |

**The shipped kernel overruns its own ramdisk address**: 19,927,413 B from 0x80008000 ends at 0x81309175, 3 MB past 0x81000000, and the phone boots it daily. xboot relocates what it loads, as surya's ABL does (boot-images.md § The kernel/ramdisk window). The bound that is proven on this bootloader is therefore that kernel's size, not `ramdisk - kernel`: the recipe's `do_deploy` fails a header that differs from the table or a kernel larger than 19,927,413 B, and the kit's `check-bootimg.sh boot.img [stock boot.img]` does the same.

`ANDROID_BOOTIMG_*_RAM_BASE` take absolute addresses (tissot's convention), and the v0 path needs `ANDROID_BOOTIMG_EXTRA_ABOOTIMG_ARGS = "-c pagesize=4096"` (athena).

**Getting the stock image:** Developer options → "Rooted debugging", `adb root`, then `adb exec-out 'dd if=/dev/block/bootdevice/by-name/boot_b bs=1M' > boot_b.img`; compare `sha256sum` on both ends.

## Vendor and GSI

The phone's LineageOS vendor stays on `vendor_a`/`vendor_b`; nothing is extracted or flashed. Both candidate vendors are past Android 15, so neither needs a VNDK snapshot.

- **LineageOS 24.0 (Android 17), tried first.** The vendor is newer than the 16.0 GSI's framework — the reverse of every other port. Expected failure modes, none observed yet: vendor libraries needing LLNDK symbols Android 16's `/system` lacks (`dlopen` / `CANNOT LINK EXECUTABLE` in the container log), and an `ApiLevel` libgbinder has no preset for (hal-userspace.md).
- **LineageOS 23.2 (Android 16), the fallback.** Same kernel commit, so switching vendors is a LineageOS reflash and nothing else.

## Yocto

Layer `meta-smartphone/meta-sony` (new), `MACHINE=pioneer`. `conf/machine/pioneer.conf` (`VIRTUAL-RUNTIME_android-system-image = ""`: the GSI rides on userdata via `halium-gsi-image`, the q25 pattern; `PREFERRED_VERSION_android-headers-halium = "16.0%"`); kernel `recipes-kernel/linux/linux-sony-pioneer_git.bb` + `luneos.cfg` + the fanotify patch. The rootfs is `halium-arm64`'s.

**Adaptation directory = model number.** `luneos-device-config` keys adaptations by `ro.product.vendor.device`, which LineageOS's pioneer vendor sets to the Sony model (`H4113`), as OnePlus's does (`OnePlus6T/` for fajita). The real directory is `adaptations/H4113/` (measured); `H3113`, `H3123`, `H3133`, `H4133` are symlinks to it, assumed rather than observed. It pins the keys to `qpnp_pon;gpio-keys`, because derivation would also take `sdm660-snd-card-mtp Button Jack`, the headset buttons, which advertise volume keys. The touchscreen (`synaptics_dsx`, the only ABS device) derives. dpi 424, device pixel ratio 2.4 carried from sargo.

| node | name | |
|---|---|---|
| event0 | `qpnp_pon` | power, volume up |
| event1 | `s5712_sensor` | no keys |
| event2 | `SOMC USB Removal` | KEY 0xc2 |
| event3 | `gpio-keys` | volume down, camera focus/shutter |
| event4 | `synaptics_dsx` | touchscreen |
| event5 | `sdm660-snd-card-mtp Headset Jack` | |
| event6 | `sdm660-snd-card-mtp Button Jack` | headset keys, incl. volume |

```sh
export DISTRO=luneos MACHINE=pioneer; . ./setup-env    # export MACHINE: "MACHINE=x . ./setup-env" does not reach bitbake
bitbake linux-sony-pioneer halium-gsi-image             # boot image + GSI
MACHINE=halium-arm64 bitbake luneos-dev-image           # universal rootfs
```

Built on an Ubuntu 24.04 **arm64** VirtualBox guest on Apple Silicon (10 vCPU, 32 GB): wrynose parses with no warnings; the user-namespace sysctl `kernel.apparmor_restrict_unprivileged_userns=0` is required on 24.04. `input` group membership lets `adb shell getevent -p` list input devices without root, where `/proc/bus/input/devices` is denied.

## Install

First kit, 28 Oct 2026: `luneos_pioneer_20261028.zip`, 1,336,841,882 B, sha256 `0f48ea9b492458593c83ee8c97d22d63d973e72b50fb48bd21271ac70f51e98d`; `userdata-luneos.img` is 4.38 GB (rootfs.img 3.19 GB + the 1.06 GB GSI). The `luneos-dev-image` build reported 3 luna-service2 permission/wiring warnings (`do_validate_ls2_acg`, `do_validate_ls2_wiring`) from the generic image; check them if a service fails on the device.

A/B fastboot, no vbmeta step (no such partition). The kit (`luneos_pioneer_<date>.zip`) flashes `boot_a`, `boot_b` and `userdata-luneos.img` (`rootfs.img` + `android-rootfs.img`); `vendor_*`, `system_*` and firmware stay, and the active slot is not changed. `install.sh --debug` only `fastboot boot`s the `enable_adb` image (which does not exercise the load addresses, boot-images.md § Debug images). Rollback: the saved LineageOS `boot_b.img` to both slots, `fastboot -w`.

## Open issues

- First boot. If nothing enumerates, read ramoops (`/sys/fs/pstore`) from LineageOS afterwards.
- Android 17 vendor under the 16.0 GSI: untested.
- Whether the four symlinked model names are really what those models report.

## Sources

- https://github.com/LineageOS/android_kernel_sony_sdm660 (`lineage-23.2` = `lineage-24.0`)
- https://github.com/LineageOS/android_device_sony_nile-common, https://github.com/LineageOS/android_device_sony_pioneer
- https://github.com/LineageOS/lineage_wiki/blob/main/_data/devices/pioneer.yml
