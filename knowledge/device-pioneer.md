# Device: pioneer (Sony Xperia XA2, SDM630)

Sony Xperia XA2 (`pioneer`), Qualcomm SDM630, Tier B on LineageOS's 4.19 kernel and the phone's own LineageOS 24.0 vendor (Android 17) with the Halium 16 GSI; boots to the LuneOS UI with touch, sound, Wi-Fi, Bluetooth, camera, sensors and the modem.

The first Sony target, and the first port whose vendor (Android 17) is newer than the GSI (16.0). That inversion produced most of the bring-up work: a libc++ the GSI's copy is too old for, a library the vendor expects as LLNDK that the GSI does not export, and a keymaster that reads the boot header. Worth reading for those, for QMI over QRTR needing the host network namespace (which applies to every Qualcomm port), for vendor HALs that are alternatives rather than a set, and for a board file that disagrees with the shipped boot image. The kernel tree is friendly: Sony's `common.config` already carries the `skip_initramfs` override, ramoops and a built-in qcacld-3.0.

## Status (as of 28 Oct 2026)

Hardware-verified on an H4113 (dual SIM, FPC fingerprint sensor) unless marked.

| Area | State | Notes |
|---|---|---|
| Boot | works | first full boot 28 Oct 2026; adb on the normal image |
| Display / UI | works | needs the vendor libc++ (§ Vendor and GSI) |
| Touch | works | registers only after the panel powers on; hot-plugged (§ Yocto) |
| Keys | works | pinned `qpnp_pon;gpio-keys` |
| Screen on/off, brightness | works | power key; slider; auto-dim |
| Audio | works | speaker and mic measured; headset jack and earpiece present, untested |
| Wi-Fi | works | scan, WPA2 join, DHCP, IPv4+IPv6, DNS, HTTPS; needs QRTR in the container (§ Vendor and GSI) |
| Wi-Fi passphrase entry | fixed in build | the status-bar menu never showed a passphrase field (generic LuneOS bug, § Subsystem notes) |
| Bluetooth | works | pairing with a Mac, OBEX push Mac → phone (md5 checked); phone → Mac untested; A2DP untested |
| Modem | works | ONLINE, no crashes, EFS served; **no SIM inserted**, so registration, calls and data untested |
| Camera | works | 2 sensors, rear IMX300 5520×4144 and front 3264×2448 stills via droidcamsrc (§ Vendor and GSI) |
| Sensors | works | accelerometer, light, proximity, magnetometer, compass; no gyroscope in the hardware |
| Vibrator | works | |
| Torch | driven | sysfs switches correctly; LED not observed |
| GNSS | partial | HAL and location service up, NMEA flowing, 16 satellites in view from the almanac; no fix indoors, outdoor test pending (§ Subsystem notes) |
| Fingerprint | works to "waiting for finger" | enrolment reaches the TA; a full enrol + match needs a finger (§ Subsystem notes) |
| keymaster | fixed in build | needs the boot header's os_version (§ Boot image) |
| Battery indicator | fixed in build | batteryd recursed and segfaulted at the pinned SRCREV |
| Clock | works online | the PMIC RTC reads 1970; correct once the network sets it |
| Web apps | works without WebGL | WebAppMgr's GPU process cannot create a WebGL context (§ Subsystem notes) |

## Platform facts

Measured on an **H4113** running `lineage-24.0-20261015-NIGHTLY` (adb, 27 Oct 2026) and then LuneOS, unless marked; otherwise from the LineageOS wiki source (`lineage_wiki/_data/devices/pioneer.yml`) and `device/sony/nile-common`.

| Fact | Value |
|---|---|
| Models | H3113, H3123, H3133 (single SIM), H4113, H4133 (dual SIM); released Feb 2018. The H4113's cmdline carries `cei_simslot_id=dsds` |
| SoC | Qualcomm **SDM630**, 8× Cortex-A53 (ARMv8.0), Adreno 508; Ganges platform (`ARCH_SONY_GANGES`), `nile-common` in LineageOS |
| RAM | MemTotal 2,727,324 kB under LuneOS; the vendor's own init adds a 380 MB zram swap |
| Display | 5.2" **1080×1920**, ~424 ppi computed; `TARGET_SCREEN_DENSITY ?= 420`; Truly TD4322 command-mode DSI panel (`mdss_dsi_td4322_truly_fhd_cmd` on the cmdline) |
| Launch Android | 8.0 (`ro.product.first_api_level=26`); Sony's last OTA is Android 9, and LineageOS requires that firmware first |
| Vendor | LineageOS 24.0: `ro.vendor.build.version.sdk=37`, `ro.board.api_level=202604`, no `ro.vndk.version` |
| Device identity | `ro.product.vendor.device` reads **`pioneer` inside the LuneOS container** but `H4113` under LineageOS, whose init rewrites it per model at runtime (§ Yocto) |
| Bootloader | Sony `xboot` (`1310-0301_X_Boot_SDM630_LA3.0_P_38`), unlocked: `verifiedbootstate=orange`; `fastboot boot` works |
| Storage | **eMMC** (`androidboot.bootdevice=c0c4000.sdhci`); `boot_a/_b` = `mmcblk0p38/39`, `vendor_a/_b` = `p70/71`, `system_a/_b` = `p78/79`, `oem_a/_b` = `p68/69`, `userdata` = `p76` |
| Partitions | **A/B**, **no `super`**, recovery-as-boot, **no `vbmeta`** partition at all; userdata FBE (`ro.crypto.type=file`) under LineageOS |
| Active slot | `_b` on the measured unit |
| Kernel modules | none: no `/vendor/lib/modules`, `lsmod` empty |
| Wi-Fi / BT | `qcwcn` (WCN3990 through the modem's icnss), BT 5.0; `WIFI_DRIVER_STATE_CTRL_PARAM := "/dev/wlan"` (the athena "ON" pattern; `wlan-dynamic-start`) |
| Fingerprint | two HALs by sensor vendor: FPC (`fpc1035`, this unit) and Egistec (`et516`), selected by `vendor.hw.fingerprint` from `/proc/cei_fp_id` |
| Fastboot | phone off, hold Volume Up, plug USB: LED turns blue. From LuneOS: `systemctl reboot --reboot-argument=bootloader` (`adb reboot` does nothing there) |

**`/proc/cmdline` is four sources concatenated**: the kernel's `CONFIG_CMDLINE` (linux.inc's ` loglevel=3` plus halium-kernel.inc's cgroup-v1 switches; the tree's own `cgroup_disable=pressure` does not survive, so PSI is on, unlike stock), the dtb's `chosen/bootargs` (`rcupdate.rcu_expedited=1 core_ctl_disable_cpumask=0-7`, from `sdm630.dtsi`), the boot image's cmdline (nile-common's `BOARD_KERNEL_CMDLINE`, byte for byte, plus ours), then xboot's additions — among them `root=/dev/dm-0 dm="system none ro,0 1 android-verity /dev/mmcblk0p79"` and `androidboot.slot_suffix`. With an initramfs present the kernel ignores `root=` and `dm=`. `PROC_CMDLINE_APPEND_ANDROID_FORCE_NORMAL_BOOT` appends a fifth token, `androidboot.force_normal_boot=1`.

**xboot does pass `skip_initramfs`; `/proc/cmdline` hides it.** The kernel's own `Kernel command line:` line in dmesg carries `skip_initramfs`, while `/proc/cmdline` (and so adb's view) reads `want_initramfs` at the same position: Sony's skip-flag handling rewrites it. `INITRAMFS_IGNORE_SKIP_FLAG` (common.config) is what makes our initramfs run — keep it. Read dmesg, not `/proc/cmdline`, when checking what a bootloader passes. The rewrite has a consequence for the initramfs: `init.sh` boots Android recovery when `/proc/cmdline` lacks `skip_initramfs` **and** `/recovery/init` exists, so here it never sees the flag. pioneer must therefore never add `initramfs-android-recovery` (tissot's `ANDROID_EXTRA_INITRAMFS_IMAGE_INSTALL`), or every boot goes to recovery.

## Kernel

`LineageOS/android_kernel_sony_sdm660`, **4.19.325**. `lineage-23.2` and `lineage-24.0` are the same commit (`ee6b64dc037d6003e3164d17b16e68cc6aa616ba`, 10 Oct 2026), and the phone ran exactly it (`4.19.325-cip136-st20-perf-gee6b64dc037d`), so one kernel serves both vendors. Config is the three fragments `device/sony/pioneer/BoardConfig.mk` names: `vendor/sdm660-perf_defconfig` + `vendor/sony/common.config` + `vendor/sony/pioneer.config`, then `luneos.cfg`. Our release string is `4.19.325-cip136-st20`: linux.inc drops the tree's `-perf` LOCALVERSION; nothing loads modules by path.

**Already in Sony's `common.config`** (not repeated in `luneos.cfg`):

| Option | Why it matters |
|---|---|
| `INITRAMFS_IGNORE_SKIP_FLAG=y` | xboot's `skip_initramfs` is ignored, so our initramfs runs (§ Platform facts) |
| `PSTORE_RAM`, `PSTORE_CONSOLE` (deflate) | ramoops at `0xffc00000`: a crash before the initramfs is recoverable from `/sys/fs/pstore` on the next boot |
| `QCA_CLD_WLAN=y` | qcacld-3.0 is built in: no vendor `wlan.ko`, nothing to CRC-match |
| `BUILD_ARM64_APPENDED_DTB_IMAGE`, `IMG_GZ_DTB` | `Image.gz-dtb` |
| `PROC_CMDLINE_APPEND_ANDROID_FORCE_NORMAL_BOOT=y` | appends `androidboot.force_normal_boot=1` to `/proc/cmdline` for Android's first-stage init; inert for LuneOS |

**Appended DTB.** `arch/arm64/boot/Makefile` has the glob trap (kernel-porting.md § The appended-DTB glob trap), but `MACH_SONY_PIONEER` enables only `vendor/somc/sdm630-ganges-pioneer.dtb`, so exactly one blob is appended — the shipped image carries one too (309,033 B after the gzip stream). The `pioneer_dsds` dtb is not built, and the dual-SIM H4113 boots on the single one.

**Toolchain: clang, built on an arm64 host.** LineageOS builds this kernel with Android clang **22.0.2** (r596125; the shipped banner), and on a Qualcomm tree GCC miscompiles the SCM call (kmi-crc-matching.md § Step 4), so the recipe reuses sunfish's clang wiring. Google's prebuilt clang is x86_64-only; on an aarch64 build host Ubuntu's `clang-19`/`lld-19`/`llvm-19` (19.1.1) work, via `GKI_CLANG_DIR:pioneer = "/usr/lib/llvm-19"`. Under clang the config turns on `LTO_CLANG` (ThinLTO) and `SHADOW_CALL_STACK`, as the shipped kernel has. SCM works: PIL loads the modem, venus, adsp and the a508 zap shader, and QSEE reports `qsee_version = 0x1001000`.

**One source fix:** `fs/notify/fanotify/fanotify.c` uses `old_memcg` without declaring it (a `set_active_memcg()` backport). LineageOS never enables `FANOTIFY`, so it only fails once a distro does; recipe patch `0001-fanotify-declare-old_memcg-in-fanotify_alloc_event.patch`. Nothing else failed with clang 19.

**Config delta (`luneos.cfg`)**: athena's fragment minus `SYSVIPC` (not needed), minus athena's LSE-off line, plus `UEVENT_HELPER`, `USB_CONFIGFS_ACM` and `# CONFIG_IKHEADERS is not set` (size table below). `NETCONSOLE`/`NETCONSOLE_DYNAMIC` are on: safe, since no vendor module loads at all. `USB_CONFIGFS_ACM` is unused unless the initramfs's `USB_FUNCTIONS` lists `acm`; pioneer's debug gadget is RNDIS only. `LUNEOS_KERNEL_FRAGMENT = "0"` builds LineageOS's config verbatim as the control.

**Checked against the shipped IKCONFIG** (`IKCFG_ST` blob in the boot_b kernel, diffed with a merged `.config` using a small `config-diff.py`): every difference is a fragment symbol or its dependency fallout (VT → `DUMMY_CONSOLE`/`HW_CONSOLE`, `NETCONSOLE` → `NETPOLL`, ACM → `U_SERIAL`, `CHECKPOINT_RESTORE` → `PROC_CHILDREN`, squashfs defaults), plus the four values the classes write (`CMDLINE`, `LOCALVERSION`, `LOCALVERSION_AUTO`, waydroid's `ANDROID_BINDER_DEVICES`). The one surprise was **`ARM64_LSE_ATOMICS`: on in the shipped kernel**, off in ours because the fragment had copied athena's LSE-off line. athena's reference ROM had LSE off; this one has it on, so the line was dropped (kernel-porting.md § LSE atomics: match the reference ROM, per device).

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
| os_version | — | **0x220001aa**: 17.0.0, patch 2026-10 |
| AVB | `BOARD_AVB_ENABLE := false` | no footer |
| ramdisk | | gzip, 16,579,685 B |

**The shipped kernel overruns its own ramdisk address**: 19,927,413 B from 0x80008000 ends at 0x81309175, 3 MB past 0x81000000, and the phone boots it daily. xboot relocates what it loads, as surya's ABL does (boot-images.md § The kernel/ramdisk window). The bound proven on this bootloader is therefore that kernel's size, not `ramdisk - kernel`: the recipe's `do_deploy` fails a header that differs from the table (version included) or a kernel larger than 19,927,413 B, and the kit's `check-bootimg.sh boot.img [stock boot.img]` does the same.

**os_version is not cosmetic here: it is what keymaster checks.** With the class default 0, `keymaster-3-0` aborted every 5 s (`Invalid patch month 0`, `KeyMasterHalDevice: configure ... resp->status: -38`, "Configure failed"). The GSI's phh hook (`/system/bin/on-post-data.sh`, `fixSPL`) feeds keymaster the version and patch it reads back out of the **flashed** `boot_<slot>` partition (`getSPL`), and the keymaster TA accepts only a configure() matching what xboot passed TrustZone from the same header. So `ANDROID_BOOTIMG_OS_VERSION = "0x220001aa"`, the shipped value — never lower. Two traps on the way: a `fastboot boot` of a stamped image proves nothing, because `getSPL` still reads the flashed partition; and making the GSI's properties say 17 / 2026-10 does not help either while the header says 0 (both tried).

`ANDROID_BOOTIMG_*_RAM_BASE` take absolute addresses (tissot's convention), and the v0 path needs `ANDROID_BOOTIMG_EXTRA_ABOOTIMG_ARGS = "-c pagesize=4096"` (athena).

**Getting the stock image:** Developer options → "Rooted debugging", `adb root`, then `adb exec-out 'dd if=/dev/block/bootdevice/by-name/boot_b bs=1M' > boot_b.img`; compare `sha256sum` on both ends.

## Vendor and GSI

The phone's LineageOS 24.0 vendor stays on `vendor_a`/`vendor_b`; nothing is extracted or flashed. An Android 17 vendor needs no VNDK snapshot, but it is **newer than the 16.0 GSI** — the reverse of every other port — and four things followed from that or from the container, all fixed at runtime in `mount-android.sh` (meta-android) unless marked:

**1. libc++: no UI without the vendor's copy.** surface-manager aborted on `cannot locate symbol "_ZNSt3__113__hash_memoryEPKvm" referenced by "/android/vendor/lib64/libgralloccore.so"`, then `Cannot find EGLConfig` / EGL error 0x3001. The vendor ships its own `libc++.so` (1,154,016 B) that exports `std::__1::__hash_memory`; the GSI's (1,109,112 B) does not, and libhybris, which has no linker namespaces, loads one copy per soname — the GSI's, pulled in first. When the vendor SDK is newer than the GSI SDK (37 > 36), `mount-android.sh` binds the vendor's `lib64/` and `lib/` libc++ over the GSI's before the container starts, so host and container use the same file. Android 15/16 vendors keep the GSI's. `LUNEOS_VENDOR_LIBCXX=0/1` overrides.

**2. LLNDK the GSI does not export: no camera.** The camera provider (`android.hardware.camera.provider-service_32.lineage`, AIDL) looped on `CANNOT LINK EXECUTABLE ... library "libcamera_metadata.so" not found`; the webOS camera service announced "0 droid camera(s)" — athena's symptom, possibly the same cause. The A17 vendor links it as LLNDK (`@LIBCAMERA_METADATA`) and ships no copy; the GSI has it but its linkerconfig does not export it to the vendor namespace. linkerconfig needs a library in **both** `/system/etc/llndk.libraries.txt` and `provideLibs` (field 3) of `/system/etc/linker.config.pb` — either alone changes nothing (tested with `linkerconfig --target`). `mount-android.sh` adds every library the GSI has, the vendor lacks and a vendor file names, to bind-mounted copies of both. A DT_NEEDED scan of every pioneer vendor ELF found `libcamera_metadata.so` the only real case. Overrides: `LUNEOS_VENDOR_LLNDK=0`, `LUNEOS_VENDOR_LLNDK_EXTRA`.

**3. QMI over QRTR needs the host network namespace: no modem EFS, no Wi-Fi.** LXC 4.0 clones a network namespace even with `lxc.net.0.type = none` unless `net` is in `lxc.namespace.keep`, and QRTR sockets exist only in the initial namespace. `rmt_storage` (which logs to kmsg, not logcat) failed `qmi register failed : 8`, `tftp_server` asserted (`Line=719 : Cond=result == 0`), the modem had no EFS and took `Fatal error on the modem` every ~42 s, and Wi-Fi — WCN3990 runs through the modem's icnss — never started (`/dev/wlan` write failed). With `net` kept: `rmt_storage: Done with init now waiting for messages!`, modem ONLINE with no crashes, `wlan0` up. `mount-android.sh` adds `net` when the kernel offers `QIPCRTR` and the vendor ships `rmt_storage`; `LUNEOS_LXC_KEEP_NET=0/1` overrides. **This applies to every Qualcomm vendor with QMI over QRTR** on the generic image (sunfish, bramble, athena, fajita, surya): athena's never-tested modem may have the same problem. Checked on pioneer: the container's `netd` does not run, and host `ip rule`, routes and iptables stay at their defaults (the vendor adds only `qcom_qos_*` mangle chains for `rmnet_data+`). `ANDROID_LXC_KEEP_NS` cannot do this from pioneer.conf: the rootfs is halium-arm64's.

**4. keymaster reads the boot header** (§ Boot image).

**libgbinder** resolves `ApiLevel` 37 → the API 36 preset, which matches the GSI's own servicemanager (luneos-device-config: `vendor API level 202604 is an Android 15+ date; using the vendor's own SDK 37`). The vendor VINTF target-level `202604` parses in the GSI's libvintf.

## Yocto

Layer `meta-smartphone/meta-sony` (new), `MACHINE=pioneer`. `conf/machine/pioneer.conf` (`VIRTUAL-RUNTIME_android-system-image = ""`: the GSI rides on userdata via `halium-gsi-image`, the q25 pattern; `PREFERRED_VERSION_android-headers-halium = "16.0%"`); kernel `recipes-kernel/linux/linux-sony-pioneer_git.bb` + `luneos.cfg` + the fanotify patch. The rootfs is `halium-arm64`'s, so nothing in pioneer.conf's `MACHINE_EXTRA_RDEPENDS` reaches the device, and `android-kernel-bootimg` (which would write `boot_a` even when the phone runs from `_b`) is not on it.

**Adaptation directory = `pioneer`.** `luneos-device-config` keys adaptations by `ro.product.vendor.device`. Inside the container the LineageOS vendor reports `pioneer`; `H4113` is only what LineageOS's init sets at runtime, which the Halium container never runs — an adaptation keyed by the model number (as first written, by analogy with fajita's `OnePlus6T/`) was never found. Measure the key inside the LuneOS container, not under the vendor's own Android. The adaptation pins the keys to `qpnp_pon;gpio-keys` (derivation also takes `SOMC USB Removal`, a USB-unplug event advertising KEY 0xc2), dpi 424 and a device pixel ratio of 2.4 carried from sargo; the UI is sized correctly with it.

**The touchscreen registers after the compositor starts.** `synaptics_dsx` sits behind the panel (handlers `mdss_fb kgsl`) and registered at 44.1 s and 66.0 s on two boots — only once the compositor had powered the panel, i.e. after `luneos-device-config` (ordered before surface-manager) had run. So there is no node to derive or pin at that point, however long it waits (a 30 s wait was tried: it only delayed the compositor), and the compositor got the shipped `evdevtouch:/dev/input/PLACEHOLDER`: a UI that draws and never responds. The surface-manager generator now gives a bare `-plugin evdevtouch` when no touchscreen was found; Qt then discovers it through udev and hot-plugs it. The node number also moves between boots (event4, event6).

| node (one boot) | name | |
|---|---|---|
| event0 | `qpnp_pon` | power, volume up |
| event1 | `s5712_sensor` | switch, no keys |
| event2 | `SOMC USB Removal` | KEY 0xc2 (F24) on unplug |
| event3 | `gpio-keys` | volume down, camera focus/shutter |
| event4, event5 | `sdm660-snd-card-mtp Headset Jack`, `Button Jack` | |
| event6 | `synaptics_dsx` | touchscreen |

```sh
export DISTRO=luneos MACHINE=pioneer; . ./setup-env    # export MACHINE: "MACHINE=x . ./setup-env" does not reach bitbake
bitbake linux-sony-pioneer halium-gsi-image             # boot image + GSI
MACHINE=halium-arm64 bitbake luneos-dev-image           # universal rootfs
```

Built on an Ubuntu 24.04 **arm64** VirtualBox guest on Apple Silicon: the build host, memory, rm_work and the x86_64-only recipes it exposed are in device-bringup-yocto.md § Build failures worth remembering (items 6–8). `input` group membership lets `adb shell getevent -p` list input devices without root, where `/proc/bus/input/devices` is denied.

## Install

A/B fastboot, no vbmeta step (no such partition). The kit (`luneos_pioneer_<date>.zip`) flashes **userdata first**, then `boot_a` and `boot_b`; `vendor_*`, `system_*` and firmware stay, and the active slot is not changed. If userdata fails, the LineageOS boot slots are still intact. userdata ships as an **Android sparse image** (`userdata-luneos.simg`, `img2simg`): fastboot 37.0.1 on macOS fails the 4.38 GB raw ext4 before sending anything, `fastboot: error: Failed reading from userdata`, while the sparse image (3.17 GB) goes in 7 chunks under xboot's 512 MB `max-download-size`. The image holds `rootfs.img` + `android-rootfs.img` (the GSI) side by side; the initramfs grows it to the 20 GiB partition on first boot.

The debug gadget is RNDIS-only, and **macOS has no RNDIS driver**: from a Mac, pass the USB device through to a Linux VM (`VBoxManage controlvm <vm> usbattach <uuid>` from `VBoxManage list usbhost`), load `rndis_host` (Ubuntu cloud kernels keep it in `linux-modules-extra-$(uname -r)`; run `depmod -a` after installing), give the `enx…` interface 192.168.2.20/24 and telnet 192.168.2.15. The gadget's iSerial (`LuneOS initrd telnet 192.168.2.15: <reason>`) shows in `ioreg -p IOUSB -l` even without a driver. `install.sh --debug` only `fastboot boot`s the `enable_adb` image (which does not exercise the load addresses, boot-images.md § Debug images). The normal image comes up as "LuneOS halium-arm64" with adb, which macOS handles natively. Rollback: the saved LineageOS `boot_b.img` to both slots, `fastboot -w`.

## Subsystem notes

**Fingerprint: two HALs are alternatives, not a set.** The vendor's `hw/init.qcom.rc` declares `ets_hal` (Egistec, `...-service_et512`) and `fps_hal` (FPC, `...-service_fpc`), both `disabled`, each enabled by `on property:vendor.hw.fingerprint=<sensor>`. `start-android-hals.sh` force-started every disabled service, so both ran; the Egistec one loaded its TrustZone app (`egisap32`), found no sensor, kept it resident — and with it loaded QSEE refused the FPC app forever: `scm_call failed: func id 0x72000101, ret: -2`, `fpc_tac_open start_app failed: -1`. Stopping `ets_hal` unloaded it and `fpctzapp` loaded about 5 s later. `start-android-hals.sh` now starts a disabled service whose only enablers are `on property:` blocks only if one holds (decided in the background, at most ~5 s; a property still unset after that starts the service as before). Second bug: `biomd-hal-wait.sh` looked for an rc file *named* after the HAL and missed HALs declared inside `hw/init.qcom.rc`; it now matches the binary or any rc mentioning it. With both, the adapter reports `available: true` and an enrol request reaches `fpc_tee_wait_finger_down`. Leads ruled out on the way: missing TA files, QSEE common libraries (other apps load), RPMB/`qseecom` nodes (present in the container), ION secure heaps, the Sony daemons (`tad`, `ta_qmi_service`, `secd`, `qseecomd`, all running).

**Bluetooth: connman soft-blocks it.** connman's bluetooth plugin, with the default `[Bluetooth] Enable=false` (`DefaultEnabledTechnologies` has no bluetooth), soft-blocks every Bluetooth rfkill switch, including bluebinder's `hci0`, and systemd-rfkill then saves and restores that block on every boot: `Failed to set mode: Blocked through rfkill (0x12)`. This is the root cause of athena's "systemd-rfkill restores a saved soft-block" (hal-userspace.md § Bluetooth). Bluetooth belongs to bluetooth2, which never uses rfkill, so connmand runs `--noplugin=bluetooth` and a tmpfiles rule drops saved Bluetooth rfkill state. There is no hci-index mismatch here: bluebinder's "Own hci index" tracks the rfkill index, not the hci number. Restart order: stopping `bluetooth.service` also stops `obex` and `webos-bluetooth-service`, which do not come back by themselves. audiod's `bluetooth_configuration.json` names `hci1` for A2DP; the phone has only `hci0` (A2DP untested).

**Wi-Fi: the status-bar menu never asked for a passphrase** (generic LuneOS bug). connman sends RequestInput to the agent of whoever called Connect — the status-bar menu's — which launched the Wi-Fi app with a target the app ignored and never replied; the on-screen keyboard itself works. The menu now hands the request back and the app connects to the network it was launched for (luna-next-cardshell and settings-qml patches). One AP deauth (reason 6) left connman in `failure / invalid-key` until connman was restarted.

**GNSS.** `android.hardware.gnss@2.1-service-qti` and `loc_launcher` run; `com.webos.service.location` has `gps` and `network` handlers (both off by default) and talks to the GNSS HAL itself — geoclue2's config has no GNSS source and is not in that path. With `setState {"Handler":"gps","state":true}`, NMEA flows (`$GPGSV`: 16 satellites in view, from the almanac) but indoors every SNR is 0 and there is no fix; with no SIM there is no assistance either. The shipped `/etc/geoclue/geoclue.conf` carries a Google geolocation API key in `[wifi]` — an upstream default worth not relying on.

**Web runtime: no WebGL.** WebAppMgr's GPU process fails context creation (`ContextResult::kFatalFailure: missing GL_ANGLE_robust_client_memory`), so web content renders on the CPU: a Flutter web game measured 1–11 fps with CanvasKit and 43–53 fps with the HTML renderer at half resolution. The compositor rotates everything from the accelerometer, and WebAppMgr ignores `PalmSystem.setWindowOrientation`, so a web app cannot lock portrait.

**Battery.** com.webos.service.battery at SRCREV 71e581b recursed in `ChargerView()` and segfaulted at boot (gdb); upstream 795d140 fixes it. sysfs: `/sys/class/power_supply/battery`, charger on `usb` (USB_PD) / `pc_port`.

**Clock.** The PMIC RTC (`rtc-pm8xxx`) reads 1970 and `hwclock -r` fails: Qualcomm keeps real time as an offset in `time_daemon`. Every boot without network starts in 1970 until the network sets the time.

## Open issues

- **Memory stall after ~2.5 h of uptime** (28 Oct 2026, final image): load average 73, MemAvailable ~180 MB of 2.7 GB, UI unresponsive. adb still answered, but too slowly to list processes, and the USB gadget had switched to the vendor's "Xperia XA2" identity. Candidates, not yet checked: a web app left running (a CPU-rendered game and Maps were open; WebAppMgr has no WebGL), a crash/coredump loop, the opt-in fingerprint-tap session (off by default). Next time, sample per-process RSS before it gets this far.
- Fingerprint: a full enrolment and match with a real finger.
- keymaster and the battery indicator: verify after flashing the image that carries their fixes.
- GNSS: an outdoor fix; whether the `network` handler should be enabled.
- Modem with a SIM: registration, calls, SMS, mobile data.
- WebGL in WebAppMgr; a per-app orientation lock.
- Wall-clock time without network (time_daemon offset).
- A2DP (`hci1` in audiod's config), headset jack, earpiece; Bluetooth phone → Mac.
- connman staying in `failure` after an AP deauth.

## Sources

- https://github.com/LineageOS/android_kernel_sony_sdm660 (`lineage-23.2` = `lineage-24.0`)
- https://github.com/LineageOS/android_device_sony_nile-common, https://github.com/LineageOS/android_device_sony_pioneer
- https://github.com/LineageOS/lineage_wiki/blob/main/_data/devices/pioneer.yml
