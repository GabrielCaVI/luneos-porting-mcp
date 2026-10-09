# Kernel Porting for LuneOS (GKI Tier A and Legacy Tier B)

The LuneOS kernel-porting method: one GKI kernel per KMI on Tier A devices, a per-device vendor BSP kernel on Tier B, and how to verify both before flashing.

Distilled from the LuneOS GSI/GKI work (Pixel 6a `bluejay`, Pixel 7 `panther`,
MT6739 `mindphone`, Pixel 3a `sargo`). The core insight: on GKI devices
(Android 12+, kernel ≥5.10) you build **one kernel per KMI, not per device** — the stock vendor modules keep loading because the KMI is
binary-stable — while pre-GKI devices need a per-device kernel built from the vendor
BSP source (Tier B). Both tiers hinge on the same three steps: extract the stock
config, compute the LuneOS delta with `mer_verify_kernel_config`, and (Tier A only)
verify KMI compatibility host-side with CRC tooling *before* flashing anything.

---

## Tier A — GKI devices (Android 12+, kernel ≥5.10)

### Step 1: Extract and audit the stock kernel config

Stock Pixel GKI kernels ship `IKCONFIG` (`CONFIG_IKCONFIG_PROC` is in the good list
below), so the config can be extracted from the stock `boot.img` kernel. On bluejay
this produced `stock-gki-config-6.1.145-bp4a.txt`.

Run `mer_verify_kernel_config` (from [mer-hybris/mer-kernel-check](https://github.com/mer-hybris/mer-kernel-check)) on the stock config.
Bluejay stock result: **23 errors, 59 warnings** (`mer-check-stock.txt`). So on a real GKI device
**`gki_defconfig` alone is NOT enough** — but the fragment is small and known.

**Missing hard requirements** (systemd/LuneOS) in stock GKI:

- `DEVTMPFS` (+ `DEVTMPFS_MOUNT`)
- `FHANDLE`
- `TMPFS_POSIX_ACL`, `TMPFS_XATTR`
- `VT`
- netfilter/PPP/L2TP error items: `NF_LOG_IPV4/6`, `IP_NF_MATCH_RPFILTER`,
  `INET_AH`/`INET6_AH`, `INET_IPCOMP`, `PPP_*`, `L2TP_*`, `NET_L3_MASTER_DEV`,
  `DUMMY`, `QUOTA_NETLINK_INTERFACE`, `STATIC_USERMODEHELPER` off
- Also off in stock: `USER_NS`, `PID_NS`, `AUTOFS_FS`, `SQUASHFS`, `CHECKPOINT_RESTORE`

**Not required:** `SYSVIPC` (and with it `IPC_NS`). LuneOS does not use SysV IPC;
leave `# CONFIG_SYSVIPC is not set`.

**Already good in stock GKI**: `NAMESPACES`, `NET_NS`, `UTS_NS`, `CGROUPS`
(+freezer, memcg, v2), `EXT4`, `F2FS`, `OVERLAY_FS`, `VETH`, `BRIDGE`, `TUN`,
`BLK_DEV_LOOP`, `BLK_DEV_DM`, binder+binderfs, `FUSE`, `SECCOMP`, `IKCONFIG_PROC`.

### Step 2: Understand the KMI/MODVERSIONS constraint

GKI kernels build with `CONFIG_MODVERSIONS=y` (`MODULE_SIG_FORCE` is **not** set on
bluejay). Config options that add fields to core structs (e.g.
`CONFIG_NET_L3_MASTER_DEV` adds `l3mdev_ops` to `struct net_device`) change the genksyms CRCs of exported symbols. Under
MODVERSIONS, the stock vendor modules (vendor_boot dlkm fragment + `vendor_dlkm`,
or on A13-launch devices `vendor_kernel_boot` + `vendor_dlkm`) then **refuse to
load** against your rebuilt kernel — and losing them loses the whole Tier A property.

This is checkable **host-side, with no device**: build ACK + fragment, then compare
your `Module.symvers` CRCs against the `__versions` sections of the stock `.ko`s.

### Step 3: The KMI-poison list (empirical, per-KMI)

Bisect on bluejay (kernel-only rebuilds, ~5 min each):

```
tools/bazel build --config=use_source_tree_aosp \
  --//build/kernel/kleaf:defconfig_fragment=//luneos:luneos_defconfig \
  //aosp:kernel_aarch64
```

Drift measured with `symvers-drift.py`, load-compatibility with `kmi-crc-check.py`.
The bisect was cumulative: the full fragment drifted 3145 exported-symbol CRCs and
failed 203/203 modules; with `FANOTIFY` and `NET_L3_MASTER_DEV` out drift was **0** and **2/203** failed, with
or without `PID_NS`.

**RESULT — KMI-poison list for `android14-6.1` (bluejay, panther): `FANOTIFY`
and `NET_L3_MASTER_DEV`.** Other kernels poison differently: on sunfish's 4.14
tree it is `FANOTIFY` and `CGROUP_DEVICE` (kmi-crc-matching.md § Why this is not
merely easier but *necessary*); whether `CGROUP_DEVICE` shows up on a given tree
depends on whether the vendor config already enables it, so check rather than
assume. **Drift is a max, not a sum** — poison sets overlap, so a cumulative
bisect hides which option did what, and removing one poisoner while another
stays shows no improvement. Attribute one option at a time
(kmi-crc-matching.md has a three-minute per-object harness for it). Everything else in the fragment — DEVTMPFS(+MOUNT), FHANDLE,
TMPFS_XATTR/POSIX_ACL, AUTOFS_FS, PID_NS, CHECKPOINT_RESTORE, VT,
STATIC_USERMODEHELPER=n, QUOTA_NETLINK, the whole netfilter/PPP/L2TP block — is
KMI-clean: zero CRC drift, 201/203 stock modules load (the 2 failures were
pre-existing ACK-pin skew, not config — see Step 5).

The poison list transfers within a KMI — panther (same `android14-6.1` KMI)
confirmed the same fragment unchanged (204/204 modules, 0 mismatches) — but it is
**a property of the specific KMI and kernel tree, not of GKI universally**. The
Q25 (MT6789) is the counter-case: its stock kernel is MediaTek's *mgk* derivative
of `android12-5.10`, so an ACK build failed 344 of 344 stock vendor modules and
the port builds the device's own tree instead (`linux-zinwa-q25`). On that tree
`USER_NS` stays off as well (off in the delta that took it from 344 failing to 0). `PID_NS` is clean there, as on bluejay. See device-q25.md.

**The working rule: re-derive the poison list per KMI with `kmi-crc-check.py`;
never transplant it between KMIs in either direction.**

**Userland consequences of the poison list staying off:**

- No fanotify (systemd is fine without it).
- No VRF/l3mdev (ofono is fine).
- **LXC must not unshare the IPC namespace** (`IPC_NS` is off; `PID_NS` is
  available), nor the user namespace where `USER_NS` is off (stock GKI, Q25):
  `lxc.namespace.keep = ipc user`.

Escape hatch stays: rebuild all google-modules from source (option B, below) and
ignore KMI entirely.

Final `mer_verify_kernel_config` on the shipped bluejay config
(`mer-check-luneos.txt`): 5 errors, all accounted for — SYSVIPC (not needed) +
NET_L3_MASTER_DEV (KMI-poison), NF_LOG_IPV4/6 (checker predates the 5.13
`NF_LOG_SYSLOG` rename; we set it =y), DUMMY=y (stock Android value; the checker
wants n, contradicting its own stock run).

### Step 4: KMI verification workflow (host-side, no device needed)

1. Extract stock vendor modules from the factory image
   (`tools/extract-vendor-modules.sh` in the build repo reads both the
   `vendor_boot` dlkm fragment and `vendor_kernel_boot.img`).
2. Build the ACK kernel with your fragment (kernel-only target).
3. Run:
   ```
   python3 kmi-crc-check.py <kernel_aarch64_Module.symvers> <dir of stock .kos>
   ```
   It parses `__versions` from the stock `.ko`s with a native ELF parse (host
   `objcopy` can't read aarch64) and resolves module-to-module symbols via the
   stock set's `__crc_*` exports. Target: **0 modules would fail to load**.
4. `symvers-drift.py` quantifies exported-symbol CRC drift between a baseline
   symvers and yours — use it to bisect a config fragment when modules fail.
5. On the device, count the right message. `dmesg | grep -c "Unknown symbol"`
   returned **400** on a healthy MP01 boot — dependency-ordering noise from the
   module-load retry loop (`tcpc_class: Unknown symbol pd_dbg_info`), resolved on
   a later pass. The CRC message is **"disagrees about version"**. Count that one.

Bluejay baseline (stock config, from-source build): 201/203 factory
vendor_boot-dlkm modules load-compatible, 0 CRC mismatches. Panther:
`python3 ../bluejay/kmi-crc-check.py .../out-luneos-tierA/Module.symvers
vkb-modules` → 204 modules checked, 0 would fail to load.

### Step 4b: `CONFIG_MODULE_SIG_PROTECT` must be OFF — a failure class invisible to CRC checks

Found on bluejay (12 Sep 2026), and it is a **new "invisible to CRC" failure
class**: `kmi-crc-check.py` passes, yet the stock vendor modules still never
load. A GKI kernel with `CONFIG_MODULE_SIG_PROTECT=y` refuses (`-EACCES`) to let
a module it did not sign resolve *protected* symbols. A self-rebuilt GKI is not
signed with Google's key, so the phone's **own stock vendor modules count as
unsigned** — Wi-Fi/BT modules silently never loaded in the earlier bluejay kit,
and a CRC-only check cannot see it because the CRCs are fine.

Fix is one config line — `# CONFIG_MODULE_SIG_PROTECT is not set` — while
`MODULE_SIG`/`MODULE_SIG_ALL` stay `=y`; `internal.h` stubs both helpers when the
option is off, so no kernel source patch is needed (found via achunt2143's
bootimg PR, which patched the source instead). Verified KMI-clean, not assumed:
with it off, 203/203 factory vendor modules load, 0 CRC mismatches, and the
option confirmed off by reading the built kernel's IKCONFIG back.

### Step 5: The ACK pin bump (vendor hooks)

The only two bluejay failures at baseline were `vh_mm.ko` and `vh_sched.ko`: they
import vendor-hook tracepoints (`android_rvh_setscheduler_prio`,
`android_trigger_vendor_lmk_kill`, `android_vh_calculate_totalreserve_pages`)
absent from the manifest-pinned ACK checkout. Factory modules (ab14305268) were
built against a *newer* android14-6.1 tag than the manifest pin; the factory kernel
itself is yet another build (ab14219743) — Google ships kernel and modules
decoupled, which itself proves the KMI reliance.

Fix: bump `aosp/` from the manifest pin (6.1.124, `a4662a84a`) to tag
**`android14-6.1-2026-06_r7`** (6.1.172), via detached checkout:

```
git fetch --depth=1 <remote> android14-6.1-2026-06_r7 && git checkout FETCH_HEAD
```

(pre-bump sha saved in `aosp-pin-before-bump.txt`). Result: **203/203 factory
modules load, 0 CRC drift, +454 new exports** (add-only KMI growth).

Caveats:
- A future `repo sync` reverts `aosp/` to the manifest pin — re-checkout the tag
  and re-apply the `modules.bzl` ppp/l2tp trim. The checkout reverts
  `aosp/modules.bzl`; the `common/modules.bzl` edit persists.
- The **full dist fails on the bumped pin**: manifest-pinned google-modules
  (6.1.124-era) don't compile against 6.1.172 headers (`DWC3_LLUCTL` redefined
  -Werror in soc/gs dwc3, VLA in s3c2410_wdt). Irrelevant for Tier A — stock
  vendor modules are the whole point. Use the kernel-only build output
  (`out-luneos-tierA/`), not `out/bluejay/dist/`.

### Step 6: Build commands (Bazel/Kleaf, Pixel Tensor example)

Kernel source manifest:

```
repo init -u https://android.googlesource.com/kernel/manifest -b android-gs-bluejay-6.1-android16
```

= `kernel/common` @ android14-6.1 (path `aosp/`) + ~50 `private/google-modules/*`
repos (soc/gs, display/samsung, wlan/bcm*, bluetooth/broadcom, gpu, aoc, …) +
Kleaf/Bazel tooling (about 10 GB synced).
The same tree contains `private/devices/google/{gs201,pantah}` and
`build_pantah.sh` — the `android-gs-pantah-6.1-android16` manifest branch has the
same project set (only needed for option B on panther).

- Stock validation build: `./build_bluejay.sh --config=use_source_tree_aosp`
  (~7 min on 64 cores; dist has boot.img, dtbo, vendor_dlkm.img, all modules).
  Prebuilt GKI is the default (`--use_prebuilt_gki=true` in device.bazelrc);
  `use_source_tree_aosp` switches to building `//aosp` from source — required for
  any config change.
- LuneOS fragment: `luneos/luneos_defconfig` (+ a BUILD.bazel filegroup), applied
  via `--//build/kernel/kleaf:defconfig_fragment=//luneos:luneos_defconfig`.
- Kernel-only build (the Kleaf route; the Yocto recipe below builds the same
  kernel with plain kbuild):
  ```
  tools/bazel build --config=use_source_tree_aosp \
    --//build/kernel/kleaf:defconfig_fragment=//luneos:luneos_defconfig \
    //aosp:kernel_aarch64
  ```

Add `CONFIG_UEVENT_HELPER=y` + `UEVENT_HELPER_PATH=""` to the fragment: the
initramfs's mdev writes `/sys/kernel/uevent_helper`, which stock GKI doesn't
provide — without it late hotplug events are lost (initial `mdev -s` covers the
normal path, but add it if by-partlabel links come up empty). It is behavioral and
KMI-safe; with it the bluejay kernel is still 203/203 factory-module compatible.

**Kleaf fragment-comment trap** (cost one failed build, 12 Sep 2026): Kleaf
verifies a defconfig fragment by grepping it for the symbol token and **folds
comment lines into the expected value** — so a fragment must not mention, even
in a comment, a symbol it declares. The KMI-poison comment block in the bluejay
fragment is safe only because it names symbols the fragment never declares.

**GKI boot-image machines in the Yocto tree** (generalised for Q25, 12 Sep
2026): `luneos-bootimg-gki` lives in meta-android and machines opt in with
`GKI_BOOTIMG = "1"` in their own machine conf; `GKI_KERNEL_IMAGE_NAME` lets a
machine ask for `Image.gz` instead of `Image.lz4`; and `GKI_CLANG_DIR` /
`GKI_BUILD_TOOLS_DIR` are machine-scoped in local.conf because the Q25's 5.10
kernel wants clang **r416183b** while android14-6.1 wants **r487747c**.
bluejay/panther declare `GKI_BOOTIMG = "1"` +
`PREFERRED_VERSION_linux-halium-gki = "6.1%"`. The only `linux-halium-gki`
recipe is the 6.1 one; the Q25 builds its device tree with `linux-zinwa-q25`
(device-q25.md).

### One kernel per KMI, literally

Panther's stock kernel is **byte-identical** to bluejay's:

```
sha256(panther unpacked-boot/kernel) == sha256(bluejay unpacked-boot/kernel)
= 2be4a595a21371800d989059ae2bb2085ca8df45d44fa86f0d9ab79629ca2ceb
Linux version 6.1.145-android14-11-gc1de4747ac59-ab14219743, clang 17.0.2
```

One GKI per KMI, shipped identically on gs101 and gs201. The LuneOS Tier A kernel
(`out-luneos-tierA/Image.lz4`, ACK 6.1.172 + `luneos_defconfig` incl.
UEVENT_HELPER) is a drop-in for panther with **no rebuild, no second 10 GB sync**.
Re-run `kmi-crc-check.py` against the new device's own `.ko` set to confirm.

### The kernel in bitbake: Google's toolchain, not OE's

`meta-android/recipes-kernel/linux-halium-gki/linux-halium-gki_6.1.bb` builds the
ACK android14-6.1 kernel with the LuneOS fragment using Google's prebuilt clang
17 (**r487747c**, the clang the KMI was frozen with) and plain kbuild — no Bazel,
and **not** OE's cross toolchain, which has never been validated against this KMI;
a silent CRC drift would only show up on the device as vendor modules that do not
load. `luneos-bootimg-gki` (with `meta-android/classes/gki_bootimg.bbclass`)
consumes it by default via `GKI_KERNEL_PROVIDER ?= "linux-halium-gki"`; setting
`GKI_KERNEL_IMAGE` overrides that with an out-of-tree Image, which
`do_deploy[file-checksums]` hashes so a new kernel really does rebuild the boot
images instead of returning stale sstate. `PREFERRED_PROVIDER_virtual/kernel =
"linux-dummy"` in `bluejay.conf`/`panther.conf` only means the rootfs carries no
kernel.

### Option B escape hatch (own vendor modules)

Pixel kernels are fully open source including all vendor modules, so a full
rebuild (kernel + modules + repacked vendor_boot/vendor_dlkm) is available if KMI
preservation ever fails. Build it at the **manifest-matched** state (6.1.124 on
bluejay), where the full dist succeeded — not on the bumped pin. This is a
device-specific fallback that loses the "one kernel per KMI" property but keeps a
port moving. It also ignores the poison list entirely (everything rebuilds against
the new CRCs).

### Anti-rollback (ARB) — check before flashing

Bluejay's bootloader ARB was bumped by Android 13 (Oct 2022) and again by the May
2025 update. A device on Android 16 cannot boot anything older than the May-2025
A15 build; flashing older factory images risks a permanent brick (including the
inactive-slot fallback trap — keep both slots consistent). On such devices there
is **no downgrade ladder**: the port targets the current kernel + vendor + GSI,
full stop. Same shape on panther: never flash older than the installed build; if
the device arrives on a newer build (e.g. Android 17), redo the factory-image
analysis against that build.

---

## Tier B — legacy devices (pre-GKI, vendor BSP kernel)

Case study: **mindphone** (MediaTek MT6739, Android 11, kernel 4.14.186).

### Identify the platform precisely first

From the stock boot.img: 32-bit ARM zImage (gzip inside), Linux
4.14.186-gbba62e33f-dirty, clang 11.0.1 (Android r383902). The SoC is 64-bit but
runs a **32-bit kernel + 32-bit userland** (`bootopt=64S3,32S1,32S1`). The port
was originally set up arm64 (arch-arm64.inc, Image.gz-dtb, qcom cmdline, arm64
defconfig, halium_arm64 GSI) — wrong on every count. Get TARGET_ARCH, the kernel
image type (`zImage`, armv7 build — not Image.gz/arm64), the serial console
(ttyMT0) and the tune right in the machine conf before anything else
(mindphone uses tune-cortexa8, sharing halium sstate with hammerhead/tenderloin).

### Find the stock defconfig via IKCONFIG

Stock IKCONFIG names the BSP project: `k39tv1_bsp_1g` → defconfig is
`arch/arm/configs/k39tv1_bsp_1g_defconfig` in the vendor GPL drop. The LuneOS
delta is a `file://luneos.cfg` fragment next to the recipe
(`recipes-kernel/linux/linux-greentouch-mindphone_git.bb`), ported from the arm64
`k39tv1_64_bsp_defconfig_luneos` with `CONFIG_DUMMY` kept =y. Run
`mer_verify_kernel_config` on the stock config too (mindphone stock: 13 errors /
58 warnings, `mer-check-stock-mindphone.txt`).

### Old BSP vs modern toolchain: expect a patch series

Building a 4.14 MTK BSP with gcc 14 / binutils 2.4x took six rounds of fixes, all
as layer patches next to the recipe:

1. `0001` — obsolete `#alloc` section-flag syntax in 28 arm32 asm files
   (backport of upstream 790756c7e022).
2. `0002` — `%llx` vs 32-bit `phys_addr_t` in mrdump.
3. `0003` — drop `-Werror` from 30 MTK vendor Makefiles.
4. `0004` — re-enable the commented-out Silead gslX680 point-id algorithm object
   (vmlinux link failure otherwise).
5. `0005` — disable `GSL_GESTURE` (only the no_gesture algorithm ships) + fix one
   unguarded u64 division in eccci.
6. `0006` — `constexpr` is a C23 keyword: rename it in `unifdef.c`.

Plus `CONFIG_FRAME_WARN=2048` in luneos.cfg.

The `unifdef.c` fix recurs on every old tree: sargo's 4.9 host tooling stopped
compiling because `unifdef.c` declares `static bool constexpr;` and modern host
GCC defaults to `-std=gnu23`. Pinning the host C standard (or renaming) is enough.

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

Two traps that are not about the kernel at all, hit on athena (see device-athena.md):

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
never took over from the dummy console — fb0 registered at 1.12 s, `console [tty0]
enabled` at 0.001 s, and the switch line was absent from 1406 lines of log. The
`deferred_takeover` config was off, `register_framebuffer()` is used, and the fbcon
notifier is registered at `subsys_initcall`, so the usual explanations did not apply.
See device-athena.md.

Two lessons worth more than the technique:

- Several vendor/community kernels ship `console=tty0` on the cmdline with fbcon
  disabled. That is *not* evidence they simply forgot to enable it — enabling it may not
  be sufficient, and assuming it is leads to a wrong conclusion about why their log is
  silent.
- **On a device whose bootloader splash is never cleared, the splash is not a symptom.**
  It looks identical for a dead kernel and for a fully working boot with a live debug
  shell. Never reason from "stuck on the logo"; get a USB-side signal (adb, the
  initramfs gadget's `iSerial`, or any enumeration at all) before concluding anything
  about where boot stopped.

### Stock vendor modules on a rebuilt Tier B kernel

A rebuilt Tier B kernel refuses the phone's own modules. The LuneOS config
fragment can move struct layouts (`NETCONSOLE` grows `struct net_device_ops`, see
the Titan Pocket below), the stock defconfigs set `CONFIG_MODVERSIONS`, and the
result is `disagrees about version of symbol module_layout` on every one of them.
It is not a niche problem: on mindphone it is the MTK WMT combo driver
(wifi/BT/GPS/FM core, which is not in the GPL kernel drop at all — only built-in
adapter shims), and on sunfish it was every module the vendor ships, taking wifi,
audio, the vibrator, vold's user-0 storage and both DSPs with them, until the
port switched to building its own (kmi-crc-matching.md § Step −1). Where the
kernel source includes the modules, build them; force-loading is for modules you
cannot build.

- set `CONFIG_MODULE_FORCE_LOAD=y` in luneos.cfg — this only makes forcing
  *possible*; something still has to ask for it,
- **derive the list and the order from the vendor's own init**, never hand-write
  one (see hal-userspace.md, "let the vendor's init load them"): `insmod` lines in
  `/vendor/etc/init/*.rc` for the connac era, `/vendor/etc/init.insmod.<hw>.cfg`
  for Qualcomm and the MTK GKI devices, `modules.load` as the fallback,
- escalate per module — plain `modprobe`, then `--force-vermagic`, then `--force`.
  Starting at `--force` hides a real KMI break on a port where only the vermagic
  string differs,
- point `firmware_class.path` at `/android/vendor/firmware` first. The kernel
  resolves `request_firmware()` against the *host* filesystem, not the
  container's.

Force-loading stock modules brought up wifi, BT and GPS on mindphone. **It is
only safe while every struct those modules touch has the stock layout.** `--force` skips the CRC check that would have caught a layout
change, so a mismatch shows up as memory corruption, not as a load error. Tier B
has an ABI to keep after all: not a KMI in the GKI sense, but the stock kernel's
layout as seen by every prebuilt `.ko` on the vendor partition. This is the Tier
B analogue of the Tier A KMI discipline, and it needs the same care.

#### What happens when it breaks: Titan Pocket, 2 Oct 2026

Our MT6771 kernel (TheKit's reverse-engineered ALPS tree + luneos.cfg) booted and
started LuneOS. The Android container then force-loaded the stock connectivity
modules (`wmt_drv`, `wlan_drv_gen3`, `bt_drv`, `gps_drv`, `fmradio_drv`, taint
`FO`), and 22 s into every boot:

```
mtk_wmtd_worker: Unable to handle kernel paging request at 0055aa8d704b2800
pc : 0x55aa8d704b2800   lr : __dev_xdp_attached+0x48/0xa0
 rtnl_fill_ifinfo <- rtmsg_ifinfo <- register_netdevice <- register_netdev
 <- [wlan_drv_gen3] <- wmt_lib_init [wmt_drv]
```

The cause was `CONFIG_NETCONSOLE`, added to luneos.cfg as a debug channel.
It selects NETPOLL, which turns on `NET_POLL_CONTROLLER`, which inserts
`ndo_poll_controller`/`ndo_netpoll_setup`/`ndo_netpoll_cleanup` into the
middle of `struct net_device_ops`. `wlan_drv_gen3`'s ops table was laid out
for stock, so the kernel read `ndo_bpf` from the wrong slot and jumped to
whatever was there. (It was found by reading ramoops out of DRAM, see
debugging.md Stage 0. expdb and two rounds of initramfs instrumentation showed
nothing.)

#### The check: diff struct-affecting options against stock, before flashing

1. Get the stock config from the stock kernel itself. MediaTek stock kernels
   carry IKCONFIG: unpack `boot.img`, gunzip the kernel, then
   `scripts/extract-ikconfig Image > stock.config`.
2. Diff it against your `.config`, including options that are absent on one
   side (treat absent as `n`).
3. For every differing symbol, check whether it appears inside the struct
   bodies prebuilt modules use: `task_struct`, `net_device`,
   `net_device_ops`, `sk_buff`, `sock`, `inode`, `file`, `device`,
   `dev_pm_info`, `wiphy`, `wireless_dev`, `mm_struct`, `cred`, `user_struct`,
   `css_set`, `cgroup`, `perf_event`. A regex over
   `struct X { ... };` in the tree's headers is enough to list the candidates.
4. Anything that hits gets reverted to stock unless you build every module that
   uses that struct yourself.

#### Better: compare the real layouts, using the stock kernel's own headers

Steps 2-3 are a heuristic. If the vendor partition carries **`kheaders.ko`**
(`CONFIG_IKHEADERS`, common on Android 11 MTK vendors), it holds the stock
kernel's complete header tree *with its generated `autoconf.h`*, which makes an
exact check possible:

1. Extract it: the module's data is an xz-compressed tar; find `\xfd7zXZ\0` in
   the `.ko`, decompress from there, untar. Stock MTK headers reach into
   `drivers/misc/mediatek/include` by relative path, which kheaders does not
   carry; symlinking your tree's copy in is fine (platform helpers, not the
   structs under test).
2. Write a probe `.c` that only `#include`s every header family the vendor
   modules use (netdevice, skbuff, cfg80211, sched, fs, device, platform,
   sdio, tty, genetlink, perf_event, ...).
3. Compile it twice with the kernel's own flags plus `-g
   -fno-eliminate-unused-debug-types`: once against your tree and generated
   headers, once against kheaders. Same compiler both times, so only the
   headers and config differ.
4. Diff `sizeof` and every member offset of every struct/union from DWARF
   (pyelftools; flatten anonymous members).

On the Pocket: 1439 structs compared. Validation: compiling the stock side with
`-DCONFIG_NET_POLL_CONTROLLER=1 -DCONFIG_NETPOLL=1` reproduces the crash's
layout exactly (`net_device_ops` 512 → 536 bytes, first difference at
`ndo_set_vf_mac`; `net_device` gains `npinfo`). With the fixed config, 4
differ, all harmless: `cgroup`, `cgroup_root`, `css_set` (extra cgroup
controllers such as CGROUP_DEVICE, which systemd's `DeviceAllow=` uses;
cgroup-core internals) and
`user_struct` (FANOTIFY adds a field in tail padding: same size, same offsets).
It also caught one the heuristic missed: CGROUP_PERF adds fields to
`perf_event` and `perf_cpu_context`, which the vendor `met.ko` profiler uses,
so it went off too.

Also check that every symbol a vendor module imports and your kernel does not
export is exported by another vendor module (`__ksymtab_strings`). On the
Pocket all `mtk_wcn_*` imports resolve to `wmt_drv.ko`.

**Do not use MODVERSIONS CRCs for this on a reconstructed tree.** Comparing the
modules' `__versions` against your `Module.symvers` flagged 15-90 symbols per
module, including `printk` (ours 0x27e1a049, stock 0x985558a1) and
`__stack_chk_fail`, whose declarations involve no structs at all. The stock
kernel was built from Unihertz's real source with Android clang, ours from
TheKit's reverse-engineered tree with GCC, so the CRCs carry noise from
declaration differences that matter to genksyms but not to the ABI. CRC
attribution (kmi-crc-matching.md) works when you build the vendor's own
source; against a reconstruction, compare layouts instead.

What step 3 found on the Pocket, and what was done:

| Option (luneos.cfg) | Struct changed | Fix |
|---|---|---|
| NETCONSOLE → NETPOLL, NET_POLL_CONTROLLER | `net_device`, `net_device_ops` | off; the panic above |
| CGROUP_NET_PRIO | `net_device` (`priomap`, which changes `sizeof`, so `netdev_priv()` of every vendor netdev points at the wrong place) | off |
| BLK_CGROUP (+ MEMCG, already on) → CGROUP_WRITEBACK | `inode` | BLK_CGROUP off, as stock. CGROUP_WRITEBACK has no prompt, so it cannot be turned off on its own |
| CGROUP_PERF (found by the layout probe, not the heuristic) | `perf_event`, `perf_cpu_context` | off, as stock |

What changed no struct the vendor modules use and stayed on: FHANDLE, the
namespaces except IPC_NS, CGROUP_FREEZER, NET_CLS_CGROUP, BT, RFKILL, VT,
DEVTMPFS, CHECKPOINT_RESTORE, SQUASHFS, AUTOFS4. FANOTIFY (`user_struct`) and
CGROUP_DEVICE (`css_set`, `cgroup`) do change listed structs and also stayed on,
because the layout probe showed the change harmless on this kernel: FANOTIFY's
field lands in `user_struct`'s tail padding (same size, same offsets) and the
cgroup structs are cgroup-core internals. Also note what is
not a KMI concern at all: options that change *built-in* code only (e.g. the BT
stack) are invisible to vendor modules unless they call into it.

Caveats:

- `CONFIG_MODVERSIONS` CRCs would have flagged all of this if the modules had
  been loaded without `--force`. If the vendor kernel's vermagic is the only
  thing that differs, match the vermagic instead of forcing (debugging.md 1.14);
  then a struct change fails loudly at insmod instead of corrupting memory.
- Struct bodies are not the whole ABI: inline helpers and macros also bake
  offsets into the module. The struct list above is a practical filter, not a
  proof.
- The comment that used to head the Unihertz luneos.cfg, "Tier B, so there is
  no KMI to preserve", is the assumption this section exists to retire.

**Do not stage the modules in `/lib/modules/$(uname -r)`.** The obvious place is
the wrong one: udev's coldplug autoloads by modalias out of that directory, so a
depmod'd copy of a whole vendor set there makes the *next* boot insmod every
matching vendor module before anything is ready. On the MP01 that pulled in
`mtk_lpm` within a second of udevd starting, froze the SoC, and left the hardware
watchdog bootlooping the device on every boot after the first. Symlink the vendor
`.ko` into a private tree under `/run` instead, out of udev's sight and off
persistent storage, and point `depmod -b` and `modprobe -d` at it
(`mtk-load-modules.sh` does this). This is about a *vendor* module set staged for
force-loading. Modules built with your own kernel do belong in
`/usr/lib/modules/<kver>`, where coldplug autoloading is what you want (see
§ Shipping kernel modules to a device that flashes the generic rootfs).

Two things that are easy to get wrong once the loading itself works:

- **The vendor's cfg does more than load modules.** Qualcomm's
  `init.insmod.<hw>.cfg` interleaves `enable|<sysfs path>` lines that are what
  actually start the DSPs, and the node one of them writes to is created by a
  module earlier on the same list. Walk the file, do not grep the module names
  out of it. On sunfish, a missing `adsp_loader_dlkm.ko` meant no
  `/sys/kernel/boot_adsp/boot` to write to, which meant no ADSP, which surfaced
  as fastrpc "Transport endpoint is not connected" and a device that reported it
  had no sensors.
- **A module that is shipped but not listed gets no chance to be forced.**
  `incrementalfs.ko` is on sunfish's vendor partition and absent from its cfg,
  because Android loads it itself with `finit_module` — a path with no force
  option, so while sunfish force-loaded vendor modules it failed with
  `Exec format error` and vold could not prepare user 0. Name those separately.

Reason from the **vendor partition**, not from the defconfig: what matters is
which `.ko` files the phone actually carries, not which symbols are `=m` in the
kernel tree's defconfig. Guessing from the latter is how sunfish's recipe came to
predict working audio on a device with no ALSA card. `debugfs -R "ls -l /lib/modules"
vendor.img` answers it without root or a loop mount.

Caveat noted: luneos.cfg flips `FW_LOADER_USER_HELPER` off (halium default) while
stock has it on — if MTK wifi/firmware loading misbehaves, revisit.

### Build and deploy

```
cd webos-ports && . ./setup-env
MACHINE=mindphone bitbake linux-greentouch-mindphone
```

deploys `zImage-mindphone.fastboot` (= boot.img) under
`tmp/deploy/images/mindphone/`. Verify against stock by unpacking and diffing the
header fields (see boot-images.md). Kernel changes should eventually land on
shr-distribution `dnim/4.14.186` instead of living as layer files.

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
  modules — their cousin of our `CONFIG_MODULE_FORCE_LOAD=y` route on mindphone.
- **synx driver PID overflow** on msm-4.19+ kernels.
- **`skip_initramfs` revert** on A8–A10 kernels — without it a repacked boot.img
  never runs your init at all; see boot-images.md for the full trap.

Two calibration tricks worth trying before a mindphone-style six-round source-patch
series:

- **Match the toolchain to the Android generation** (Droidian docs): Droidian
  packages clang for Android 6.0/9.0/10.0/12.0/14.0 with a gcc-4.9 fallback, and
  their rule of thumb is that 4.4+ kernels should compile with clang. An era-matched
  compiler sidesteps most of the -Werror/new-keyword breakage that a modern host
  toolchain provokes (our `constexpr`/`#alloc`/`-Werror` rounds were all
  new-toolchain artifacts).
- **`ARCH=<arch> make savedefconfig`** (UBports docs) minimizes a full extracted
  config (IKCONFIG or `/proc/config.gz`) back into a defconfig — useful when the
  BSP drop doesn't name its defconfig as conveniently as mindphone's IKCONFIG did.

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
error on either side: UBports and Droidian build a
**per-device kernel package** and do not reload the *stock* vendor modules
against it, so KMI preservation is not a constraint they have. LuneOS Tier A
depends on exactly that property. The rule:

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
  option (SFOS hadk-faq). Seen from the other side on the Galaxy A3 (2015), whose
  luneos.cfg had it off (copied from sm-t520): Qualcomm's vendor `rmt_storage`
  drops to `setgid(AID_NET_RAW)` and relies on paranoid networking to pass the
  IPC router's bind check, failed with "msm_ipc_router_bind: rmt_storage Do not
  have permissions", and the modem without its EFS reset the phone. Fixed there by
  accepting group net_raw in `net/ipc_router/ipc_router_security.c`
  `check_permissions()`; see device-a3-2015-halium.md.
- **`CONFIG_BT_HCIVHCI=y` is bluebinder's kernel prerequisite** — bluebinder
  feeds the Android BT HAL into a virtual HCI. mindphone's working hci0 (vhci)
  depended on this; we never recorded the config until now (SFOS hadk-hot).
  The bluejay fragment now carries it as `=m`, with `hci_vhci` added to the
  Kleaf GKI module lists in `build-bootimg.sh` (12 Sep 2026). Legacy Qualcomm
  `hci_smd` is `CONFIG_BT_HCISMD` — already flagged elsewhere as copy-paste to
  delete.
- **`CONFIG_USB_CONFIGFS_RNDIS=y`** enables the RNDIS USB-networking debug
  channel (SSH into a half-booted device — see debugging.md). Droidian's symptom
  mapping: "stuck at the glowing logo and RNDIS is not working → check
  CONFIG_USB_CONFIGFS_RNDIS" (Droidian docs). Measured device split: stock GKI
  6.1 (bluejay/panther) has RNDIS **off** but `CONFIG_USB_CONFIGFS_ECM=y`;
  mindphone's 4.14 has RNDIS **on** and ECM off; athena's 4.19 defconfig has
  RNDIS on. The LuneOS initramfs debug network tries both gadget functions, so
  neither needs adding to a fragment just for telnet — but a host talking to
  an ECM gadget must be Linux/macOS (no native Windows driver).
- **`CONFIG_NETCONSOLE=y` + `CONFIG_NETCONSOLE_DYNAMIC=y` — only on a kernel
  that loads no prebuilt vendor network module.** Streams kmsg to the host over
  UDP (the initramfs attaches a dynamic target after the gadget network is up;
  listen with `nc -ul 6666`), surviving switch_root. NETCONSOLE selects NETPOLL
  and `NET_POLL_CONTROLLER`, which add `npinfo` to `struct net_device` and insert
  members into the middle of `struct net_device_ops`: KMI-poison on Tier A, and
  on a Tier B kernel that force-loads stock wifi modules a panic (the Titan
  Pocket above), unless the stock config already had `NET_POLL_CONTROLLER`.
  Safe where the wifi driver is built with the kernel (athena). The tenderloin mainline port instead bakes
  `netconsole=6665@172.16.42.2/usb0,6666@172.16.42.1/` into `CONFIG_CMDLINE`
  for true pre-userspace logging — possible only because it also sets
  `CONFIG_USB_ETH=y` (built-in `g_ether` creates `usb0` at kernel boot).
  **Never put `netconsole=` on the cmdline of a configfs-gadget kernel:**
  verified in the athena 4.19 source, a target whose device doesn't exist at
  init makes `init_netconsole()` unwind entirely, taking the dynamic configfs
  interface down with it. Use dynamic attach from the initramfs plus the
  dmesg replay instead (see debugging.md), and put `printk.devkmsg=on` on the
  cmdline so the replay isn't ratelimited.
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
  console=tty0` — notably `selinux=0` and `cgroup_disable=pressure`; `console=tty0`
  also doubles as a boot-hang fix (see boot-images.md/debugging.md). **Do not
  copy `selinux=0` into a Halium port** (see § selinux=0 made mount(2) return
  ENOENT on a CIP 4.19 tree).

### Vendor floor for the oldest GSI generation

The Halium 9 GSI requires an **Android 9 vendor** as its base — Android 8.0/8.1
vendors are only "experimental" (UBports porting-notes). Record this next to the
vendor-API-level table when triaging very old devices.

---

## mer-kernel-check usage (both tiers)

Location: [mer-hybris/mer-kernel-check](https://github.com/mer-hybris/mer-kernel-check) (Makefile, `mer_verify_kernel_config`,
`mer_verify_kernel_spec`). Run `mer_verify_kernel_config` against any kernel
config — stock (to size the delta) and your shipped config (to confirm what
remains is deliberate). Known checker quirks to not chase:

- It predates the 5.13 `NF_LOG_SYSLOG` rename, so `NF_LOG_IPV4/6` errors persist
  even when the functionality is set (=y).
- It wants `DUMMY=n` while its own stock-config run shows Android ships =y — keep
  the stock Android value.

Interpret errors as "explain or fix", not "fix": on bluejay the final config ships
with 5 errors, every one accounted for.

## The vendor_dlkm module set is never loaded on Halium (Tier A only)

A GKI-era vendor ships kernel modules in **two** sets, and Halium only ever loads
the first:

| Set | Lives in | Loaded by | On Halium |
|---|---|---|---|
| vendor_boot ramdisk | `/lib/modules` in the vendor_boot ramdisk | the initramfs, early, to reach storage | **yes** |
| `vendor_dlkm` | the `vendor_dlkm` logical partition | Android's init, later | **no** |

Halium curtails the container's init on a `wait_for_prop` gate long before it
reaches the second set, and the initramfs cannot load it either (it is a logical
partition inside `super`, needing dm-linear that the initramfs has no tooling
for). So those modules simply never load, on any Tier A device.

On the MP01 that is **164 modules — more than the 159 the initramfs loads.**

The reason this is worth its own section is that the symptoms do not look
remotely like "missing kernel modules":

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
it. Note `modules.load` is a **list, not a dependency
order** — the same trap as in the initramfs — so make repeated passes and stop
when a pass loads nothing new, rather than trusting the file's order.

**Who is affected:** any Android 12+ / GKI device with a `vendor_dlkm`
partition — MP01, where it was found; bluejay's factory image has one too, and
panther has not been flashed yet. **Not** affected:
pre-dynamic-partition devices, which have only one module set. mindphone
(MT6739, Android 11, kernel 4.14, no super/vendor_boot) is the clearest example
and is exactly why the same SoC vendor shows no such problem there. sargo has no
vendor_dlkm either.

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

## Two traps when copying config from another distro's port

### A cmdline token can be half of a pair

UBports' SDM660 `deviceinfo` carries `selinux=0`, and it is tempting to copy
straight into a Halium port. The full line is:

```
selinux=0 … apparmor=1 security=apparmor
CONFIG_DEFAULT_SECURITY="apparmor"    CONFIG_DEFAULT_SECURITY_APPARMOR=y
```

UBports is not disabling the LSM, it is **swapping** it, because Ubuntu Touch
confines apps with AppArmor. A distro that does not use AppArmor and copies only
`selinux=0` turns SELinux off and puts nothing in the slot — no benefit, and the
Android container inside wants the `security.selinux` xattr handler live.

For a Halium port the fleet convention is `androidboot.selinux=permissive` and
nothing else. That is an **Android-init property, not a kernel parameter** — the
kernel ignores it entirely, and the kernel's own SELinux stays enabled. Check
what the rest of your ports do before adding a kernel-side token that only one
device has.

### A symbol that a backported stable tree has deleted

`CONFIG_SECURITY_SELINUX_BOOTPARAM_VALUE=0` is standard advice for Android
kernels and does nothing on CIP 4.19.325. That tree backported the 5.x
SELinux/LSM rework — visible in the built `.config` as `CONFIG_LSM="…"`,
`CONFIG_SECURITY_SELINUX_SIDTAB_HASH_BITS`, `CONFIG_SECURITY_LOCKDOWN_LSM` on a
4.19 kernel — and that rework **deleted the symbol** in favour of

```c
int selinux_enabled_boot __initdata = 1;      /* security/selinux/hooks.c */
__setup("selinux=", selinux_enabled_setup);
```

`merge_config.sh` drops a symbol that is not in Kconfig **silently**, with no
warning in `log.do_configure`. This is the same family as the comment trap but
worse, because the line looks correct and greps clean.

**Check the merged `.config`, not the fragment** — that rule already applies to
mer-kernel-check and it applies here. A long-term stable tree (CIP, and Android
LTS) can have newer infrastructure than its version number suggests; grep
`security/selinux/Kconfig` in the actual source before trusting a Kconfig name.

## selinux=0 made mount(2) return ENOENT on a CIP 4.19 tree

On athena, `mount(2)` returned **ENOENT** for every block-backed filesystem
while tmpfs mounted fine, a bogus fstype correctly gave ENODEV, raw block I/O
worked and `fsck.ext4 -n` read the same partition happily. `ext4_fill_super` was
never reached. The fix was removing **`selinux=0`** from the kernel command
line, leaving only `androidboot.selinux=permissive` (an Android-init property
the kernel ignores, so the kernel's own SELinux stays enabled).

**The evidence was a two-log comparison, and it is the cheap diagnostic:**

| | cmdline | dmesg | mount |
|---|---|---|---|
| our initrd | has `selinux=0` | no SELinux line at all | ENOENT |
| Android recovery ramdisk | no `selinux=0` | `SELinux: Initializing.` | EXT4 mounts |

Same kernel build in both. When two boots of *identical kernel bytes* differ,
diff the two `Kernel command line:` lines first - it is one grep and it is often
the whole answer.

**No mechanism is confirmed.** A denial is EACCES, not ENOENT, and with SELinux
unregistered there should be no inode hooks at all. The suspicious ingredient is
that this is a 4.19 tree carrying a **backported 5.x LSM framework** - the built
`.config` shows `CONFIG_LSM="..."`, `SECURITY_SELINUX_SIDTAB_HASH_BITS` and
`SECURITY_LOCKDOWN_LSM` on a 4.19 kernel, and
`CONFIG_SECURITY_SELINUX_BOOTPARAM_VALUE` has been deleted in favour of a
hardcoded `int selinux_enabled_boot __initdata = 1;`. Disabling the default
major LSM at boot on a partial backport is the kind of thing that leaves LSM
blob offsets inconsistent between the code that reserved them and the code that
reads them, which would produce exactly this: an arbitrary errno from a path
walk that has no business failing. Worth confirming before relying on it.

**Rule: on a Halium port, do not pass `selinux=0`.** The fleet convention is
`androidboot.selinux=permissive` and nothing else. See the paired-token trap
above for where the `selinux=0` came from.

## LSE atomics on an ARMv8.0 SoC: keep them off

`CONFIG_ARM64_USE_LSE_ATOMICS` builds the ARMv8.1 large-system-extension atomics
alongside the LL/SC ones and chooses at runtime with a static key. SDM660 is
Cortex-A73/A53 - **ARMv8.0**, no LSE - so the feature is dead weight there. Turn
it off to match the reference ROMs: a 4.19 tree marks clang's assembler
`CONFIG_BROKEN_GAS_INST`, so LineageOS and UBports never enable LSE, while a Yocto
build with binutils passes that test and gets a code-generation difference no
shipped ROM has. On athena it fixed nothing; the mount ENOENT was `selinux=0`
(section above).

The same tree logs `can't patch jump_label` (`WARNING ... kernel/jump_label.c:385
__jump_label_update`) on every boot, working or not, so it explains no failure on
its own. A static key that cannot be patched keeps whatever value it had, though,
so on such a tree do not assume a runtime CPU-feature switch is inert just because
the hardware lacks the feature.

## Shipping kernel modules to a device that flashes the generic rootfs

A Tier B port that flashes the **generic** `halium-arm64 luneos-dev-image` has
nowhere for its kernel modules to live. That image is arch-generic by design
(`generic-rootfs-qa.bbclass`), is built against no particular kernel, and ships
no `/lib/modules` at all. So the tissot/mido pattern

```
MACHINE_EXTRA_RDEPENDS = " … kernel-module-wlan … "
```

**cannot be copied**: it works there because each of those machines builds its
own complete image, and there is no `MACHINE=<device>` rootfs here for it to
land in. sargo has the same shape and carries an unresolved
`# kernel-module-wlan` comment in its machine conf for exactly this reason.

Two routes work. Ship the modules in the **machine initramfs** and stage them
into place at boot (kmi-crc-matching.md § How to ship your own modules; sunfish,
bramble), or **inject them into the built `rootfs.img`** as below (athena). Both
are for modules built with your own kernel; a prebuilt vendor set stays on the
vendor partition (see the `/lib/modules` warning in the Tier B section).

On athena this is the difference between WiFi and no WiFi: `CONFIG_QCA_CLD_WLAN=m`
is the only module in the config, and the vendor's own `wlan.ko` will not load
(`disagrees about version of symbol module_layout` - `module_layout`'s CRC
encodes `struct module`, so the configs genuinely differ, and
`CONFIG_MODULE_FORCE_LOAD` is not set).

### Inject them into rootfs.img with debugfs - no root, no loop mount

The same trick `android-system-image-tissot.bb` and `-mido-halium.bb` use to
patch images at build time works for a whole module tree:

- Write to **`/usr/lib/modules/<kver>`**, not `/lib/modules`. The rootfs is
  usrmerged - `/lib` is a *symlink* - and debugfs does not resolve paths through
  symlinks.
- debugfs has no `mkdir -p` and no recursive put: walk the tree and emit one
  `mkdir` per directory, parents first.
- `write` refuses to overwrite, so emit `rm` before each `write` to stay
  idempotent.
- debugfs stamps the invoking uid/gid; follow each write with
  `sif <path> uid 0`, `gid 0`, `mode 0100644`.
- Run `depmod -b <staging>` on the host so the image gets a real `modules.dep`
  and `modprobe` works on device.
- Drop a `/etc/modules-load.d/<device>.conf` in as well - the generic rootfs
  already has `systemd-modules-load.service`, so no unit is needed.
- Expected noise to filter: `File not found` from the pre-emptive `rm` on a
  first run, `already exists` from `mkdir` on a re-run, and (below 5.2)
  `depmod: could not open modules.builtin.modinfo`, which landed in 5.2.

### The deployed modules tarball is not stripped

Do not feed `modules-<machine>.tgz` from `tmp/deploy` into that. `kernel.bbclass`
builds it with

```
tar $TAR_ARGS -cv -C ${D}${root_prefix} lib | gzip -9n > $deployDir/modules-….tgz
```

from **`${D}`**, the pre-strip install tree. OE's stripping happens later in
`do_package` against `${PKGD}`, so the split package `kernel-module-<name>-<kver>`
has the stripped copy while the deploy tarball keeps full debug info. On athena
that is **330,879,592 B vs 9,115,216 B** for the same `wlan.ko`, against ~700 MB
free in the rootfs.

This is upstream behaviour on every machine, not a recipe bug. Repack from
`packages-split/kernel-module-*` instead, and guard the injector with a
`readelf -S … | grep .debug_info` check - a host `strip` cannot help you
(`Unable to recognise the architecture of the input file`).

## Legacy kernels: what the 16.0 GSI and LuneOS assume that a 3.x vendor kernel lacks (Galaxy A3 (2015), 8 Oct 2026)

Found on a 3.10 MSM8916 kernel; check each on any pre-4.x Tier B port.

- **`COMMAND_LINE_SIZE` 1024 (arch/arm).** CONFIG_CMDLINE, the boot image's command line and a Samsung
  SBL's 775 bytes (passed on by lk2nd) overflow it, and everything past the cut is gone without a
  warning: `androidboot.baseband` (so `ro.baseband=unknown` and rmt_storage refuses to run),
  `androidboot.mode`, `androidboot.serialno`, `mdss_mdp.panel`. `wc -c /proc/cmdline` = 1024 is the
  tell. Raise it to 2048 (arm64 has always used 2048).
- **No `MemAvailable` in /proc/meminfo** before 3.14: memorymanager counts 0 MiB available and every app
  launch ends in "Failed to reclaim required memory. All apps were closed". The tenderloin commit
  "mm: add MemAvailable to /proc/meminfo" (si_mem_available()) applies unchanged to 3.4 and 3.10 trees;
  hammerhead and mako have it, bullhead got it on 8 Oct 2026.
- **Paranoid networking off breaks vendor daemons that rely on group net_raw** (see the bullet above).
- **No `CONFIG_BT_HCIVHCI` / `CONFIG_RFKILL`** in an old defconfig: bluebinder exits "No such device".



## `pidfd_open()` without `waitid(P_PIDFD)`: GLib reaps nothing (SM-T220, athena, mindphone)

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

## Vendor trees that stub out `net/bluetooth/hci_sock.c` (Samsung)

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
