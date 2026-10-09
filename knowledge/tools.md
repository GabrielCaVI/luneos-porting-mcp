# Porting & Debug Tools Reference

The small, self-contained porting and debug tools built during the LuneOS GSI/GKI work, with usage and location.

Most are pure-stdlib Python or shell so they run on any host with no device
attached — the porting method leans hard on host-side verification (KMI checks,
module-order analysis, boot-image diffing) *before* anything is flashed. The KMI tools are published in
[luneos-bootimg-bluejay](https://github.com/Herrie82/luneos-bootimg-bluejay) `tools/` so anyone can verify against their own factory image;
tools marked *unpublished* exist only in the maintainer's working tree so far.

---

## kmi-crc-check.py

**Purpose:** answer "will the stock vendor modules load against my rebuilt GKI
kernel?" entirely host-side. Under `CONFIG_MODVERSIONS`, a module loads only if
the CRCs in its `__versions` section match the kernel's exported-symbol CRCs.

**How it works:** parses `__versions` from stock `.ko`s with a **native ELF
parse** (host `objcopy` cannot read aarch64 objects), compares against the
build's `kernel_aarch64_Module.symvers`, and resolves module-to-module symbols
via the stock set's own `__crc_*` exports.

**Usage:**

```
python3 kmi-crc-check.py <Module.symvers> <dir of stock .kos>
# e.g. (panther, reusing bluejay's kernel build):
python3 kmi-crc-check.py \
    <bluejay kernel out>/Module.symvers \
    vkb-modules
→ 204 modules checked, 0 would fail to load
```

**Target:** 0 failures. Known-good baselines: bluejay 203/203 after the ACK pin
bump (201/203 before — the two `vh_*` fails were pin skew), panther 204/204.

**Location:** `tools/kmi-crc-check.py` in [luneos-bootimg-bluejay](https://github.com/Herrie82/luneos-bootimg-bluejay).

## symvers-drift.py

**Purpose:** quantify exported-symbol CRC drift between two symvers files —
the bisect instrument for finding which config options poison the KMI. On
bluejay (android14-6.1) it took the fragment from 3145 drifted symbols to **0**;
the poisoners there are FANOTIFY and NET_L3_MASTER_DEV. The list is per KMI and
tree; method in kmi-crc-matching.md § Poison options.

**Location:** `tools/symvers-drift.py` in [luneos-bootimg-bluejay](https://github.com/Herrie82/luneos-bootimg-bluejay).

## module-order.py

**Purpose:** prove whether a device's `modules.load` is dependency-ordered (it
never is) and compute a correct order. Reads `modules.load`, `modules.dep` and
`modules.softdep`; reports hard-dependency pairs listed backwards, softdep edges
not implied by modules.dep, deps missing from the ramdisk, whether the
modules.dep closures are self-ordered, and the resolved order with remaining
violations.

**Usage:**

```
python3 module-order.py <lib/modules dir>
```

**Measured results:**

| | bluejay | panther |
|---|---|---|
| modules in `modules.load` | 203 | 204 |
| hard-dependency pairs listed backwards | 335 (99 modules) | 332 (107 modules) |
| `softdep pre:` edges not implied by `modules.dep` | 14 | 15 |
| deps missing from the ramdisk | 0 | 0 |
| resolved order | 203, 0 violations | 204, 0 violations |

The initramfs `init` implements the same resolution in ~40 lines of busybox awk;
this tool is the independent cross-check (outputs verified identical).

**Location:** unpublished.

## payload_extract.py

**Purpose:** list/extract partition images from an Android A/B OTA
`payload.bin`. Pure stdlib — no protobuf install needed. This is how the entire
mindphone platform analysis started (the full OTA was the only artifact
available).

**Usage:**

```
python3 payload_extract.py payload.bin              # list partitions
python3 payload_extract.py payload.bin outdir boot dtbo   # extract named ones
python3 payload_extract.py payload.bin outdir all   # extract everything
```

Works on FULL payloads (mindphone's was 717 MB, minor_version=0, 16 partitions).

**Location:** unpublished.

## unpack_bootimg.py

**Purpose:** unpack/inspect boot images with header v0–v2 — kernel, ramdisk,
dtb, and all header fields (load addresses, offsets, cmdline, os_version).
Use it to record the stock header recipe and to sanity-check every image you
build: `./unpack_bootimg.py boot-luneos.img /tmp/x`, then diff the printed
fields against the stock table. It also identified mindphone's v2 dtb field as
an AOSP dt_table (magic `0xd7b7ab1e`), not a bare FDT.

**Location:** unpublished.

## mtkclient — reading `expdb` when the device cannot talk (MediaTek)

<https://github.com/bkerler/mtkclient>

The MediaTek answer to "the device resets and there is no console, no adb and no
pstore". MediaTek SoCs keep an **exception database** in a partition called
`expdb`: preloader/lk logs, the AP watchdog status, and the kernel's last
`RAM_CONSOLE` — i.e. the kmsg from *before* the reset. It is readable over the
preloader/BROM USB connection, which still enumerates on a device that boots
nothing at all.

```sh
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt && pip install .
sudo cp mtkclient/Setup/Linux/*.rules /etc/udev/rules.d/ && sudo udevadm control --reload-rules
sudo systemctl stop ModemManager      # it grabs 0e8d:2000 inside the handshake window
mtk r expdb expdb.bin                 # READ ONLY
strings expdb.bin | grep -iE "initrd:|Kernel panic|wdt_status|RAM_CONSOLE" | tail -40
```

The entry point moved between versions: newer trees install a console script
`mtk`, older ones have `mtk.py` in the repo root. Catching the device: leave it
bootlooping and mtkclient will grab the preloader as it cycles past; if not,
power fully off and plug in holding **Volume Down** to force BROM.

**Only ever use `mtk r`.** The same tool writes partitions and reflashes the
preloader, and a bad preloader write is the one genuinely hard-to-recover brick
on MediaTek.

A wrapper script (`dump-expdb.sh`, unpublished) does all of the above, including
the greps, and takes `--analyse` to re-read an existing dump.

## edl — the Qualcomm counterpart

<https://github.com/bkerler/edl> (same author; `strongtz/edl-ng` is a newer fork)

Sahara (bootrom protocol, uploads a programmer to RAM) + Firehose (the
programmer's protocol, does partition read/write). `edl r <partition> out.bin`
is the analogue of `mtk r`.

**It is not as good a story as mtkclient, and you should not plan around it.**
Firehose needs the *signed firehose programmer* for that specific SoC, which
Qualcomm does not publish and vendors rarely leak — without it EDL 9008 mode
gets you nowhere. There is also no single `expdb`-equivalent partition: Qualcomm
crash state lives in ramdumps (Sahara MemoryDebug mode, USB PID 0x900E, only if
the device is fused for it) or in `rawdump`, both device-dependent.

In practice **on Qualcomm (and Tensor) you use ramoops/pstore instead** where the
kernel has it (debugging.md Stage 0; bluejay's boot panic was read from
`/sys/fs/pstore/console-ramoops-0`), and no LuneOS port has needed EDL. Where the
kernel has no ramoops at all (athena), a pre-initramfs failure is invisible. The
MediaTek situation is the unusual one: pstore is often not configured, so `expdb`
is the only record.

## mer-kernel-check (`mer_verify_kernel_config`)

**Purpose:** check a kernel config against the Mer/Halium/systemd requirement
list. Run it on the *stock* config (extracted via IKCONFIG) to size the LuneOS
delta, and on the *shipped* config to confirm every remaining error is
deliberate. Reference results: kernel-porting.md § The config delta.

**Known quirks (don't chase these):**
- predates the 5.13 `NF_LOG_SYSLOG` rename → `NF_LOG_IPV4/6` stay "errors" even
  when set =y;
- wants `DUMMY=n` while stock Android ships =y (contradicting its own stock run).

**Syntax note:** a rule prefixed with `!` is downgraded to *optional* (SFOS's
documented example is the obsolete `NETFILTER_XT_MATCH_QTAGUID`) — use it to
quiet rules for options that no longer exist rather than deleting them.

**Location:** [mer-hybris/mer-kernel-check](https://github.com/mer-hybris/mer-kernel-check) (Makefile, `mer_verify_kernel_config`,
`mer_verify_kernel_spec`).

## extract-vendor-modules.sh

**Purpose:** pull the stock vendor kernel modules out of a factory zip for KMI
checking. Reads both layouts: the `vendor_boot` DLKM ramdisk fragment
(A12-launch, bluejay) **and** `vendor_kernel_boot.img` (A13-launch, panther) —
tested on both factory zips.

**Location:** `tools/extract-vendor-modules.sh` in [luneos-bootimg-bluejay](https://github.com/Herrie82/luneos-bootimg-bluejay).

## mkbootimg / mkdtboimg

AOSP tools used for hand assembly:
- `mkbootimg` — see boot-images.md for the exact mindphone v2 command with
  base/offsets. For v3/v4 the Yocto writer below replaces it.
- `mkdtboimg.py create` — wrap a self-built dtb into the dt_table format that
  MTK lk (and the v2 dtb field) expects.

The Yocto v3/v4 writer `meta-android/lib/halium/bootimg.py` reproduces AOSP
`mkbootimg.py` **byte-identically** across all four shipped shapes (kernel-only,
ramdisk-only, kernel+ramdisk, kernel+ramdisk+`enable_adb`).

## avbtool

`avbtool make_vbmeta_image --flags <n>` builds a verification-disabled vbmeta;
which flags value and why: installing.md § vbmeta: flags 2 vs flags 3.
`avbtool add_hash_footer` can append an unsigned hash footer to a self-built
boot.img for footer-expecting tooling — not required once verification is off.

## lxc-checkconfig

**Purpose:** one-shot validation, on the booted device, that the running kernel
has every namespace/cgroup option LXC needs — a post-hoc complement to
`mer_verify_kernel_config` (which checks a config file pre-build). Expect the IPC
namespace to show missing where `SYSVIPC` is off (LuneOS does not need it) and
the User namespace wherever `USER_NS` is off (stock GKI, Q25); the rest should show
enabled. Pair with `lxc-ls --fancy` for
container state at a glance (Halium/Droidian docs).

## parse-android-dynparts (host-side inspection)

**Purpose:** map a `super` image's logical partitions on a workstation — read the
vendor fstab/manifest of a factory image *before* ever flashing the device. The
image must be raw (`simg2img` a sparse one first):

```
losetup -r /dev/loop0 super.img
dmsetup create --concise "$(parse-android-dynparts /dev/loop0)"
# partitions appear at /dev/mapper/dynpart-<NAME>
# teardown:
dmsetup remove /dev/mapper/dynpart-*
losetup -d /dev/loop0
```

Drop `-r` for write access. Build: cmake + OpenSSL
(https://github.com/droidian/parse-android-dynparts). On-device usage (mounting
the real super at boot) is covered in architecture.md/debugging.md.

## libhybris test binaries & binder-list

libhybris ships per-subsystem smoke tests usable before any middleware exists:
`test_hwcomposer`, `test_egl`, `test_vibrator`, `test_gps`, `test_audio`
(`test_sensors` is legacy-HAL era, Android ≤7). From libgbinder (which LuneOS
ships): `binder-list -d /dev/hwbinder` / `-d /dev/binder` verifies HAL
registration; an empty listing can mean the gbinder **API level** in
`/etc/gbinder.conf` is wrong for the Android base. Usage and the escalation
order live in debugging.md (Stages 3–4).

## evdev_trace

**Purpose:** enumerate input devices *with capability decoding* (mce-tools):
`evdev_trace -i`. A device with `EV_FF`/`FF_RUMBLE` is the vibrator; one with
`SW_HEADPHONE_INSERT`/`SW_MICROPHONE_INSERT` is the jack; touchscreen and keypad
nodes identify themselves the same way. Use it before pinning touch or key nodes
in an adaptation's `deviceinfo` (nyx-modules.md), so the pins are **measured**
rather than copy-pasted — the capability-decoding upgrade over the raw `evtest` used on
mindphone (SFOS hadk-faq/hadk-hot).

## HGABT (halium-generic-adaptation-build-tools)

UBports' standalone kernel/boot-image builder, driven by a `deviceinfo` file —
entry point `./build.sh -b workdir` (downloads toolchains, clones the kernel
from deviceinfo vars, builds, packs the boot image)
(https://gitlab.com/ubports/porting/community-ports/halium-generic-adaptation-build-tools).
Script inventory and the full `deviceinfo` variable reference:
deviceinfo-reference.md § HGABT script inventory.

## scp-in-place GSI testing

To iterate on a system image without a reflash loop: `simg2img` the build
output and `scp` it straight over `/var/lib/lxc/android/android-rootfs.img` on
a running device, then restart the container (Droidian docs). Applies directly
to testing rebuilt Halium GSIs.

## The bitbake route (preferred once a machine exists)

```
MACHINE=bluejay bitbake initramfs-android-image
MACHINE=bluejay bitbake luneos-bootimg-gki      # same for panther
MACHINE=mindphone bitbake linux-greentouch-mindphone   # Tier B: kernel+bootimg in one
```

Outputs land in `tmp/deploy/images/<machine>/`: `boot-<machine>-luneos.img`,
`boot-<machine>-luneos-debug.img`, plus `init_boot-<machine>-luneos.img` on
A13-launch machines (`ANDROID_BOOTIMG_INIT_BOOT = "1"`). The initramfs from
bitbake is the canonical one — it carries the module-loader/cmdline-params and
userdata-resize fixes via `initramfs-scripts-halium`, and has been *newer* than
hand-maintained overlay ramdisks in practice (it picked up the find-the-Android-
image fix the hand kits lacked). The GKI kernel recipe and `GKI_KERNEL_IMAGE`:
kernel-porting.md § Step 4.

## build-bootimg.sh (luneos-bootimg-bluejay repo)

Self-contained end-user build of the boot image only: repo sync → ACK pin
(re-checkout of `android14-6.1-2026-06_r7`) → `luneos_defconfig` fragment →
modules.bzl trim → kernel-only bazel build → initramfs patch
(`overlay/init-gki-modules.diff`, reproduces the patched init byte-exact) →
mkbootimg ×2 (normal + `enable_adb` debug). README documents the KMI-poison
list, the two module-loading init fixes (dependency order, cmdline module
parameters; boot-images.md § Init patch history), the ARB warning and Tensor/Mali
status. Also in the repo: `tools/{kmi-crc-check,symvers-drift}.py` and
`tools/extract-vendor-modules.sh`. Ships the KMI tools so users can verify against their own factory image.
