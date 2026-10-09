# Kernel Porting for LuneOS (GKI Tier A and Legacy Tier B)

The LuneOS kernel-porting method: one GKI kernel per KMI on Tier A devices, a per-device vendor BSP kernel on Tier B, and how to verify both before flashing.

On GKI devices (Android 12+, kernel ≥5.10) you build **one kernel per KMI, not per
device** — the stock vendor modules keep loading because the KMI is binary-stable —
while pre-GKI devices need a per-device kernel built from the vendor BSP source
(Tier B). Both tiers hinge on the same three steps: extract the stock config,
compute the LuneOS delta with `mer_verify_kernel_config`, and verify host-side,
*before* flashing anything, that the vendor's modules will still load.

Everything about whether a vendor `.ko` loads into your kernel — vermagic, CRCs,
poison options, struct layouts, force-loading, and building and shipping your own
modules instead — is in kmi-crc-matching.md. Tool usage is in tools.md.

---

## The config delta (both tiers)

Extract the stock config from the stock kernel (`IKCONFIG`; Android kernels carry
it — kmi-crc-matching.md § Step 1 has the extraction), then run
`mer_verify_kernel_config` (tools.md § mer-kernel-check) on it to size the delta,
and again on your shipped config to confirm every remaining error is deliberate.
Interpret errors as "explain or fix", not "fix". Measured: stock GKI 6.1 (bluejay)
23 errors / 59 warnings — **`gki_defconfig` alone is NOT enough**, but the fragment
is small and known; mindphone's stock 4.14 13 / 58; the shipped bluejay config 5
errors, all accounted for (SYSVIPC, not needed; NET_L3_MASTER_DEV, KMI-poison;
NF_LOG_IPV4/6 and DUMMY, checker quirks listed in tools.md).

**Missing hard requirements** (systemd/LuneOS) in stock GKI:

- `DEVTMPFS` (+ `DEVTMPFS_MOUNT`)
- `FHANDLE`
- `TMPFS_POSIX_ACL`, `TMPFS_XATTR`
- `VT`
- netfilter/PPP/L2TP error items: `NF_LOG_IPV4/6`, `IP_NF_MATCH_RPFILTER`,
  `INET_AH`/`INET6_AH`, `INET_IPCOMP`, `PPP_*`, `L2TP_*`, `NET_L3_MASTER_DEV`,
  `DUMMY`, `QUOTA_NETLINK_INTERFACE`, `STATIC_USERMODEHELPER` off
- `UEVENT_HELPER=y` + `UEVENT_HELPER_PATH=""`: the initramfs's mdev writes
  `/sys/kernel/uevent_helper`, which stock GKI does not provide; without it late
  hotplug events are lost (the initial `mdev -s` covers the normal path, but add
  it if by-partlabel links come up empty). Behavioural and KMI-safe.
- `# CONFIG_MODULE_SIG_PROTECT is not set` on a rebuilt GKI, or the stock vendor
  modules never load although every CRC matches (kmi-crc-matching.md § A failure
  class invisible to CRC checks)
- Also off in stock: `USER_NS`, `PID_NS`, `AUTOFS_FS`, `SQUASHFS`, `CHECKPOINT_RESTORE`

**Not required:** `SYSVIPC` (and with it `IPC_NS`). LuneOS does not use SysV IPC;
leave `# CONFIG_SYSVIPC is not set`.

**Already good in stock GKI**: `NAMESPACES`, `NET_NS`, `UTS_NS`, `CGROUPS`
(+freezer, memcg, v2), `EXT4`, `F2FS`, `OVERLAY_FS`, `VETH`, `BRIDGE`, `TUN`,
`BLK_DEV_LOOP`, `BLK_DEV_DM`, binder+binderfs, `FUSE`, `SECCOMP`, `IKCONFIG_PROC`.

**On a Tier A kernel some of the delta is KMI-poison** and must stay off. On
`android14-6.1` (bluejay, panther) that is `FANOTIFY` and `NET_L3_MASTER_DEV`;
everything else above is KMI-clean (zero CRC drift). The list is per KMI and
kernel tree — re-derive it, never transplant it (kmi-crc-matching.md § Poison
options). Userland consequences of the android14-6.1 list:

- No fanotify (systemd is fine without it).
- No VRF/l3mdev (ofono is fine).
- **LXC must not unshare the IPC namespace** (`IPC_NS` is off; `PID_NS` is
  available), nor the user namespace where `USER_NS` is off (stock GKI, Q25):
  `lxc.namespace.keep = ipc user`.

### Fragment traps

- **Check the merged `.config`, not the fragment.** `merge_config.sh` drops a
  symbol that is not in Kconfig **silently**, with no warning in
  `log.do_configure`. `CONFIG_SECURITY_SELINUX_BOOTPARAM_VALUE=0` is standard advice
  for Android kernels and does nothing on CIP 4.19.325: that tree backported the
  5.x SELinux/LSM rework (visible in the built `.config` as `CONFIG_LSM="…"`,
  `CONFIG_SECURITY_SELINUX_SIDTAB_HASH_BITS`, `CONFIG_SECURITY_LOCKDOWN_LSM` on a
  4.19 kernel), which **deleted the symbol** in favour of
  `int selinux_enabled_boot __initdata = 1;` plus `__setup("selinux=", …)`. A
  long-term stable tree (CIP, Android LTS) can have newer infrastructure than its
  version number suggests; grep the Kconfig in the actual source before trusting a
  symbol name.
- **Never start a comment line in a fragment with `# CONFIG_`.**
  `merge_config.sh` matches `^(# )?CONFIG_[A-Za-z0-9_][= ]`, so
  `# CONFIG_DUMMY=y  kept at the stock value` is parsed as a directive and
  silently unsets the symbol (found on athena; see device-athena.md).
- **Kleaf folds comment lines into the expected value.** Kleaf verifies a
  defconfig fragment by grepping it for the symbol token, so a fragment must not
  mention, even in a comment, a symbol it declares (cost one bluejay build).

---

## Tier A — GKI devices (Android 12+, kernel ≥5.10)

### Step 1: Check that the stock kernel really is GKI

A GKI boot image and `android12-5.10` in the version string do not imply that an
ACK build will do. MediaTek ships its *mgk* derivative on MT6789: an ACK kernel
failed 344 of 344 stock modules on the Q25, `module_layout` included, and the
port builds the device's own tree instead (found on the Q25; see device-q25.md).
Run `kmi-crc-check.py` against a first ACK build before assuming the
one-kernel-per-KMI property holds.

### Step 2: The KMI/MODVERSIONS constraint

GKI kernels build with `CONFIG_MODVERSIONS=y` (`MODULE_SIG_FORCE` is **not** set on
bluejay). Config options that add fields to core structs (e.g.
`CONFIG_NET_L3_MASTER_DEV` adds `l3mdev_ops` to `struct net_device`) change the
genksyms CRCs of exported symbols. The stock vendor modules (vendor_boot dlkm
fragment + `vendor_dlkm`, or on A13-launch devices `vendor_kernel_boot` +
`vendor_dlkm`) then **refuse to load** against your rebuilt kernel — and losing
them loses the whole Tier A property.

### Step 3: Verify host-side, before any flash

1. Extract the stock vendor modules from the factory image
   (`extract-vendor-modules.sh`, tools.md; it reads both the `vendor_boot` dlkm
   fragment and `vendor_kernel_boot.img`).
2. Build ACK with your fragment (kernel-only target, Step 4).
3. Run `kmi-crc-check.py <Module.symvers> <dir of stock .kos>` (tools.md).
   Target: **0 modules would fail to load**.
4. If modules fail, bisect the fragment one option at a time with
   `symvers-drift.py` (kmi-crc-matching.md § Poison options has the method and the
   three-minute per-object harness). On bluejay the full fragment drifted 3145
   exported-symbol CRCs and failed 203/203 modules; with `FANOTIFY` and
   `NET_L3_MASTER_DEV` out, drift was 0.

### Step 4: Build ACK

Two routes produce the same kernel:

- **Yocto** (what LuneOS ships):
  `meta-android/recipes-kernel/linux-halium-gki/linux-halium-gki_6.1.bb` builds
  ACK android14-6.1 with the LuneOS fragment using Google's prebuilt clang 17
  (**r487747c**, the clang the KMI was frozen with) and plain kbuild — no Bazel,
  and **not** OE's cross toolchain, which has never been validated against this
  KMI; a silent CRC drift would only show up on the device as vendor modules that
  do not load. `luneos-bootimg-gki` (with `meta-android/classes/gki_bootimg.bbclass`)
  consumes it by default via `GKI_KERNEL_PROVIDER ?= "linux-halium-gki"`; setting
  `GKI_KERNEL_IMAGE` overrides that with an out-of-tree Image, which
  `do_deploy[file-checksums]` hashes so a new kernel really does rebuild the boot
  images instead of returning stale sstate. Machines opt in with
  `GKI_BOOTIMG = "1"` in their own machine conf; `GKI_KERNEL_IMAGE_NAME` asks for
  `Image.gz` instead of `Image.lz4`; `GKI_CLANG_DIR` / `GKI_BUILD_TOOLS_DIR` are
  machine-scoped in local.conf because a 5.10 kernel wants clang **r416183b**
  while android14-6.1 wants **r487747c**. bluejay/panther set
  `PREFERRED_VERSION_linux-halium-gki = "6.1%"`;
  `PREFERRED_PROVIDER_virtual/kernel = "linux-dummy"` only means the rootfs
  carries no kernel.
- **Kleaf** (Pixel kernel manifests, `repo init -u
  https://android.googlesource.com/kernel/manifest -b
  android-gs-<device>-6.1-android16`, about 10 GB). Prebuilt GKI is the default;
  `--config=use_source_tree_aosp` builds `//aosp` from source, which any config
  change needs. Put the fragment in a package with a `BUILD.bazel` filegroup and
  build the kernel alone:

  ```
  tools/bazel build --config=use_source_tree_aosp \
    --//build/kernel/kleaf:defconfig_fragment=//luneos:luneos_defconfig \
    //aosp:kernel_aarch64
  ```

A 5.10 tree has kbuild gotchas a 6.1 one does not (`CROSS_COMPILE` for clang's
target triple, `LLVM_IAS=1`, `PYTHON=python3`); see device-q25.md § 5.10 kbuild
gotchas.

### Vendor-hook modules and the ACK tag

Factory vendor modules can be built against a **newer** ACK tag than the kernel
manifest pins, and Google ships kernel and modules decoupled. Modules that import
vendor-hook tracepoints (`android_rvh_*`, `android_vh_*`, `android_trigger_*`)
then fail against a build from the pinned checkout. Fix: check out an
`android14-6.1-<yyyy>-<mm>_r<n>` release tag new enough to carry them
(add-only KMI growth, no CRC drift). A later `repo sync` reverts the checkout,
and the manifest-pinned vendor-module sources may no longer compile against the
bumped headers — irrelevant for Tier A, where the stock modules are the point
(found on bluejay: `vh_mm.ko`/`vh_sched.ko`; see device-bluejay.md).

### One kernel per KMI

Panther's stock kernel is byte-identical to bluejay's (device-panther.md): one GKI
per KMI, shipped identically on gs101 and gs201. A LuneOS Tier A kernel built for
one device of a KMI is a drop-in for the others — re-run `kmi-crc-check.py`
against the new device's own `.ko` set to confirm.

### Option B escape hatch (own vendor modules)

Pixel kernels are fully open source including all vendor modules, so a full
rebuild (kernel + modules + repacked vendor_boot/vendor_dlkm) is available if KMI
preservation ever fails. Build it at the **manifest-matched** state, where the full
dist succeeds. It loses the "one kernel per KMI" property but keeps a port moving,
and it ignores the poison list entirely (kmi-crc-matching.md § Step −1).

Before flashing anything on a Pixel, check anti-rollback: installing.md §
Anti-rollback.

### The vendor_dlkm module set is never loaded on Halium

A GKI-era vendor ships kernel modules in **two** sets, and Halium only ever loads
the first:

| Set | Lives in | Loaded by | On Halium |
|---|---|---|---|
| vendor_boot ramdisk | `/lib/modules` in the vendor_boot ramdisk | the initramfs, early, to reach storage | **yes** |
| `vendor_dlkm` | the `vendor_dlkm` logical partition | Android's init, later | **no** |

Halium curtails the container's init on a `wait_for_prop` gate long before it
reaches the second set, and the initramfs cannot load it either (it is a logical
partition inside `super`, needing dm-linear that the initramfs has no tooling
for). On the MP01 that is **164 modules — more than the 159 the initramfs loads.**

The symptoms do not look like "missing kernel modules":

- `nvmem-mt635x-efuse.ko` lives in `vendor_dlkm`, while `mt635x-auxadc.ko` is in
  the early set and depends on it. The auxadc probe returns **-517**
  (`EPROBE_DEFER`) forever, the fuel gauge never comes up, and healthd reports
  `battery l=-1`. lk then paints a **battery icon with a question mark**, decides
  the device is in charger mode, starts Android's `charger` binary, and reboots
  in a loop. This reads exactly like a flat battery and is not one — the same
  device reported `v=4429` (4.43 V, essentially full) while showing it.
- The **touchscreen** drivers (`gt9886.ko`, `gt9896s.ko`, `focaltech_touch.ko`)
  are in `vendor_dlkm` too, so the panel has no touch at all, nothing advertises
  `ID_INPUT_TOUCHSCREEN`, and `luneos-device-config` leaves the compositor
  pointed at `evdevtouch:/dev/input/PLACEHOLDER`.

**Check for it on any new Tier A port, before blaming anything else:**

```
# how big is the set nobody loads?
wc -l < <vendor-modules>/dlkm/modules/modules.load
# is a driver you are missing in it rather than in the early set?
grep -iE 'touch|efuse|nvmem' <vendor-modules>/dlkm/modules/modules.load
# on the device
dmesg | grep -- -517
```

**Fix:** load them from `mount-android.sh`, after `vendor_dlkm` is mounted and
before the container's init starts (meta-android, `load_vendor_dlkm_modules`).
It looks for `modules.load` under each mount point the partition can land on
(`/vendor_dlkm`, `$ANDROID_ROOT/vendor_dlkm`) and is a no-op on devices without
it. `modules.load` is a **list, not a dependency order** — the same trap as in
the initramfs — so make repeated passes and stop when a pass loads nothing new.

**Who is affected:** any Android 12+ / GKI device with a `vendor_dlkm`
partition — MP01, where it was found; bluejay's factory image has one too, and
panther has not been flashed yet. **Not** affected: pre-dynamic-partition
devices, which have only one module set (mindphone: MT6739, Android 11, 4.14, no
super/vendor_boot; sargo).

---

## Tier B — legacy devices (pre-GKI, vendor BSP kernel)

### Identify the platform precisely first

Read it off the stock boot.img before writing a machine conf: kernel architecture
(a 64-bit SoC can run a **32-bit kernel + 32-bit userland**, as mindphone does
with `bootopt=64S3,32S1,32S1`), image type (`zImage` vs `Image.gz(-dtb)`), the
compiler in the version string, the serial console, and the tune. Get
TARGET_ARCH, the image type, the console and the tune right first (found on
mindphone, set up arm64 and wrong on every count; see device-mindphone.md).

### Find the stock defconfig via IKCONFIG

Stock IKCONFIG usually names the BSP project, and with it the defconfig in the
vendor GPL drop (mindphone: `k39tv1_bsp_1g` → `k39tv1_bsp_1g_defconfig`). Put the
LuneOS delta in a `file://luneos.cfg` fragment next to the recipe. When the drop
does not name its defconfig, `ARCH=<arch> make savedefconfig` (UBports docs)
minimises a full extracted config back into one.

### Old BSP vs modern toolchain: expect a patch series

A 4.14 MTK BSP took six rounds of layer patches with gcc 14 / binutils 2.4x
(device-mindphone.md has the series). The classes recur on any old tree:
obsolete asm syntax (`#alloc` section flags, upstream 790756c7e022), format
widths against 32-bit `phys_addr_t`, `-Werror` in vendor Makefiles, objects
commented out of a Makefile that the link still needs, and
`CONFIG_FRAME_WARN=2048`.

`unifdef.c` declares `static bool constexpr;`, and `constexpr` is a keyword in
C23, which modern host GCC defaults to (`-std=gnu23`). It recurs on every old
tree (mindphone 4.14, sargo 4.9): pin the host C standard or rename it.

Before a long patch series, **match the toolchain to the Android generation**
(Droidian docs): Droidian packages clang for Android 6.0/9.0/10.0/12.0/14.0 with a
gcc-4.9 fallback, and its rule of thumb is that 4.4+ kernels should compile with
clang. An era-matched compiler sidesteps most of the -Werror/new-keyword breakage
a modern host toolchain provokes. On Qualcomm trees, build with the toolchain
family the tree's own `build.config.common` names: GCC miscompiles the
register-pinned SCM call (kmi-crc-matching.md § Step 4).

### The appended-DTB glob trap (CAF arm64 trees)

`CONFIG_BUILD_ARM64_APPENDED_DTB_IMAGE_NAMES` exists so a product can append only
the device trees it needs. In a correct tree `arch/arm64/boot/Makefile` honours it:

```make
DTB_NAMES := $(subst $\",,$(CONFIG_BUILD_ARM64_APPENDED_DTB_IMAGE_NAMES))
ifneq ($(DTB_NAMES),)
DTB_LIST := $(addsuffix .dtb,$(DTB_NAMES))
DTB_OBJS := $(addprefix $(obj)/dts/,$(DTB_LIST))      # <- the branch that matters
else
DTB_OBJS := $(shell find -L $(obj)/dts/ -name \*.dtb)
endif
```

**Some vendor forks resolve `DTB_LIST` and then never use it**, leaving
`Image.gz-dtb` depending on the bare `find` — so the trim knob is decorative and
every board's dtb is appended. On an SDM660 tree that is 27 blobs / ~8 MB, of which
one is wanted, and it is enough on its own to blow the kernel/ramdisk window
(boot-images.md). Check for the `ifneq ($(DTB_NAMES),)` branch before trusting the
config; UBports' `android_kernel_xiaomi_sdm660` has it, tim-ecoder's
`sdm660-4p19` did not.

Enabling the parent `CONFIG_BUILD_ARM64_APPENDED_DTB_IMAGE` also rewrites
`KBUILD_IMAGE` to `$(KBUILD_IMAGE)-dtb` and surfaces a Kconfig *choice*; pin
`CONFIG_IMG_GZ_DTB=y` rather than relying on first-entry-wins. Name the dtb by its
path under `$(obj)/dts/` — e.g. `"vendor/qcom/sdm660-internal-codec-mtp-athena"`.

### Building a 4.19 CAF tree with a modern GCC and Make

Two traps that are not about the kernel at all (found on athena; see
device-athena.md):

- **GNU Make 4.4** (what OE ships as `make-native`) fails every `techpack/audio`
  subdirectory with `scripts/Makefile.lib:408: *** prerequisites cannot be defined
  in recipes`. Two causes: directives inside `ifeq` blocks indented with **TABs**
  (Make 4.4 reads those as recipe lines), and a bare `export` after each
  `include <soc>auto.conf` — Make 4.4 changed export semantics, and exporting
  kbuild's multi-line command macros wholesale makes the sub-make re-parse them as
  makefile text. Replace the bare `export` with the explicit
  `export $(shell sed 's/=.*//' <the conf just included>)`.
- **`CONFIG_CC_WERROR=y` + GCC 12+** turns long-standing vendor patterns into ~90
  build failures. Keep `-Werror` and demote only the benign classes via
  `$(call cc-option,-Wno-error=<x>)`: `format`, `format-extra-args`, `address`,
  `unused-variable`, `maybe-uninitialized`, `unused-result`, `enum-int-mismatch`,
  `attributes`, `parentheses`, `bool-operation`, `duplicate-decl-specifier`,
  `misleading-indentation`, plus `missing-attributes` and `array-parameter` once
  you build modules (qcacld-3.0). Vendor Makefiles carrying **clang-only**
  `-Wno-error=` spellings (`vla-extension`, `typedef-redefinition`,
  `non-literal-null-conversion`, `fortify-source`) must be wrapped in `cc-option`:
  GCC rejects an unknown `-Wno-error=` outright rather than ignoring it.

GCC's stricter analysis is worth the trouble — on athena it found seven genuine
bugs in shipping code, including a `memset` clearing a quarter of its buffer and an
overflowable `copy_from_user` bound check. Fix those at source; silence only the noise.

### LSE atomics on ARMv8.0 SoCs: keep them off

`CONFIG_ARM64_USE_LSE_ATOMICS` builds ARMv8.1 atomics alongside the LL/SC ones and
picks at runtime with a static key; on an ARMv8.0 SoC (SDM660: Cortex-A73/A53) it
is dead weight. Turn it off to match the reference ROMs: a 4.19 tree marks clang's
assembler `CONFIG_BROKEN_GAS_INST`, so LineageOS and UBports never enable LSE,
while a Yocto build with binutils passes that test and gets a code-generation
difference no shipped ROM has. On such a tree a `can't patch jump_label` warning
on every boot means a static key keeps whatever value it had, so do not assume a
runtime CPU-feature switch is inert just because the hardware lacks the feature
(found on athena; see device-athena.md).

### Framebuffer console as a Tier B debug channel — often does NOT work

Most phones expose no usable UART without a jig, so an early hang shows only as a frozen
bootloader splash, and netconsole / `printk.devkmsg=on` cannot help — they need the
kernel running and the USB gadget up. The obvious idea is to put the kernel log on the
panel:

```
CONFIG_FRAMEBUFFER_CONSOLE=y
CONFIG_FRAMEBUFFER_CONSOLE_DETECT_PRIMARY=y
CONFIG_FONT_SUPPORT=y   CONFIG_FONT_8x16=y
```

plus `CONFIG_VT` and `console=tty0`.

**Treat this as unproven until you see `Console: switching to colour frame buffer device`
in dmesg.** On athena (msm mdss fbdev, 4.19) it was built exactly as above and fbcon
never took over from the dummy console, although `deferred_takeover` was off,
`register_framebuffer()` is used and the fbcon notifier is registered at
`subsys_initcall` (device-athena.md). Two lessons worth more than the technique:

- Several vendor/community kernels ship `console=tty0` on the cmdline with fbcon
  disabled. That is *not* evidence they simply forgot to enable it — enabling it may not
  be sufficient, and assuming it is leads to a wrong conclusion about why their log is
  silent.
- **On a device whose bootloader splash is never cleared, the splash is not a symptom.**
  It looks identical for a dead kernel and for a fully working boot with a live debug
  shell. Never reason from "stuck on the logo"; get a USB-side signal (adb, the
  initramfs gadget's `iSerial`, or any enumeration at all) before concluding anything
  about where boot stopped.

### The phone's own modules

A rebuilt Tier B kernel refuses the phone's own modules
(`disagrees about version of symbol module_layout`): the stock defconfigs set
`CONFIG_MODVERSIONS`, and the LuneOS fragment changes the config. Where the kernel
source includes the modules, build them; force-load only what you cannot build,
and only after checking struct layouts. Tier B has an ABI to keep too: the stock
kernel's layout as seen by every prebuilt `.ko` on the vendor partition. All of
it is in kmi-crc-matching.md (§ Step −1, § Force-loading prebuilt modules,
§ Struct layouts, § Building and shipping your own modules).

### Build and deploy

A Tier B kernel recipe (e.g. `MACHINE=mindphone bitbake linux-greentouch-mindphone`)
builds the kernel and the boot image in one, under `tmp/deploy/images/<machine>/`.
Verify the image against stock by unpacking and diffing the header fields (see
boot-images.md). Kernel changes belong on a shr-distribution kernel branch rather
than living as layer patches.

### Recurring vendor-kernel patch classes (from the other distros' Tier B experience)

Before inventing fixes, check whether the failure matches a documented class.
UBports' porting-notes GSI wiki
(https://github.com/ubports/porting-notes/wiki/Generic-system-image-(GSI))
catalogues recurring *code* patches for vendor kernels:

- **Samsung Qualcomm devices:** disable RKP (control-flow protection) configs and
  Samsung's file-integrity verifier — otherwise early crashes **with no logs at
  all**.
- **Revert tty workqueue changes** to avoid fastboot bootloops.
- **Revert binder security-context patches** for hwbinder HAL stability.
- **Module "magic mismatch ignore" patches** to load vendor-partition kernel
  modules — their cousin of `CONFIG_MODULE_FORCE_LOAD=y`.
- **synx driver PID overflow** on msm-4.19+ kernels.
- **`skip_initramfs` revert** on A8–A10 kernels — without it a repacked boot.img
  never runs your init at all; see boot-images.md for the full trap.

### `pidfd_open()` without `waitid(P_PIDFD)`: GLib reaps nothing (SM-T220, athena, mindphone)

Android's 4.14/4.19 trees carry the 5.3 pidfd work (`pidfd_open()`,
`pidfd_send_signal()`, `CLONE_PIDFD`) but not `waitid(P_PIDFD)`, which is 5.4. Upstream
those are one release apart, so userspace does not probe for the combination:
GLib ≥ 2.74 switches its `GChildWatchSource` to pidfds as soon as `pidfd_open()`
succeeds, then every child reap fails with
`waitid(pid:N, pidfd=M) failed: Invalid argument (22)` and the callback gets a wait
status of -1. Symptoms are in whatever spawns children through GLib: the webOS
media server's pipelines ("exited with status -1"), appinstalld2's package unpack
("Failed to extract package"), anything using `g_spawn` with a child watch.

Check a tree in seconds: `grep -n P_PIDFD include/uapi/linux/wait.h kernel/exit.c`
(absent = broken), or on a running device
`python3 -c "import os,subprocess,time; p=subprocess.Popen(['sleep','0.2']);
fd=os.pidfd_open(p.pid); time.sleep(.5); print(os.waitid(os.P_PIDFD,fd,os.WEXITED))"`.
The fix is upstream commit `3695eae5fee0605f316fbaad0b9e3de791d7dfaf` ("pidfd: add
P_PIDFD to waitid()"); shr-distribution/linux carries a working backport on its
`key2/4.19` and `dnim/4.14.186` branches, and it applied to Samsung's 4.19.191 with
only line-number offsets (five files: `pid.h`, `wait.h`, `exit.c`, `fork.c`,
`signal.c`). On 4.14 it needs one follow-up, "fork: CLONE_PIDFD: do not require a
zeroed *parent_tidptr", because Qt's `QProcess::startDetached()` otherwise fails
with EINVAL; **read `copy_process()` first**, the later 4.19 stable trees do not
have the check and do not need it.

### Vendor trees that stub out `net/bluetooth/hci_sock.c` (Samsung)

Samsung's MediaTek kernels comment out most of `hci_sock.c` and reduce
`hci_sock_create()` to `return 0`. Android never opens an HCI socket. Halium's
bluebinder does (`socket(AF_BLUETOOTH, SOCK_RAW, BTPROTO_HCI)`), `bt_sock_create()`
gets success with `sock->sk == NULL`, and `bt_sock_reclassify_lock()` hits
`BUG_ON(!sk)`; MediaTek's `ipanic_die()` then resets the device, which is a
boot loop of a fixed period (77 s on the SM-T220, 57 s of it in the kernel). Find it
in the ramoops console (`/sys/fs/pstore/console-ramoops-0`, readable in TWRP right
after a loop reset). The fix is to make the file identical to the tag again; on
this tree `net/bluetooth/` differed from v4.19.191 in that one file only, so check
with `diff -r` before writing anything clever.

### Legacy 3.x kernels: what the 16.0 GSI and LuneOS assume

Found on a 3.10 MSM8916 kernel (Galaxy A3 (2015); see device-a3-2015-halium.md);
check each on any pre-4.x Tier B port.

- **`COMMAND_LINE_SIZE` 1024 (arch/arm).** CONFIG_CMDLINE, the boot image's command
  line and a Samsung SBL's 775 bytes (passed on by lk2nd) overflow it, and
  everything past the cut is gone without a warning: `androidboot.baseband` (so
  `ro.baseband=unknown` and rmt_storage refuses to run), `androidboot.mode`,
  `androidboot.serialno`, `mdss_mdp.panel`. `wc -c /proc/cmdline` = 1024 is the
  tell. Raise it to 2048 (arm64 has always used 2048).
- **No `MemAvailable` in /proc/meminfo** before 3.14: memorymanager counts 0 MiB
  available and every app launch ends in "Failed to reclaim required memory. All
  apps were closed". The tenderloin commit "mm: add MemAvailable to
  /proc/meminfo" (si_mem_available()) applies unchanged to 3.4 and 3.10 trees;
  hammerhead, mako and bullhead have it.
- **Paranoid networking off breaks vendor daemons that rely on group net_raw**
  (see `ANDROID_PARANOID_NETWORK` below).
- **No `CONFIG_BT_HCIVHCI` / `CONFIG_RFKILL`** in an old defconfig: bluebinder
  exits "No such device".

---

## The kernel command line

- **Bootloaders mangle it.** sargo's bootloader drops arguments it does not
  recognise (measured with a `zz.marker=1` canary; device-sunfish.md), and
  MediaTek's G99 lk drops the first 20 characters of the boot image command line
  (device-q25.md). Anything LuneOS needs goes in `CONFIG_CMDLINE`, not the boot
  image header.
- **Set `CMDLINE` in any recipe that requires meta-oe's `linux.inc`.** It
  unconditionally writes `CONFIG_CMDLINE="${CMDLINE} ${CMDLINE_DEBUG}"`, so with
  `CMDLINE` unset the vendor's built-in string (`root=`, `vmalloc=`, …) is silently
  replaced (found on radon; see device-radon.md).
- **`cgroup_disable=net_prio`** breaks a boot- and shutdown-time deadlock wherever
  LXC + connman run on a MediaTek `ccmni` modem: `net_prio`'s `cgrp_css_online()`
  takes rtnl under cgroup_mutex while connmand holds rtnl waiting on an events
  work item whose kworkers wait on cgroup_mutex (device-q25.md).
- **Never put `netconsole=` on the cmdline of a configfs-gadget kernel**: a
  target whose device does not exist at init makes `init_netconsole()` unwind
  entirely, taking the dynamic configfs interface down with it (verified in the
  athena 4.19 source). Attach dynamically from the initramfs instead (debugging.md)
  and put `printk.devkmsg=on` on the cmdline so the dmesg replay isn't ratelimited.

### selinux=0: do not pass it on a Halium port

The fleet convention is `androidboot.selinux=permissive` and nothing else. That is
an **Android-init property, not a kernel parameter** — the kernel ignores it, and
the kernel's own SELinux stays enabled. Two reasons:

- **The token is half of a pair where it is copied from.** UBports' SDM660
  `deviceinfo` carries `selinux=0 … apparmor=1 security=apparmor` with
  `CONFIG_DEFAULT_SECURITY="apparmor"`: Ubuntu Touch is swapping the LSM for
  AppArmor, not disabling it. Copying only `selinux=0` puts nothing in the slot, and
  the Android container wants the `security.selinux` xattr handler live. Droidian's
  GKI `CONFIG_CMDLINE` example carries it too.
- **It broke mounting on athena.** With `selinux=0` on a CIP 4.19 tree (the one with
  the backported 5.x LSM framework, § Fragment traps), `mount(2)` returned
  **ENOENT** for every block-backed filesystem while tmpfs mounted; the same kernel
  under Android's recovery ramdisk, without the token, logged
  `SELinux: Initializing.` and mounted ext4. No mechanism is confirmed
  (device-athena.md).

When two boots of *identical kernel bytes* differ, diff the two
`Kernel command line:` lines first — one grep, and often the whole answer. Check
what the rest of your ports do before adding a kernel-side token that only one
device has.

---

## Cross-distro config lists — use with care

Both UBports and Droidian publish "required kernel config" lists for Halium-style
ports. They are good references — **but both enable options LuneOS leaves off,
some of them KMI-poison on a Tier A kernel.** Know why before copying anything.

UBports' minimal `halium.config`
(https://docs.ubports.com/en/latest/porting/build_and_boot/standalone_kernel_build.html):

```
CONFIG_DEVTMPFS=y
CONFIG_FHANDLE=y
CONFIG_SYSVIPC=y
CONFIG_IPC_NS=y
CONFIG_NET_NS=y
CONFIG_PID_NS=y
CONFIG_USER_NS=y
CONFIG_UTS_NS=y
CONFIG_VT=y
```

Droidian's requirements (docs + their 5.10 fragments) likewise mandate
`SYSVIPC`, `IPC_NS`, `PID_NS`, `NET_NS`, `UTS_NS` (FANOTIFY commented out).

LuneOS does not need `SYSVIPC`/`IPC_NS`, and `USER_NS` stays off on the Q25's
tree for KMI reasons (device-q25.md). The difference is architectural, not an
error on either side: UBports and Droidian build a **per-device kernel package**
and do not reload the *stock* vendor modules against it, so KMI preservation is
not a constraint they have. LuneOS Tier A depends on exactly that property. The
rule:

> Cross-distro fragments are good **Tier B** starting points. They must never be
> applied to a **Tier A** GKI kernel without re-running `kmi-crc-check.py` —
> they will break the "stock vendor_dlkm still loads" property.

Maintained fragment source worth watching: **`droidian-devices/common_fragments`**
(https://github.com/droidian-devices/common_fragments) — branches
`4.14-android`, `4.19-android`, `5.10-android-common` (shared 5.10/5.15), each
with `halium.config`, `droidian.config`, `container.config` (Docker/cgroup set)
and `debug.config`, plus `5.10-android12.config`/`5.10-android13.config` deltas.

### Config facts from the other distros (fold into your fragment thinking)

Each item marked (KMI-check) must go through `kmi-crc-check.py` before use on a
Tier A kernel; the rest are behavioral.

- **`CONFIG_ANDROID_PARANOID_NETWORK` must stay ON** — disabling it for normal
  Linux networking breaks rild on hybris-12.1+ bases. SFOS wraps the capability
  checks in `#ifdef CONFIG_ANDROID_PARANOID_NETWORK` instead of removing the
  option (SFOS hadk-faq). Vendor daemons rely on it too: Qualcomm's
  `rmt_storage` drops to group `net_raw` and fails the IPC router's bind check
  without it, and the modem resets the phone (found on the Galaxy A3 (2015); see
  device-a3-2015-halium.md).
- **`CONFIG_BT_HCIVHCI=y` is bluebinder's kernel prerequisite** — bluebinder
  feeds the Android BT HAL into a virtual HCI (SFOS hadk-hot). The android14-6.1
  fragment carries it as `=m` (the Kleaf route in `build-bootimg.sh` adds
  `hci_vhci` to the GKI module lists).
  Legacy Qualcomm `hci_smd` is `CONFIG_BT_HCISMD` — copy-paste to delete.
- **`CONFIG_USB_CONFIGFS_RNDIS=y`** enables the RNDIS USB-networking debug
  channel (SSH into a half-booted device — see debugging.md). Droidian's symptom
  mapping: "stuck at the glowing logo and RNDIS is not working → check
  CONFIG_USB_CONFIGFS_RNDIS" (Droidian docs). Measured device split: stock GKI
  6.1 (bluejay/panther) has RNDIS **off** but `CONFIG_USB_CONFIGFS_ECM=y`;
  mindphone's 4.14 has RNDIS **on** and ECM off; athena's 4.19 defconfig has
  RNDIS on. The LuneOS initramfs debug network tries both gadget functions, so
  neither needs adding to a fragment just for telnet — but a host talking to
  an ECM gadget must be Linux/macOS (no native Windows driver).
- **`CONFIG_NETCONSOLE=y` + `CONFIG_NETCONSOLE_DYNAMIC=y`** streams kmsg to the
  host over UDP, surviving switch_root (usage: debugging.md). It changes
  `struct net_device`/`net_device_ops`, so it is only safe on a kernel that loads
  no prebuilt vendor network module (kmi-crc-matching.md § NETCONSOLE). The
  tenderloin mainline port instead bakes
  `netconsole=6665@172.16.42.2/usb0,6666@172.16.42.1/` into `CONFIG_CMDLINE`
  for true pre-userspace logging — possible only because it also sets
  `CONFIG_USB_ETH=y` (built-in `g_ether` creates `usb0` at kernel boot); see the
  cmdline rule above for configfs-gadget kernels.
- **pstore/ramoops needs config to exist**: `CONFIG_PSTORE=y`,
  `CONFIG_PSTORE_CONSOLE=y`, `CONFIG_PSTORE_RAM=y`,
  `CONFIG_PSTORE_RAM_ANNOTATION_APPEND=y` (Droidian `debug.config`). Our
  playbook's first debug step assumes ramoops works — on a device that lacks it,
  these options (KMI-check on Tier A) are what create it.
- **Binder device models differ**: Droidian's baseline wants
  `CONFIG_ANDROID_BINDERFS=n` with a static
  `CONFIG_ANDROID_BINDER_DEVICES="binder,hwbinder,vndbinder,anbox-binder,anbox-hwbinder,anbox-vndbinder"`
  — the `anbox-*` triple exists for Waydroid. LuneOS instead mounts **binderfs on
  the host** and binds it into the container. Either model works, but Waydroid
  needs its own binder trio whichever way the nodes are created, plus
  `CONFIG_VETH=y` and `CONFIG_NETFILTER_XT_TARGET_CHECKSUM=y` for its networking
  (Droidian common_fragments).
- **Recent-kernel toggles** seen in Droidian's 5.10 fragments (each KMI-check
  before Tier A use): `CONFIG_LTO_CLANG_FULL=n` + `CONFIG_LTO_CLANG_THIN=y`,
  `CONFIG_ARM64_BTI=n`, `CONFIG_NULL_TTY=y`.
- **Their GKI cmdline example** (in-fragment `CONFIG_CMDLINE`, Droidian):
  `stack_depot_disable=on kasan.stacktrace=off kvm-arm.mode=protected
  cgroup_disable=pressure cgroup.memory=nokmem selinux=0 droidian.lvm.prefer
  console=tty0` — notably `cgroup_disable=pressure`; `console=tty0` also doubles
  as a boot-hang fix (see boot-images.md/debugging.md). Do not copy its
  `selinux=0` (§ selinux=0).

### Vendor floor for the oldest GSI generation

The Halium 9 GSI requires an **Android 9 vendor** as its base — Android 8.0/8.1
vendors are only "experimental" (UBports porting-notes). Record this next to the
vendor-API-level table when triaging very old devices.

---

## Rebuilding one kernel module without a full kernel build

Bitbake's kernel `do_compile` and plain `make modules` both take ~10 minutes on
a tree this size, because LTO relinks every module. When you only changed one
`.c`, neither is necessary. What does **not** work:

- `make ... drivers/foo/` - builds the objects but never links the `.ko`
- `make ... M=drivers/foo modules` - treats an in-tree dir as an external
  module directory and tries to rebuild unrelated files in it, which fails

What works, in seconds: build the object with the directory target, then link
the module by hand exactly as kbuild would:

```sh
export PATH=<clang-prebuilt>/bin:$PATH
make -C $S O=$B LLVM=1 LLVM_IAS=1 ARCH=arm64 \
     CROSS_COMPILE=aarch64-linux-gnu- -j64 drivers/regulator/

cd $B && ld.lld -r --build-id=sha1 -T scripts/module.lds \
    -o drivers/regulator/foo.ko \
       drivers/regulator/foo.o drivers/regulator/foo.mod.o
```

The `.mod.o`/`.mod.c` from the previous full build stay valid as long as the
module's exported symbols have not changed. Get the exact flags from bitbake's
own `temp/run.do_compile.*`, which records the make line verbatim.

Verify before flashing: `strings foo.ko | grep <a string from your change>`.

Combined with the fact that **our modules load fine next to the vendor's**
(same vermagic, KMI verified), this makes single-driver experiments a
sub-minute loop with `adb push` + `rmmod`/`insmod`, instead of a
build-flash-reboot cycle.
