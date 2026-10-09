# Device: sunfish (Google Pixel 4a) — Tier B Qualcomm, vendor modules and all

Google Pixel 4a (`sunfish`), Qualcomm SM7150-AB / Snapdragon 730G, Tier B pre-GKI on a LineageOS 23.2 vendor; boots to the LuneOS UI, with our own build of its vendor modules.

Runs the generic `halium-arm64` rootfs and an Android 16 GSI over a LineageOS 23.2 vendor (the phone arrived on /e/OS 13; Google's final stock release is Android 13). Closest relative in the tree is sargo, and it was modelled on it — same vendor, same Qualcomm/Adreno libhybris path, same A/B + boot-header-v2 arrangement. What makes sunfish its own case is its vendor kernel modules (Google's stock vendor ships 44, LineageOS 23.2's 41), so the Tier B "rebuilt kernel refuses the stock modules" problem is not a footnote here, it is the port. Layer `meta-smartphone/meta-google`, `MACHINE=sunfish`.

## Platform facts

| Fact | Value |
|---|---|
| SoC | Qualcomm SM7150-AB (Snapdragon 730G), Adreno 618. `androidboot.hardware.platform=sm7150`, but `ro.board.platform=sm6150` — several names for one chip, so match on `ro.hardware=sunfish` |
| Vendor | **LineageOS 23.2** (`ro.vendor.build.version.sdk=36`), flashed by the kit (`vendor-los232.img`) so vendor and kernel come from one LineageOS revision |
| Stock reference | `google/sunfish/sunfish:13/TQ3A.230805.001.S2/12655424:user/release-keys`, security patch 2023-08-05, `ro.vndk.version=33` — source of the boot-header values below |
| Kernel | **4.14.357-openela**, LineageOS `android_kernel_google_msm-4.14` branch `lineage-23.2` (SRCREV `28f9290ae067`, the revision LineageOS 23.2's build-manifest names). Pre-GKI → Tier B. The device-specific `android_kernel_google_sunfish` repo was abandoned at lineage-18.1 / 4.14.212 — do not use it |
| Toolchain | Google Clang **r416183b**, not OE's GCC. Not a preference — see below |
| A/B | yes (`androidboot.slot_suffix`) |
| Dynamic partitions | genuine `super` (launched on Android 10), not sargo's retrofit |
| Storage | **UFS**: `/dev/sd*`, by-name at `/dev/block/platform/soc/1d84000.ufshc/by-name/` |
| boot partition | **is** recovery (`BOARD_USES_RECOVERY_AS_BOOT`). Flashing LuneOS replaces recovery; keep the stock boot.img |
| boot header | v2, pagesize 4096, kernel 0x00008000, **ramdisk 0x02000000**, tags 0x00000100, dtb 0x01f00000 (one FDT, 425,348 B in stock). Stock Google's image says ramdisk 0x01000000; the recipe uses `BoardConfig-common.mk`'s 0x02000000, which LineageOS builds with, because LineageOS's full-LTO + CFI kernel does not fit under 16 MiB. Tags follow the stock image (the board file says 0x01E00000) |
| Builds | boot.img + initramfs only. The rootfs is `MACHINE=halium-arm64`; the GSI is chosen at install time |

## The vendor modules are the port — and we build them ourselves

`/vendor/etc/init.insmod.sunfish.cfg` names 48 modules; Google's stock vendor
ships 44 of them, /e/OS 13's 42 and LineageOS 23.2's 41: the whole QTI audio DLKM stack, `qcacld` wlan, `ftm5` touch,
`drv2624` haptics. The vendor's config has `CONFIG_MODVERSIONS=y`, so they only
load into a kernel whose exported-symbol CRCs match theirs. Without them there is
no wifi, no audio, no sensors, no Bluetooth, no camera, no NFC and no
fingerprint — which is exactly the list the owner reported.

**Loading the vendor's prebuilt modules is not needed here, and that is a
measurement, not an opinion.** The LuneOS config delta moves the CRC of **8158
of 12823** exported symbols. Two options account for all of it:

`FANOTIFY` adds `fanotify_listeners` to `struct user_struct`, which `struct cred`
points at and which nearly every core type reaches; and `CGROUP_DEVICE` bumps
`CGROUP_SUBSYS_COUNT`, which dimensions arrays inside `struct css_set`. Sampled
over 164 CRCs from `fs/inode.o`, `drivers/base/{core,platform}.o`,
`kernel/sched/core.o` and `kernel/module.o`: whole delta 143, `FANOTIFY` alone
143, `CGROUP_DEVICE` alone 118, **delta minus those two: 0**.
Everything else is CRC-free — including `PID_NS` and `USER_NS`, which move nothing
(`struct nsproxy` is unconditional and `user_namespace`'s members are gated only by
`PERSISTENT_KEYRINGS`/`SYSCTL`), so the namespace options were never the problem
they look like. The `#ifndef __GENKSYMS__` patch that took bramble to 0/218 handles
*one* struct; it does not scale to `user_struct` plus a config-sized array
dimension.

Both stay on: `CGROUP_DEVICE` is used by 7 units in the shipped rootfs
(`DeviceAllow=`/`DevicePolicy=`: logind, both journald units, hostnamed,
bluebinder, both openvpn templates), and dropping `FANOTIFY` alone would buy
nothing while it does.

**So build them instead.** The kernel comes from LineageOS's own tree at the
revision their build used, so their modules are in it too, and ours match by
construction:

```
vermagic=4.14.357-openela-g28f9290ae067     LineageOS 23.2's modules
vermagic=4.14.357-openela-g28f9290ae067     ours
```

All 41 of LineageOS 23.2's vendor modules are built here (the boot images up to
rev 9 of the kit carried 40, without `rdbg.ko`). `rdbg.ko` had been disabled because `drivers/char/rdbg.c` trips
`-Werror=designated-init`, which is a **GCC-only** warning added via `cc-option`,
so it never reaches the clang build this kernel now uses — verified by compiling
`drivers/char/rdbg.o` on its own with no `-Wno-error`. `CONFIG_MSM_RDBG=m` is back
on, it moves zero CRCs, and with it the overlay replaces the vendor's module set
outright, which is what makes the CRC drift above a non-issue rather than a
blocker. The mechanism is three machine-local
lines plus two script changes, all described in kmi-crc-matching.md (Step −1):

| Where | What |
|---|---|
| `sunfish.conf` | `KERNEL_SPLIT_MODULES = "0"` + `ANDROID_EXTRA_INITRAMFS_IMAGE_INSTALL = "kernel-modules"` — modules ride in the boot image, next to the kernel they were built against |
| `init.sh` | `mount_kernel_modules()` — was a never-called stub; now stages `/lib/modules/$(uname -r)` into the rootfs before `switch_root`, idempotently |
| `mount-android.sh` | `overlay_kernel_modules()` — binds ours over `/android/vendor/lib/modules`, **keeping the vendor's `modules.load`/`dep`/`softdep`** so the container's `init.insmod.sh` loads them in the vendor's order |

`CONFIG_MODULE_FORCE_LOAD` is no longer needed and the CRC gate no longer
applies — nothing has to match. Cost: the initramfs grows from 6.6 MB to 13.4 MB
and the boot image to 35.0 MB, 52% of the 64 MB partition.

Two packaging traps this hit, both in the playbook: `KERNEL_SPLIT_MODULES = "0"`
is mandatory (under LTO each module's `depends=` names `.lto` intermediates that
no package provides — LineageOS's own shipped modules have the same field), and
`MODULE_TARBALL_DEPLOY` cannot be used because the tarball is written by
`kernel_do_deploy`, the very task that consumes this initramfs — a dependency
loop, 1705 unbuildable tasks.

**The chain that is easy to misread.** The cfg does not only load modules — it
also sets `vendor.all.modules.ready` unconditionally afterwards, so a total
module failure is invisible to everything downstream.

## Multi-fstab: firmware_mnt, and what it takes down with it

sunfish splits its fstabs by purpose — `fstab.persist`, `fstab.postinstall`, **`fstab.sm7150`** (the SoC one; *not* `fstab.sunfish`). `mount-android.sh` used to read one, and a plain glob sorts `fstab.persist` first, so `/vendor/firmware_mnt` was never mounted:

```
ueventd: firmware: attempted /vendor/firmware_mnt/image/modem.mdt, open failed
subsys-pil-tz ...: Initializing image failed(rc:-5)      (modem, cdsp, venus, npu, ipa_fws)
```

With TrustZone unable to authenticate any peripheral image, the Adreno zap shader never loads either — so no `/dev/kgsl-3d0`, no EGL, and **surface-manager aborts in a loop on a black screen**. One unmounted vfat partition, the whole device. Fix: read *every* `fstab*` the vendor ships, not the best-looking one. The rule is not "pick the right fstab", it is "do not pick".

There is **no `dsp` partition** on sunfish — `fstab.sm7150` has none, and the DSP images live in the modem partition at `/vendor/firmware_mnt/image/` alongside `modem.*`. So firmware_mnt is the only mount the DSPs need.

## Kernel recipe traps

- **Clang or nothing.** With OE's GCC every TrustZone call failed (`scm_call failed with error code -1` ×44, `QSEECOM: Failed to get QSEE version info -19`) and took PIL, the GPU and the display with it. `drivers/soc/qcom/scm.c`'s arm64 entry is register-pinned inline asm with `__asmeq` — exactly where GCC and Clang disagree — and this tree has never been built with anything but Clang. Point `GKI_CLANG_DIR:sunfish` at r416183b.
- **LTO and CFI were silent until the toolchain switch — and then got turned off for the wrong reason.** Both depend on Clang, so under GCC Kconfig forced them off; with Clang the LineageOS defconfig's `CONFIG_LTO_CLANG=y` / `CONFIG_CFI_CLANG=y` activated and the kernel grew 5.4 MB past stock. They were then disabled to match what the device's own `CONFIG_IKCONFIG` showed Google shipping (`LTO_NONE`, no CFI) — **and that was the wrong reference.** This phone does not run Google's vendor; it runs a LineageOS-derived one, whose modules were built *with* CFI and say so on contact:

  ```
  snd_event_dlkm: Unknown symbol __cfi_slowpath (err 0)
  ```

  `__cfi_slowpath` exists only in a CFI kernel, and `Unknown symbol` is the failure class no force-load can survive (kmi-crc-matching.md). **Rule: the authority is the vendor whose modules the device loads, not the OEM whose logo is on the case.** LTO is still a Kconfig *choice* — `# CONFIG_LTO_CLANG is not set` does nothing, you select `CONFIG_LTO_NONE=y` — but on this device you do not want to.
- **The boot window is asserted at build time.** Kernel at 0x8000, ramdisk at 0x02000000 → 32 MiB for everything before the ramdisk; with stock's 0x01000000 (16 MiB) the LTO + CFI kernel would not fit. `sunfish_check_boot_window` in the recipe fails the build rather than shipping a kernel that runs into its own initramfs — nothing in bitbake notices this on its own. Treat it as a build-time invariant, not a diagnosis: sunfish is a header-v2 image loaded by ABL, where the window may not bind at all (boot-images.md § The window does not bind on every bootloader — surya proves it). The 30 Sep 2026 kit image's kernel section is 21,163,040 B, leaving 12,358,624 B of headroom. **Read the logged headroom out of `log.do_deploy*` in time order** — the files are timestamp-named, so a glob sorts them by build id, not by date, and it is easy to quote a stale one.
- **`DTC_EXT` and `DTC_FLAGS=-@` are both mandatory.** The in-tree dtc is 1.4.4 and cannot parse the overlay sugar these dtsi files use (`&thermal_zones {` at the top level of a `/plugin/`); the vendor uses a newer prebuilt too. And the base dtb must carry `__symbols__` or the stock dtbo overlays have nothing to resolve against.
- **The bootloader drops command-line arguments it does not recognise** (measured on sargo with a `zz.marker=1` canary), so nothing added to `ANDROID_BOOTIMG_CMDLINE` reaches `/proc/cmdline`. Anything LuneOS needs goes in `CONFIG_CMDLINE`; `LUNEOS_ENABLE_ADB=1` builds the initramfs debug shell's flag in.
- `CONFIG_COMPAT_VDSO` off (no arm32 cross-gcc in the sysroot), `CONFIG_CC_WERROR` off.
- **Bluetooth needs `BT_BREDR` and `BT_LE` spelled out.** They are `default y` in `net/bluetooth/Kconfig`, so every other LuneOS fragment just lists the protocols — but `sunfish_defconfig` turns both off explicitly, and RFCOMM/BNEP/HIDP all `depends on BT_BREDR`. List only the protocols and the fragment silently does nothing.
- The **dtbo partition is left stock**. The eight `sm7150-sunfish-*` overlays select by `qcom,board-id`/`msm-id` inside each FDT rather than by the table header, which is why a base dtb from a different build still gets the right overlay. Expected to work; if the device does not boot with an otherwise sane kernel, build `dtbo.img` from this tree (needs AOSP `mkdtimg`, which OE does not package).

## Which vendor is this, and the move to LineageOS 23.2

The phone arrived with **/e/OS 13**, a LineageOS 20 derivative — and the owner's
recollection was not needed to establish that, because the vendor modules name
their own kernel:

```
vermagic=4.14.336-gfe61ffb52659 SMP preempt mod_unload modversions aarch64
```

`fe61ffb52659` is the head of `lineage-20` in `android_kernel_google_msm-4.14`,
which matches the `api=33` (Android 13) that vendor reports. All 42 of its modules
carried that identical string with no `+` or `-dirty`, so /e/OS applied no kernel
patches of its own: they shipped LineageOS's tree as-is. Pinning that revision
took `module_layout` from mismatching to matching — the branch tip
(`lineage-22.2`, 4.14.355) had scored 42 of 42 failing.

**The port then deliberately retargeted to the current release instead.**
LineageOS 23.2 is actively maintained for sunfish (nightlies, latest 2026-09-17),
and its build publishes everything needed to reproduce it exactly:

| Artifact | Where | Size |
|---|---|---|
| kernel revision | `build-manifest.xml` next to the zip — `28f9290ae067` | 285 KB |
| the config it shipped | `IKCFG_ST` blob inside the standalone `boot.img` | 67 MB |
| its 41 vendor modules | `vendor.img`, via `payload_extract.py` on `payload.bin` | 1.2 GB zip |

So the recipe is pinned to `lineage-23.2` / `28f9290ae067` / 4.14.357-openela,
and — the important part — **its config base is the `.config` extracted from that
shipped kernel, not `arch/arm64/configs/sunfish_defconfig`.** Their own config
has `DEBUG_FS=n` with `TRACING=y`, which is reachable on 4.14.357 and was not on
the lineage-20 tree; guessing from the defconfig is what produced two wasted
builds. `KERNEL_LOCALVERSION = "-g28f9290ae067"` supplies the rest of the
vermagic (a `CONFIG_LOCALVERSION` line in a fragment does not survive —
`kernel.bbclass` owns that option).

With that base the config diff against LineageOS is **37 symbols, all of them
ours**, and `printk`/`kfree`/`mutex_lock` already match while `dev_err` and
`module_layout` do not — a config difference in `struct device` and
`struct module`, which also proves the compiler is not the problem (ours is
clang 12, theirs clang 21).

**The trade this commits to:** the device has to run LineageOS 23.2, since that
is the vendor being matched. In exchange the target is maintained and exactly
reproducible, which /e/OS 13 was not.

### Two traps this cost, both now in kmi-crc-matching.md

- **`DEBUG_FS` was a red herring** and two builds went into it. 11 of the 42
  modules import `debugfs_create_*`/`debugfs_remove_*` themselves, so the vendor
  kernel provably had it **on**; the selector chain
  (`DEBUG_FS ← TRACING ← GENERIC_TRACER ← IPC_LOGGING`) also runs through an
  option the vendor's own defconfig sets. A `# CONFIG_X is not set` line cannot
  turn off a selected symbol in any case.
- **The recipe had no baseline switch**, so a run believed to be a stock-config
  control silently carried the whole LuneOS delta (`bitbake -R` with a variable
  the recipe never reads changes nothing) and its 42/42 was reported as evidence.
  `LUNEOS_KERNEL_FRAGMENT ?= "1"` now exists here, as it always has on bramble.

## Decoding `bad ioctl: -1072934383`

60,304 of these in one boot, and they are a **symptom, not a cause**. `-1072934383` = `0xc00c5211` = `_IOWR('R', 17, 12)`: magic `'R'` is fastrpc, number 17 is `FASTRPC_IOCTL_GET_DSP_INFO`, and 12 bytes is `struct fastrpc_ioctl_capability` (3 × u32). The vendor's `adsprpcd` calls it; the in-kernel `adsprpc` here is older and does not implement it, so it prints and returns. The flood is the restart loop multiplying one harmless line — fix the ADSP and it goes to near zero.

## Android services stubbed (and one deliberately not)

`stubbed-services.d/sunfish`: `pixelstats-vendor`, `wait_for_strongbox` (exit — init *waits* on it in late-fs), the Titan M rebootescrow HAL, `mm-pp-dpps`, the SurfaceFlinger configstore HAL, `diag_mdlog` (exit) and `ssr_diag`, `storaged`, and the **USB gadget HAL** — LuneOS owns the gadget host-side, so the container has no `/config/usb_gadget/g1` and the HAL's constructor treats that as fatal (`"configfs setup not done yet"`, 124 SIGABRTs in ten minutes, each one setting `sys.init.updatable_crashing=1` and running `flags_health_check`).

**The health HAL is not stubbed**, unlike sargo's 2.0 equivalent. Stubbing it cost more noise than it saved — 621 `Could not find 'android.hardware.health@2.1::IHealth/default' for ctl.interface_start` in ten minutes, because `storaged` is not the only client: **`gnss_service`** polls for it once a second forever, and GPS is wanted. The vendor rc declares the service with no `interface` line, so init can never satisfy a `ctl.interface_start` for it — the only thing that works is the real HAL registering `IHealth` itself.

## Two traps found on hardware, both about which image carries the fix

**The boot image stages the modules; the rootfs swaps them in.** A revision of the
staging kit said "boot image only" and the device behaved exactly as before:

```
initrd: staged 40 kernel modules into the rootfs       <- boot image did its half
snd_event_dlkm: disagrees about version of symbol module_layout   <- and nothing swapped them
```

`overlay_kernel_modules()` lives in `/usr/bin/mount-android.sh`, i.e. in the
**rootfs** (38,201 bytes before it, 40,528 after). Shipping a new boot image with
an old rootfs stages modules that nothing then uses. Flash both, or check the
rootfs actually contains the function before claiming a fix is in.

**Atlas's db8 "invalid wildcard" is a red herring.** Every boot rejects five
permission files:

```
configurator: {"errorCode":-3989,"errorText":
  "db: invalid wildcard in - 'org.webosports.app.atlas*'"}   (Partial configuration - 5 failed)
```

db8 accepts `*` only after a dot (`com.palm.*` works), and the regression landed
in the Atlas repo on 2026-07-04 (`0e8eb08`, which replaced files listing exact
callers with one wildcard). It is real and worth fixing - but **it does not stop
Atlas launching**: sargo rejects the identical file, on the identical rootfs, and
Atlas runs there. Diagnosed by querying the working device over adb, not by
reasoning. When an app fails to launch, get a log that contains the launch and
walk the nine-stage chain in the notes for sargo instead.

## Status (25 Sep 2026, kit rev 9)

**Target is LineageOS 23.2**, not the /e/OS 13 the phone arrived with: that
release is maintained for sunfish, and its build publishes the kernel revision
(`build-manifest.xml` → `28f9290ae067`), the config it shipped (`IKCFG_ST` in its
standalone `boot.img`) and its vendor modules (`vendor.img` via
`payload_extract.py`) — so it can be reproduced exactly rather than inferred.
Since rev 7 the kit flashes that vendor itself.

Up, on hardware: display, touch (FTS built in), the GPU and EGL, modem and RIL
(`SIM card OK`), cdsp, venus, the compositor, and the whole userspace — the owner
has been using Settings, Camera, Photos and Phone. TrustZone works since the
Clang switch (`scm_call` 44 failures → 0), which is what unblocked PIL, the zap
shader and therefore the GPU.

Our own module build has been booted: rev 7 staged the 40 modules but its rootfs
lacked the overlay (see "Two traps found on hardware"); rev 8 ships both halves
and rev 9 changed only the kernel. Whether wifi, audio and sensors came back with
rev 8 is not recorded here. The checks:

```sh
dmesg | grep -iE 'disagrees about version|Unknown symbol'   # expect nothing
lsmod | wc -l                                               # expect ~40
dmesg | grep -i 'mount-android: overlaid'                   # the bind-mount
```

Open as of rev 9: camera (VINTF registration), fingerprint (the HAL never
starts), and a display-manager/compositor desync behind random locking and an
unreliable power button.

Also open: an **ofono 2.19 SEGV** right after the SIM file reads
(`Requested file structure differs from SIM: 6fb7`, restarting every nine
seconds, no backtrace because `systemd-coredump` is disabled on the device), and
the dtbo pairing has never been proven — our base dtb carries `__symbols__` as
stock's does, and the panel comes up, which is the strongest evidence so far.

