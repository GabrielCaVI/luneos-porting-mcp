# Device: bullhead-halium (LG Nexus 5X, MSM8992)

LG Nexus 5X (`bullhead-halium`), 64-bit MSM8992 on a 3.10 kernel, Tier B on the halium_arm64 16.0 GSI with a vendor derived from LineageOS 21: UI, Wi-Fi, sensors, camera HAL, NFC work; Bluetooth and the headphone jack in progress.

The first LineageOS 21 vendor (no VNDK) in the legacy set, and the first arm64 3.10 kernel. Brought up remotely, one test kit per round, with nobody here owning the phone. Almost everything that failed was generic and is filed under the general topics: what a LineageOS vendor's old Android did for it that the GSI does not (gsi-building.md § Before deriving), shipping fixes without a new vendor image (device-bringup-yocto.md § Shipping fixes through /odm), the 3.10 arm64 kernel gaps (kernel-porting.md § Legacy 3.x kernels) and Chromium against a 32-bit-address GPU (hal-userspace.md § Adreno 4xx on a 3.10 kgsl).

## Status (as of 11 Oct 2026)

Reported by the remote tester on an LGH790 (bootloader BHZ11h) unless marked otherwise.

| Area | State | Notes |
|---|---|---|
| Boot | works | TWRP-installed package; first boot slow (ldconfig alone 178 s) |
| Display / UI | works | after the webruntime low-4GB opt-out (§ Subsystem notes) |
| Wi-Fi | works | qcacld-2.0 built in; connects after the PMF kernel fix |
| Sensors | works | AOSP sensors service + VINTF override; started after the nanohub flash |
| Camera | HAL streams | daemon and provider run, 4032x3024 streams; LuneOS preview not confirmed |
| NFC | works | PN548 polls, a card was seen |
| Bluetooth | in progress | HAL registers and talks to the Rome SoC; `wcnss_filter` fix in round 12 |
| Headphone jack | in progress | pulse now in `input`; kernel events not yet seen |
| Modem | links | rild no longer crashes; telephony untested |
| Flashlight | untested | pmi8994 `led:torch_0` + `led:switch`; nyx's torch module handles that scheme |

## Platform facts

| Fact | Value |
|---|---|
| SoC | Qualcomm MSM8992: 4x A53 + 2x A57, Adreno 418 |
| CPUs used | the four A53s only (`nr_cpus=4`); the A57 cluster's PLL panicked the kernel |
| Kernel | 3.10, arm64, no loadable modules (`CONFIG_MODULES` off; qcacld-2.0 built in) |
| Adaptation | `ro.product.vendor.device=bullhead`; deviceinfo in meta-luneos `adaptations/bullhead` |
| Wi-Fi / BT | QCA6174 (qcacld-2.0, CNSS, PCIe) / Rome over UART `ttyHS0` |
| Sensors | nanohub sensor hub, flashed from `/vendor/firmware` at boot by `nanoapp_cmd download` |
| Audio | WCD9330 (tomtom) codec, `msm8994-tomtom-snd-card`; jack inputs "Headset Jack", "Button Jack" |
| NFC | NXP PN548 |
| Panel | 1080x1920, 65 x 115 mm per the DT (423 ppi, unverified) |

## Kernel

LineageOS 21's `kernel_lge_bullhead` (nexus5x-dev), 3.10; LuneOS branch `bullhead/3.10/lineage-21.0` in shr-distribution/linux, recipe `linux-lg-bullhead-halium` (meta-lg) with `halium_bullhead_defconfig`. The recipe lists every patch; the generic ones:

- `nr_cpus=4` on the command line; arm64 smp honours it as the possible-CPU limit, lpm-levels skips the A57 cluster, and the root cpuset's `cpus_requested` is clamped to the possible CPUs (else LXC could not create its cgroups).
- `execveat()` and `renameat2` for the arm64 glibc built for 4.9 (kernel-porting.md § Legacy 3.x kernels).
- No register dump for unimplemented syscalls (they filled the journal).
- `SECURITY_ANDROID_GID_CAPABILITIES` (Halium's commits from its halium-7.1 branch), `CHECKPOINT_RESTORE`, `FANOTIFY`, `BT_HCIVHCI`, the systemd cgroup controllers; MemAvailable; ipc_router bind for group net_raw (as on the Galaxy A3).
- `android_usb`: "ffs" taken as the first f_ffs alias (the gadget setup oopsed on the alias-less template).
- qcacld-2.0: no `WIPHY_FLAG_SUPPORTS_FW_ROAM` (the PMF fix, kernel-porting.md § Legacy 3.x kernels).
- kgsl: on an SVM `-ENOMEM`, print the process's mappings below 3 GB once (the diagnostic that found the Chromium reservation; kept).

## Boot image

Android boot image with `Image.gz-dtb`; `android-kernel-bootimg`'s postinst writes it to `boot` on first boot, so a new kernel needs a full package reinstall. ramoops survives a reset and TWRP reads it.

## Vendor and GSI

LineageOS 21 `lineage-21.0-20240911-UNOFFICIAL-bullhead.zip` (nexus5x-dev/OTA): monolithic, vendor under `/system/vendor`, built with `RELEASE_DEPRECATE_VNDK` (no `ro.vndk.version`, `HALIUM_LEGACY_VNDK = ""`). Converted by halium-legacy-vendor and published as `bullhead-halium-vendor.img` in the `halium-luneos-20261005` release; plain arm64 GSI `20261007-1`. The recipe rewrites `/system/etc/data/` to `/vendor/etc/data/` in place in netmgrd, qmuxd and libdsi_netctrl (and the qcril.db copy in init.bullhead.rc), so the plain GSI can be used.

Everything round 8 to 12 added on the Android side ships under the host's `/odm` (device-bringup-yocto.md § Shipping fixes through /odm), so the published image stays as it is: sensors and Bluetooth services and the VINTF fragment that makes them hwbinder, the camera's private library directory and shims, rild's private libbinder, LineageOS's shims for the RIL, ATFWD and cnd, the media APEX link for libdroidmedia. A new derive should do the vendor side with `HALIUM_LEGACY_LD_SHIMS`, `HALIUM_LEGACY_EXTRA_LIBS` and `HALIUM_LEGACY_BINDERIZED_HALS` instead (gsi-building.md § Before deriving).

## Yocto

Layer `meta-smartphone/meta-lg`, `MACHINE=bullhead-halium`; status file `meta-lg/conf/machine/bullhead-halium-STATUS.md`. `/etc/webruntime/no-low-4gb-reservation` and `/etc/android-host-apexes` come from `systemd-machine-units`; the `/odm` content from `android-system-image-bullhead-halium.bb`.

## Install

TWRP route: `fastboot boot` the official TWRP 3.7.0 image (RAM only, never flashed), which mounts `/data`; the LuneOS package goes to `/data/luneos` and the kernel to `boot`. `system`, `vendor`, the modem and the bootloader are never touched. Logs come back with a `collect-logs.sh` run from TWRP (journal, `lxc-android.log`, logcat files, tombstones, ramoops).

## Subsystem notes

**WebAppMgr and the browser** crashed on every start: Chromium's PartitionAlloc reserved the low 4 GB, and the Adreno 418's kgsl can only map below 3 GB (hal-userspace.md § Adreno 4xx on a 3.10 kgsl). Found with the kgsl diagnostic and `/proc/<pid>/maps` captures of WebAppMgr; fixed by the webruntime opt-out file.

**Wi-Fi.** qcacld-2.0 waits for `sta` in `/sys/module/wlan/parameters/fwpath` (`wlan-dynamic-start`, gated on the `cnss` platform driver), then the PMF fix.

**Sensors.** Three layers: the vendor's `flash-nanohub-fw` had no `user` (Android 16 init dropped it, the hub was never flashed, `nanohub_kthread: err_cnt` every second); the vendor has no sensors service; and the manifest says passthrough. All in hal-userspace.md § Sensors.

**Camera.** Daemon and provider need LineageOS 21's own system libraries and shims (hal-userspace.md § A LineageOS 21 vendor without VNDK); the HAL then streams. The LuneOS side got the media APEX mounts and the apexcodecs link in round 10; whether the preview shows is still to be reported.

**Bluetooth.** Service added and binderized; then `wcnss_filter`, force-started by start-android-hals, ate the controller's replies on the UART (hal-userspace.md § Bluetooth). An rc override did not stop the script (round 11); `deviceinfo_android_skip_services` in round 12.

**Headphone jack.** pulseaudio could not read the jack's input device (`pulse` was never in `input`, a generic bug now fixed in meta-luneos). The kernel arms MBHC with built-in calibration at card init; whether it reports a plug-in is the open question (round 12 carries an evtest script).

**Restart loops cost CPU.** In round 7 WebAppMgr restarting every 6 s and sensorfwd every second kept four A53s busy: touch was slow and sound repeated. Look for restart loops before blaming a slow port.

## Open issues

- Bluetooth (round 12 pending), the headphone jack, the camera preview in LuneOS.
- Telephony end to end; the flashlight; fingerprint (FPC1020) untried.
- The RTC/date reads 2025; waydroid waits 60 s for binderfs.
- ldconfig takes 178 s on first boot.

## Device-specific traps

- No `CONFIG_MODULES`: nothing to load, and no wlan module to name in the machine conf.
- The A57 cluster stays off (`nr_cpus=4`); the kernel patches that make `nr_cpus=` work are in § Kernel.
- The tester ends boots with the power key (`bootreason=oem_powerkey`); a crash shows up in ramoops, a power-key end does not.

## Sources

- https://github.com/nexus5x-dev/OTA (release `lineage-21.0-20240911-UNOFFICIAL-bullhead`)
- https://github.com/nexus5x-dev/kernel_lge_bullhead
- https://github.com/shr-distribution/linux (branch `bullhead/3.10/lineage-21.0`)
- https://github.com/webOS-ports/halium-images (release `halium-luneos-20261005`)
- https://github.com/shr-distribution/meta-smartphone (`meta-lg`)
