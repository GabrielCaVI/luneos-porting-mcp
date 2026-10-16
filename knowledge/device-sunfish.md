# Device: sunfish (Google Pixel 4a, SM7150-AB)

Google Pixel 4a (`sunfish`), Qualcomm SM7150-AB / Snapdragon 730G, Tier B pre-GKI on a LineageOS 23.2 vendor; boots to the LuneOS UI, with our own build of its vendor modules.

Runs the generic `halium-arm64` rootfs and the Halium 16 GSI over a LineageOS 23.2
vendor, modelled on sargo (same vendor family, Qualcomm/Adreno libhybris path, A/B +
boot header v2). What makes it its own case is its vendor kernel modules: the
LuneOS config delta moves most exported CRCs, so the port builds the vendor's
modules itself and overlays them (kmi-crc-matching.md § Step −1 — first ask whether
you need to match at all). Also the device behind two general rules: the authority
for a kernel config is the vendor whose modules the device loads, not the OEM
(kmi-crc-matching.md), and read *every* fstab the vendor ships (debugging.md §
Modem).

## Status (as of 25 Sep 2026)

Hardware results are from kit rev 9.

| Area | State | Notes |
|---|---|---|
| Boot, container | works (hardware) | |
| Display, GPU/EGL, compositor | works (hardware) | needed the Clang kernel (TrustZone) and the firmware_mnt mount; a display-manager/compositor desync causes random locking |
| Touch | works (hardware) | FTS driver built in |
| Modem / RIL | partly | `SIM card OK`; ofono 2.19 SEGVs right after the SIM file reads (see Open issues) |
| DSPs (cdsp, venus) | works (hardware) | |
| Our vendor-module build | booted | rev 7 staged the modules but its rootfs lacked the overlay; rev 8 ships both halves, rev 9 changed only the kernel |
| Wifi, audio, sensors, BT | unknown | depend on the module overlay; the rev 8 result is not recorded |
| Camera | broken | VINTF registration (the owner reported using the Camera app on an earlier revision) |
| Fingerprint | broken | the HAL never starts |
| NFC | unknown | a stale gbinder `ApiLevel` was the suspected cause; fixed in rev 8's rootfs, not retested |
| Power button | unreliable | same desync as above |

## Platform facts

| Fact | Value |
|---|---|
| SoC | Qualcomm SM7150-AB (Snapdragon 730G), Adreno 618. `androidboot.hardware.platform=sm7150`, but `ro.board.platform=sm6150` — several names for one chip, so match on `ro.hardware=sunfish` |
| Vendor | **LineageOS 23.2** (`ro.vendor.build.version.sdk=36`), flashed by the kit (`vendor-los232.img`) |
| Stock reference | `google/sunfish/sunfish:13/TQ3A.230805.001.S2/12655424:user/release-keys`, patch 2023-08-05, `ro.vndk.version=33` — source of the boot-header values |
| A/B | yes (`androidboot.slot_suffix`) |
| Dynamic partitions | genuine `super` (launched on Android 10), not sargo's retrofit |
| Storage | **UFS**: `/dev/sd*`, by-name at `/dev/block/platform/soc/1d84000.ufshc/by-name/` |
| boot partition | 64 MB, **is** recovery (`BOARD_USES_RECOVERY_AS_BOOT`); keep the stock boot.img |
| fstabs | split by purpose: `fstab.persist`, `fstab.postinstall`, **`fstab.sm7150`** (the SoC one, *not* `fstab.sunfish`); no `dsp` partition — DSP images live in the modem partition at `/vendor/firmware_mnt/image/` |
| Vendor modules | `init.insmod.sunfish.cfg` names 48; Google's stock vendor ships 44, /e/OS 13's 42, LineageOS 23.2's 41 |

## Kernel

- **Tree:** LineageOS `android_kernel_google_msm-4.14`, branch `lineage-23.2`,
  SRCREV `28f9290ae067` (the revision LineageOS 23.2's `build-manifest.xml`
  names), **4.14.357-openela**. Pre-GKI → Tier B. The device-specific
  `android_kernel_google_sunfish` repo was abandoned at lineage-18.1 / 4.14.212.
- **Config base:** the `.config` extracted from LineageOS 23.2's shipped kernel
  (`IKCFG_ST` in its standalone `boot.img`), not `sunfish_defconfig` — theirs has
  `DEBUG_FS=n` with `TRACING=y` (kmi-crc-matching.md § Step 1 — get the vendor's
  real config, not its defconfig). With that base the diff against LineageOS is 37
  symbols, all ours. `KERNEL_LOCALVERSION` handling makes vermagic match LineageOS
  byte for byte (`4.14.357-openela-g28f9290ae067 SMP preempt mod_unload
  modversions aarch64`). `LUNEOS_KERNEL_FRAGMENT ?= "1"` is the baseline switch.
- **Toolchain: Google Clang r416183b, not OE's GCC.** With GCC every TrustZone call
  failed (`scm_call failed with error code -1` ×44, `QSEECOM: Failed to get QSEE
  version info -19`) and took PIL, the zap shader, the GPU and the display with
  it: `drivers/soc/qcom/scm.c`'s arm64 entry is register-pinned inline asm with
  `__asmeq`, and the tree has never been built with anything but Clang. Point
  `GKI_CLANG_DIR:sunfish` at r416183b.
- **LTO and CFI stay on, as `sunfish_defconfig` sets them.** Turning them off to
  match Google's stock IKCONFIG broke LineageOS's modules, which were built with
  CFI: `snd_event_dlkm: Unknown symbol __cfi_slowpath`. The reference is the
  vendor whose modules load (LineageOS), not Google. LTO is a Kconfig choice
  (select `CONFIG_LTO_NONE=y` to turn it off), but not here.
- **Poison options:** `FANOTIFY` and `CGROUP_DEVICE` move the CRC of 8158 of 12823
  exported symbols between them; both stay on (`CGROUP_DEVICE` is used by 7 units
  in the shipped rootfs). Measurement and analysis: kmi-crc-matching.md § What the
  two sunfish poisoners change.
- **Module strategy: build all 41 and overlay them.** Ours match by construction.
  `rdbg.ko` had been off for a GCC-only `-Werror=designated-init` the Clang build
  never sees; `CONFIG_MSM_RDBG=m` is back on (zero CRCs move), so the overlay
  covers all 41 and no prebuilt vendor module loads. Kit images up to rev 9 carried
  40. Even a CRC-verbatim build (LineageOS's config exactly, no LuneOS delta) fails
  5 of the 41 prebuilts:

  ```
  FAIL incrementalfs.ko: 29/175   FAIL q6_dlkm.ko: 3/132   FAIL rdbg.ko: 3/36
  FAIL wglink_dlkm.ko: 3/53       FAIL wlan.ko: 7/395
  ```

  so dropping the poison options would not make the prebuilts usable either; the
  gate's "41 would fail" is informational for modules that are never loaded.

  | Where | What |
  |---|---|
  | `sunfish.conf` | `KERNEL_SPLIT_MODULES = "0"` + `ANDROID_EXTRA_INITRAMFS_IMAGE_INSTALL = "kernel-modules"` — modules ride in the boot image |
  | `init.sh` | `mount_kernel_modules()` stages `/lib/modules/$(uname -r)` into the rootfs before `switch_root` |
  | `mount-android.sh` | `overlay_kernel_modules()` binds ours over `/android/vendor/lib/modules`, keeping the vendor's `modules.load`/`dep`/`softdep` so `init.insmod.sh` loads them in the vendor's order |

  Cost: initramfs 6.6 → 13.4 MB. Packaging traps (`KERNEL_SPLIT_MODULES = "0"` is
  mandatory under LTO; `MODULE_TARBALL_DEPLOY` makes a dependency loop):
  kmi-crc-matching.md § Packaging traps.
- **Other config:** `BT_BREDR` and `BT_LE` must be spelled out — `sunfish_defconfig`
  turns both off and RFCOMM/BNEP/HIDP depend on `BT_BREDR`. `CONFIG_COMPAT_VDSO`
  off (no arm32 cross toolchain in the sysroot), `CONFIG_CC_WERROR` off.
- **dtc:** `DTC_EXT` and `DTC_FLAGS=-@` are both mandatory. The in-tree dtc 1.4.4
  cannot parse the overlay sugar these dtsi files use (`&thermal_zones {` at the top
  level of a `/plugin/`), and the base dtb must carry `__symbols__` for the stock
  dtbo overlays.
- **Cmdline:** the bootloader drops arguments it does not recognise, so anything
  LuneOS needs goes in `CONFIG_CMDLINE` (kernel-porting.md § The kernel command
  line); `LUNEOS_ENABLE_ADB=1` builds the debug shell's flag in.

### Rejected paths

- **Matching the /e/OS 13 vendor.** The phone arrived on /e/OS 13 (LineageOS 20
  based); its modules carry `vermagic=4.14.336-gfe61ffb52659`, the head of
  `lineage-20`, with no `+`/`-dirty` (all 42 identical). Pinning that revision
  fixed `module_layout`; the `lineage-22.2` tip (4.14.355) had scored 42 of 42
  failing. Retargeted to LineageOS 23.2 because it is maintained and its build
  publishes the kernel revision, shipped config and vendor modules, so it can be
  reproduced exactly. The trade: the device must run the LineageOS 23.2 vendor,
  which the kit now flashes.
- **Force-loading the prebuilt modules** (`CONFIG_MODULE_FORCE_LOAD`, a host-side
  pre-start hook) — superseded by building them. Two lessons from that round: the
  cfg's `enable|<sysfs path>` lines are what start the DSPs, and the node one of
  them writes (`/sys/kernel/boot_adsp/boot`) is created by `adsp_loader_dlkm.ko`
  earlier on the list — without it no ADSP, fastrpc "Transport endpoint is not
  connected", and no sensors. And `incrementalfs.ko` is on the vendor partition
  but not in the cfg (Android loads it with `finit_module`, which has no force), so
  it failed with `Exec format error` and vold could not prepare user 0. Reason from
  the vendor partition (`debugfs -R "ls -l /lib/modules" vendor.img`), not the
  defconfig: guessing from `=m` symbols predicted working audio on a device with no
  ALSA card. Rules: kmi-crc-matching.md § Force-loading prebuilt modules, and when
  it is safe.

## Boot image

Header v2, pagesize 4096, kernel 0x00008000, **ramdisk 0x02000000**, tags
0x00000100, dtb 0x01f00000 (one FDT, 425,348 B in stock), `Image.lz4-dtb`,
os_version `0x1a000178` (13.0.0 / 2023-08, matching stock). Stock Google's image
says ramdisk 0x01000000; the recipe uses `BoardConfig-common.mk`'s 0x02000000,
which LineageOS builds with, because the LTO + CFI kernel does not fit under 16
MiB. Tags follow the stock image (the board file says 0x01E00000).

`sunfish_check_boot_window` (a `do_deploy` postfunc) fails the build if the kernel
runs into the ramdisk address — a build-time invariant; on a header-v2 image loaded
by ABL the window may not bind at all (boot-images.md § The kernel/ramdisk window —
a build-time invariant). The current kit image: kernel section 21,163,040 B,
12,358,624 B of headroom. Read logged headroom from `log.do_deploy*` in time order —
the files are named by build id, so a glob does not sort them by date.

The **dtbo partition stays stock**. The eight `sm7150-sunfish-*` overlays select by
`qcom,board-id`/`msm-id` inside each FDT, so a base dtb from a different build still
gets the right overlay; the panel coming up is the evidence. If it ever fails,
build `dtbo.img` from this tree (needs AOSP `mkdtimg`, not packaged by OE).

## Vendor and GSI

LineageOS 23.2 vendor (SDK 36) → Halium 16 `halium_arm64` GSI. gbinder `ApiLevel`
is derived from the vendor at runtime (36); the shared rootfs's baked
`ApiLevel = 32` had libgbinder speaking the API 31 servicemanager protocol, the
suspected cause of `nfcd: registerForNotifications(android.hardware.nfc.INfc/default)
tx error -2147483647` (hal-userspace.md § Binder and gbinder). The vendor image is
built by `extract-vendor.sh` from a LineageOS OTA zip (`payload_extract.py` on
`payload.bin`); on a newer nightly, re-check the kernel revision in its
`build-manifest.xml` and re-pin the recipe, or the modules will not match.

## Yocto

Layer `meta-smartphone/meta-google`, `MACHINE=sunfish`; rootfs `MACHINE=halium-arm64`.

| Recipe / file | Role |
|---|---|
| `conf/machine/sunfish.conf` | boot image only; module-overlay variables above |
| `recipes-kernel/linux/linux-google-sunfish_git.bb` + `luneos.cfg`, `lineage-config` | kernel (Clang, LineageOS config base, boot-window check) |
| `recipes-core/android-system/.../stubbed-services` (sunfish) | stub list, below |

## Install

The kit flashes `boot`, `userdata` and the LineageOS 23.2 `vendor`. `vendor` is a
logical partition inside `super`, so `install.sh` reboots into **fastbootd** to
write it. Prerequisite: Google's stock factory image flashed and booted once,
bootloader unlocked (it supplies bootloader, modem, tz and other firmware
partitions). Ship and flash the boot image *and* the rootfs together: the boot
image stages the modules, but `overlay_kernel_modules()` lives in the rootfs's
`mount-android.sh` — a new boot image over an old rootfs stages modules nothing
uses. General steps: installing.md.

## Subsystem notes

- **firmware_mnt:** `mount-android.sh` once read only the first fstab glob match
  (`fstab.persist`), so `/vendor/firmware_mnt` was never mounted, PIL failed for
  modem, cdsp, venus, npu and ipa_fws (`Initializing image failed(rc:-5)`), the zap
  shader never loaded, and surface-manager aborted in a loop on a black screen. It
  now reads every fstab (debugging.md § Modem).
- **`vendor.all.modules.ready`** is set unconditionally by the cfg after loading,
  so a total module failure is invisible downstream.
- **`bad ioctl: -1072934383`** (60,304 in one boot) = `0xc00c5211` =
  `_IOWR('R', 17, 12)`: fastrpc `FASTRPC_IOCTL_GET_DSP_INFO`, which the vendor's
  `adsprpcd` calls and the older in-kernel `adsprpc` does not implement. A symptom of
  the `adsprpcd` restart loop, not a cause; fixing the ADSP brings it to near zero.
- **Stubbed** (`stubbed-services.d/sunfish`): `pixelstats-vendor`,
  `wait_for_strongbox` (exit — init waits on it in late-fs), the Titan M
  rebootescrow HAL, `mm-pp-dpps`, the SurfaceFlinger configstore HAL,
  `diag_mdlog` (exit), `ssr_diag`, `storaged`, and the **USB gadget HAL** — LuneOS
  owns the gadget host-side, so the HAL's constructor finds no
  `/config/usb_gadget/g1` and aborts (124 SIGABRTs in ten minutes).
- **Not stubbed: the health HAL.** `gnss_service` polls for `IHealth` once a second
  forever (621 `Could not find ... IHealth/default` in ten minutes when stubbed), and
  the vendor rc has no `interface` line, so only the real HAL satisfies it.
- **Atlas's db8 "invalid wildcard"** (`org.webosports.app.atlas*`, 5 permission
  files rejected) is real — db8 accepts `*` only after a dot; regression from Atlas
  `0e8eb08` — but does not stop Atlas launching: sargo rejects the identical file
  and runs Atlas.

## Open issues

- Wifi, audio, sensors and BT with the module overlay (rev 8+) — not recorded.
  Checks after the next flash:

  ```sh
  dmesg | grep -iE 'disagrees about version|Unknown symbol'   # expect nothing
  lsmod | wc -l                                               # expect ~40
  dmesg | grep -i 'mount-android: overlaid'                   # the bind-mount
  journalctl -b | grep -i "gbinder ApiLevel"                  # expect 36
  ```
- Camera: VINTF registration. Fingerprint: the HAL never starts.
- Display-manager/compositor desync: random locking, unreliable power button.
- **ofono 2.19 SEGV** right after the SIM file reads (`Requested file structure
  differs from SIM: 6fb7`), restarting every nine seconds; no backtrace because
  `systemd-coredump` is disabled on the device.
- NFC: retest at the corrected `ApiLevel`.

## Sources

- https://github.com/LineageOS/android_kernel_google_msm-4.14 (`lineage-23.2`)
- https://wiki.lineageos.org/devices/sunfish/
