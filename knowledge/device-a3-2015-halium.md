# Device: a3-2015-halium (Samsung Galaxy A3 (2015), MSM8916)

Samsung Galaxy A3 (2015) SM-A300FU (`a3-2015-halium`), 32-bit MSM8916, Tier B on the halium_arm 16.0 GSI via lk2nd: UI, modem, Wi-Fi, BT, audio, camera work.

A 2015 phone running the LineageOS 18.1 vendor (VNDK 30) of vlw's a3lte trees under the generic `halium_arm` 16.0 GSI, booted through lk2nd; kept next to the mainline machine `a3-2015`. Almost every fault was a generic gap this combination exposed: a 3.10 kernel too old for the GSI's assumptions (kernel-porting.md § Legacy 3.x kernels), a Samsung bootloader that boots into charger mode after every hard reset, a HAL1 camera, and the first VNDK 30 vendor in the legacy set (hal-userspace.md § Legacy Qualcomm vendors on the 16.0 GSI).

## Status (as of 8 Oct 2026)

Hardware-verified on an SM-A300FU unless marked otherwise.

| Area | State | Notes |
|---|---|---|
| Boot | works | through lk2nd; charger mode after a hard reset with cable (§ Subsystem notes) |
| Display / UI | works | three linker gaps fixed (§ Subsystem notes) |
| Modem | works | rmt_storage, qmuxd, rild run; modem and WCNSS ONLINE |
| Telephony | untested | end to end not tried |
| Wi-Fi | works | prima, real MAC from EFS |
| Bluetooth | works | `hci0` up and scans; controller keeps Qualcomm's default address (00:A0:C6:...) |
| Audio | works | |
| Flashlight | works | `rear_flash` nyx backend |
| Camera | works | preview, autofocus, still pictures; video recording untested |
| Battery | partial | gauge right; no current reading (rt5033 reports none) |

## Platform facts

| Fact | Value |
|---|---|
| SoC | Qualcomm MSM8916, 32-bit ARM kernel and userland |
| Boot chain | Samsung SBL, then lk2nd in the first 512 KiB of `boot`, which boots the real boot image from 512 KiB in |
| boot partition | 13 MiB |
| Adaptation | `ro.product.vendor.device=a3lte` (every model), so the adaptation directory is `a3lte`. LineageOS's `libinit_a3` does not run under the GSI, so the phone reports a3lte / SM-A300F and the LTE telephony props it sets from `ro.bootloader` are missing |
| Charger / gauge | rt5033 (no current reading), sec-battery; pack 1900 mAh (LineageOS power_profile.xml) |
| Wi-Fi / BT | WCNSS (pronto), prima built in (`CONFIG_PRONTO_WLAN=y`); no `BT_HCISMD`, so BT goes over the Android HAL and bluebinder |
| Camera | QCamera2 HAL1 behind LineageOS' Samsung camera wrapper, mm-qcamera-daemon; rear mounted at 90°, front at 270° |
| Flash LED | rt5033 flash driver, `/sys/class/camera/flash/rear_flash` only (no LED class device) |

## Kernel

vlw `android_kernel_samsung_msm8916-caf`, `lineage-18.1`, 3.10.108, 32-bit, `lineageos_a3_defconfig` + `luneos.cfg`; LuneOS branch `a3-2015/3.10/lineage-18.1` in shr-distribution/linux. The 3.4 build-fix include (`halium-kernel-3.4.inc`) applies as is. No syscall backports needed (renameat2, memfd_create, getrandom, seccomp present). No overlayfs, so `luneos-device-config` uses bind mounts.

Patches:

- `ARM: uaccess: keep put_user()'s value in r2`: GCC 15 put a constant in r3 and the `__asmeq` check stopped the build.
- Backport of upstream 790756c7e022 (Solaris-style `.section` flags current binutils rejects).
- `power: rt5033: stop flooding the kernel log on every property read`: journald fed on the gauge's per-read register dumps and never finished starting.
- `ARM: raise COMMAND_LINE_SIZE to 2048`: CONFIG_CMDLINE + boot image cmdline + the 775 bytes the SBL passes through lk2nd overflowed 1024; everything after `lcd_id` was lost (`androidboot.baseband`, `androidboot.mode`, `androidboot.serialno`, `mdss_mdp.panel`). Rule and tell: kernel-porting.md § Legacy 3.x kernels.
- `net: ipc_router: let group net_raw bind without paranoid networking`: `luneos.cfg` has `ANDROID_PARANOID_NETWORK` off (copied from sm-t520); the vendor `rmt_storage` drops to `setgid(AID_NET_RAW)` (3004) + `setuid(9999)` keeping only CAP_BLOCK_SUSPEND and relies on paranoid networking to pass the IPC router's bind check ("msm_ipc_router_bind: rmt_storage Do not have permissions"). Fixed by accepting group net_raw in `net/ipc_router/ipc_router_security.c` `check_permissions()` (kernel-porting.md § Config facts from the other distros).
- The tenderloin "mm: add MemAvailable to /proc/meminfo" commit, cherry-picked: without it memorymanager refused every launch ("Failed to reclaim required memory").
- `BT_HCIVHCI` and `RFKILL` in `luneos.cfg`.
- Debug aids still on the branch (lk2nd ramoops region and console copy, initcall trace, boot-progress bands painted into the splash framebuffer); bring-up only, to drop before release.

## Boot image

Header v0 with a QCDT table: dt size in the header word at offset 40, `dtFU.img` (SM-A300FU's own, from vlw/proprietary_vendor_samsung; other models need theirs, e.g. `dtH.img`) after the ramdisk, image id over all four sections, `SEANDROIDENFORCE` appended as LineageOS' mkbootimg writes it. Built by the kernel recipe's `a3_qcdt_bootimg` after kernel_android.bbclass and checked byte by byte; 11.2 MB against the 13 MiB partition.

## Vendor and GSI

LineageOS 18.1 `lineage_a3lte-userdebug` built in a Halium 11 tree and converted by halium-legacy-vendor (VNDK 30), under the plain `halium_arm` 16.0 GSI. Both are published in the `halium-luneos-20261005` release of webOS-ports/halium-images and fetched by `android-system-image-a3-2015-halium`: device tarball `halium-luneos-11.0-20261008-1-a3-2015-halium.tar.bz2`, GSI `halium-luneos-16.0-20261008-3-halium_arm.tar.bz2` (carries the linkerconfig VNDK 30 change and the minimediaservice thread pool; the A3 recipe pins it, the shared `android-system-image-legacy-gsi.inc` still names 20261007-1).

The converter moves the vendor fstab's apnhlos/modem/hidden mounts to `/vendor/firmware_mnt`, `/vendor/firmware-modem`, `/vendor/hidden`, and turns LineageOS's 124 `/system/etc/firmware` links into `/vendor/firmware` links, where the container's ueventd looks. SELinux labels of libraries added to the device image's `/system/lib` are not set (the build is permissive).

## Yocto

Layer `meta-smartphone/meta-samsung`, `MACHINE=a3-2015-halium`; status file `meta-samsung/conf/machine/a3-2015-halium-STATUS.md`. `qt6-qpa-hwcomposer-plugin` with patches 0002 and 0003 is the one to use (same version string as before, so reinstall with `--force-reinstall`).

## Install

lk2nd route (installing.md § lk2nd). `fastboot flash boot` inside lk2nd writes behind it; `fastboot boot` RAM-boots and passes the previous bootloader's arguments on, including `androidboot.mode=charger` when the SBL started in charger mode.

- **Nothing may `dd` a boot image to the start of the partition.** `android-kernel-bootimg`'s postinst did once, from a pending first-boot configure run by an unrelated `opkg install`; it now writes 512 KiB in when it finds lk2nd. Dry-run installs with `opkg install --noaction` and check `/var/lib/opkg/status` for unpacked packages.
- Keep a copy of lk2nd's 512 KiB. Recovery when `boot` is lost: Download mode and `heimdall flash --BOOT <lk2nd (512 KiB) + boot.img>`.

## Subsystem notes

**Boot loop (fixed).** The phone reset ~10 s after "Brought out of reset" (~33 s into boot), every boot: the modem lost its EFS and restart level SYSTEM reset the SoC (debugging.md § Stage 0). Two causes kept `rmt_storage` (EFS on `modemst1`, `modemst2`, `fsc`, `fsg`) from running: the cut cmdline left `ro.baseband=unknown` ("Remote storage service is not supported on unknown target"), and the IPC router refused it (both under § Kernel). Battery read 96-99 % throughout.

**Charger mode.** The SBL starts in charger mode (`androidboot.mode=charger androidboot.baseband=lpm`) from any PMIC hard reset with a cable: off-mode charging, long Power, lk2nd's `fastboot reboot`, and a plain `reboot` (msm-poweroff hard-resets without a reboot argument). Crash resets and reboots with an argument (warm reset, restart reason 0x12345678; `systemctl reboot --reboot-argument=normal`, systemd 257 ignores the old positional form) come up normal. With the cut cmdline LuneOS never saw the mode and booted in full on `baseband=lpm`. The initramfs must hold and charge in charger mode (Herrie82/meta-smartphone#6); its power-key reboot must pass an argument on this phone.

**Display: three gaps, each hiding the next** (hal-userspace.md § Display: three gaps, each hiding the next): `hwcomposer.msm8916.so` links framework libhwui, which needs `libft2.so` (`HALIUM_LEGACY_EXTRA_LIBS = "libft2.so"`); those framework copies then miss libbinder/libmedia symbols (`android::MetaDataBase::writeToParcel`; sm-t520's `HALIUM_LEGACY_SHIM_TARGETS`); `gralloc.msm8916.so` cannot load in sphal (`libqdutils.so` needs `libui.so`), so media.swcodec aborts ("gralloc-mapper is missing") — fixed in the GSI's linkerconfig, now for VNDK 28 and 30. `deviceinfo_force_hwc2` is set by analogy with the SM-T520.

**Wi-Fi.** prima starts on `echo sta > /sys/module/wlan/parameters/fwpath`, but only once the WCNSS control channel is up (`wcnss_version` stops reading INVALID); earlier writes fail with ENODEV after 12 s. `a3-prima-wlan.service` (meta-samsung systemd-machine-units) does it. The vendor's `hciattach` (init.qcom.bt.sh) must not be force-started at boot: it powers WCNSS up through the BT path before wcnss_service ("regulator get of riva_vddmx failed (-19)", "Failed to execute wcnss_wlan_power") and then neither Wi-Fi nor BT work; it is in `deviceinfo_android_skip_services` and the BT HAL starts it later (hal-userspace.md § WCNSS (pronto)). wcnss_service reads the real MAC from `/efs/wifi/.mac.info`.

**EFS and Bluetooth address.** LineageOS had no fstab line for `/efs`; the vendor image ships `/vendor/etc/fstab.efs`, which mount-android.sh mounts read-only at `/android/efs`. The BT HAL aborted ("Open: No Bluetooth Address!"): `ro.bt.bdaddr_path` comes from msm8916-common's system.prop (carried with `HALIUM_LEGACY_SYSTEM_PROP_PREFIXES`), and the address file is `radio:net_bt_stack 0640`, so `zz-a3-bluetooth-efs.rc` gives the HAL group 3008 by number (the 16.0 init no longer knows `net_bt_stack`). bluebinder patch 0004 (meta-luneos) reads the path under `/android` (hal-userspace.md § Samsung EFS and the Bluetooth address).

**Flashlight and battery.** Torch via `rear_flash`, and sec-battery's `charge_now` (which carries its charging mode, 1) is ignored by nyx; deviceinfo states 1900 mAh for full and design capacity (nyx-modules.md § Torch backends and battery readings that are not what they say). The battery really did run down during the boot loops on 500 mA USB.

**Camera, three layers** (hal-userspace.md § Camera HAL1): the provider service (`android.hardware.camera.provider@2.4-service`, built in the same Halium 11 tree, declared hwbinder via `HALIUM_LEGACY_BINDERIZED_HALS`) because LineageOS loads the provider in-process; the text-relocation shim for `libmmcamera_faceproc.so` (`zz-a3-camera-textrel.rc` preloads `libpermissioncache_shim.so` into the daemon and provider; without it "mct_stream_start_link ... Null" and a white preview; only three vendor libraries, all camera, have text relocations); five HIDL threads in minimediaservice (else `takePicture` deadlocks).

## Open issues

- Bluetooth address: controller keeps its default instead of the EFS one.
- `perfd` does not link (`__android_log_print` missing); harmless so far.
- Telephony end to end; video recording.
- Charger-mode reboots: LuneOS's own reboot should pass an argument.

## Device-specific traps

- Reboot from adb with `systemd-run --on-active=2 /bin/systemctl --force reboot --reboot-argument=normal`: a backgrounded command dies with the adb session, and a plain reboot lands in charger mode.
- A RAM-booted test image (`fastboot boot` in lk2nd) whose initramfs holds with an RNDIS telnet shell (`a3_hold` on the cmdline) reads battery and power-supply state without booting LuneOS.
- Found here and kept in debugging.md: logging a boot that dies before adb (§ Logging a boot that dies before adb), no `nsenter` into the container on a 3.x kernel and `debuggerd -b` for hung HALs (§ 2.7 Working the container by hand), busybox-vs-GNU (`dd` has no `conv=fsync` and writes nothing) and `pkill -f` matching your own command line (§ Tooling appendix).

## Sources

- https://github.com/vlw/android_kernel_samsung_msm8916-caf (branch `lineage-18.1`)
- https://github.com/vlw/proprietary_vendor_samsung
- https://github.com/webOS-ports/halium-images (release `halium-luneos-20261005`)
- https://github.com/shr-distribution/meta-smartphone (`meta-samsung`)
