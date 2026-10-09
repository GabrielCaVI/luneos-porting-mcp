# Matching a vendor's kernel: vermagic, CRCs, struct layouts and your own modules

Everything about whether a vendor `.ko` loads into your kernel — Tier A or Tier B — and what to do instead when it cannot.

The rule this all serves: **on any device that keeps its vendor's kernel
modules — Tier A GKI or Tier B — the vendor's kernel is the specification and
your kernel is the implementation**, and the authority is the vendor whose modules
the device loads, not the OEM whose logo is on the case (device-sunfish.md).
Everything below is about finding out what that specification actually is, rather
than what a repository suggests it might be. Distilled mostly from bramble (218
modules, 0 failing) and sunfish, where the same problem took eight builds; each
wrong turn is written down as a "don't".

Order of business: Step −1 (can you build the modules instead?), then Steps 0–6
for matching, then poison options, force-loading, struct layouts and shipping.

---

## Step −1 — first ask whether you need to match at all

**Everything about CRCs is about making *their* module binaries load into *your*
kernel. Before spending a day on it, ask whether you can build the modules
instead.**

If the kernel source is available — and on a LineageOS-supported device it is,
since that is how the ROM was built — then the modules are in it too. Build them
from the same tree and the same config as your kernel and they match **by
construction**:

```
vermagic=4.14.357-openela-g28f9290ae067     LineageOS's modules
vermagic=4.14.357-openela-g28f9290ae067     ours, from the same revision
```

**Count what your kernel already builds against what the vendor ships**, in one
command, before believing any of it:

```sh
ls vendor-modules/*.ko | sed 's|.*/||' | sort  > theirs
find <kernel build> -name '*.ko' | sed 's|.*/||' | sort > ours
comm -12 theirs ours | wc -l
```

On sunfish that was 40 of 41, and the gap was an option the port had switched off
itself; it now builds all 41 and loads no prebuilt vendor module at all
(device-sunfish.md).

It is not merely easier but often *necessary*: the CRC route has a hard ceiling.
On sunfish the LuneOS delta moves **8158 of 12823 exported symbols** (§ Poison
options), and even a CRC-verbatim build — LineageOS's config exactly, no LuneOS
delta — still fails 5 of the 41 modules, `wlan.ko` among them. "Drop the poison
options and load the vendor's modules" does not buy a working device there. Once
you ship your own, treat the gate's "would fail to load" count for the vendor set
as informational: it describes modules that are never loaded.

Keep matching when the source is genuinely unavailable — a GPL-incomplete vendor
drop, an out-of-tree combo driver (mindphone's MTK WMT stack), or a Tier A GKI
device where preserving the *stock* KMI is the whole point (bluejay, panther).
"The ROM ships modules" is not one of them. Shipping your own is § Building and
shipping your own modules.

## Step 0 — ask the modules, they know

A module states the kernel it was built for. Do this before reading any
defconfig, any manifest, or any wiki:

```sh
strings vendor/lib/modules/apr_dlkm.ko | grep -m1 '^vermagic='
# vermagic=4.14.336-gfe61ffb52659 SMP preempt mod_unload modversions aarch64
```

That string answers four questions at once:

| Field | Means |
|---|---|
| `4.14.336` | `VERSION.PATCHLEVEL.SUBLEVEL` of the tree, plus `EXTRAVERSION` (`-openela`) |
| `-g<sha>` | **the git HEAD the kernel was built from** — an exact, searchable commit |
| absence of `+` or `-dirty` | the tree was clean: no local patches on top |
| `modversions` | `CONFIG_MODVERSIONS` is on, so CRCs are checked and matter |

Then confirm they are one coherent set, not a mixture:

```sh
for m in */*.ko; do strings "$m" | grep -m1 '^vermagic='; done | sort | uniq -c
#   42 vermagic=4.14.336-gfe61ffb52659 ...        <- one build, good
```

**DO** search the `-g<sha>` on the vendor's kernel repo. On sunfish
`fe61ffb52659` was the head of `lineage-20`, which identified the ROM
generation (/e/OS 13, a LineageOS 20 derivative) more reliably than the owner's
recollection did — and matched the `api=33` the device reported.

**DON'T** infer the kernel from the Android version. "Android 13, so
lineage-20-ish" is necessary, not sufficient: the vendor must match the *kernel*
version. athena's port turned on exactly this (its `KGSL_PROP_IB_TIMEOUT` failure
came from a 4.4-era vendor against a 4.19 kernel, both nominally "Android 15";
device-athena.md).

**DO** make the vermagic match exactly when the initramfs has to load vendor
modules. Storage and USB controllers are often vendor modules in the
`vendor_boot` ramdisk, the initramfs carries only **busybox** insmod/modprobe
(no `--force-vermagic`), and the stock config rarely sets
`CONFIG_MODULE_FORCE_LOAD` — so a vermagic that is off by one character means no
userdata, no adb and no console, while every CRC check passes. Set
`CONFIG_LOCALVERSION` to the vendor's suffix with `LOCALVERSION_AUTO` off, and
write an empty `.scmversion` before configure, or `scripts/setlocalversion`
appends a `+` (found on the Q25; see device-q25.md):

```
sed -i 's/^SUBLEVEL = .*/SUBLEVEL = 233/' Makefile
CONFIG_LOCALVERSION="-android12-9-gdeb4d30d3489"
# CONFIG_LOCALVERSION_AUTO is not set
: > .scmversion          # patching the Makefile dirties the tree -> "+"
```

Deploy `include/config/kernel.release` so the string is checkable before flashing.
Faking the sublevel is defensible **only** because the ABI is separately verified
(0 of N stock modules failing the CRC check).

---

## Step 1 — get the vendor's real config, not its defconfig

**DO** extract the config out of the shipped kernel. Android kernels are built
with `CONFIG_IKCONFIG`, so the answer is inside the boot image:

```sh
# boot.img -> kernel -> the gzipped .config between IKCFG_ST and IKCFG_ED
python3 - <<'PY'
import struct, gzip
b = open('boot.img','rb').read()
k = struct.unpack_from('<I', b, 8)[0]           # header v2/v3: kernel_size at +8
open('kernel.lz4','wb').write(b[4096:4096+k])
PY
lz4 -d kernel.lz4 kernel.img
python3 - <<'PY'
import gzip
b = open('kernel.img','rb').read()
st = b.index(b'IKCFG_ST') + 8
open('vendor.config','w').write(gzip.decompress(b[st:b.index(b'IKCFG_ED', st)]).decode())
PY
```

**DON'T** trust `arch/arm64/configs/<device>_defconfig`. It is what the ROM
maintainer feeds kbuild, not what came out, and on both devices measured it
differed from the shipped kernel in ways that moved CRCs:

| Device | Public defconfig | What actually shipped |
|---|---|---|
| bramble | `DEBUG_FS=y`, `CORESIGHT=y` | both **off** (Google's user build) |
| sunfish (LOS 23.2) | — | `DEBUG_FS=n` *with* `TRACING=y` |

On bramble those two symbols alone cost **170 of 218 modules**, from a build
whose config was otherwise the published defconfig and which carried no LuneOS
options at all.

**DO** then use that extracted config as the build's base and put your delta on
top, so the only differences are the ones you chose:

```bitbake
cat ${UNPACKDIR}/vendor-config ${UNPACKDIR}/luneos.cfg > ${WORKDIR}/defconfig
```

**DO** also get the vendor's modules themselves, so the gate has something to
check against. A LineageOS-style OTA has them in `vendor.img` inside
`payload.bin`:

```sh
unzip -o rom.zip payload.bin
python3 payload_extract.py payload.bin . vendor          # -> vendor.img
for f in $(debugfs -R "ls /lib/modules" vendor.img | tr -s ' \n' '\n' | grep '\.ko$'); do
    debugfs -R "dump /lib/modules/$f mods/$f" vendor.img
done
```

And a LineageOS build publishes its own `build-manifest.xml` next to the zip,
which names the kernel revision outright — worth fetching first, it is 285 KB
against the ROM's 1.2 GB.

---

## Step 2 — read the failure correctly

Two module-load failures look similar in a log and mean completely different
things. Getting this wrong wastes a flash cycle.

| Message | Means | Force-loadable? |
|---|---|---|
| `X: disagrees about version of symbol Y` | CRC mismatch: the symbol exists, its type changed | **yes** — `MODULE_INIT_IGNORE_MODVERSIONS` |
| `X: Unknown symbol Y (err 0)` | the kernel does not export Y **at all** | **no, ever** |

`kernel/module.c` returns `-ENOENT` for an unresolved symbol unconditionally;
the force flags only skip the vermagic and CRC comparisons. So:

**DON'T** answer `Unknown symbol` with `CONFIG_MODULE_FORCE_LOAD` or
`modprobe --force`. It cannot work. On sunfish a revision shipped that did
exactly this and the modules failed identically — the symbol was
`__cfi_slowpath`, i.e. *the kernel had been built without CFI while the modules
had not*. An `Unknown symbol` naming a feature's helper is telling you a whole
config option is missing, not that a check is in the way.

**DO** count the right message on the device. `dmesg | grep -c "Unknown symbol"`
returned **400** on a healthy MP01 boot — dependency-ordering noise from the
module-load retry loop (`tcpc_class: Unknown symbol pd_dbg_info`), resolved on a
later pass. The CRC message is **"disagrees about version"**. Count that one.

**DON'T** trust the absence of a "version magic" complaint as proof the versions
match. Under `CONFIG_MODVERSIONS` the comparison deliberately skips the release
string:

```c
static inline int same_magic(const char *amagic, const char *bmagic, bool has_crcs)
{
	if (has_crcs) {                       /* skip the version, compare flags only */
		amagic += strcspn(amagic, " ");
		bmagic += strcspn(bmagic, " ");
	}
	return strcmp(amagic, bmagic) == 0;
}
```

### A failure class invisible to CRC checks: `MODULE_SIG_PROTECT`

`kmi-crc-check.py` can pass and the stock vendor modules still never load. A GKI
kernel with `CONFIG_MODULE_SIG_PROTECT=y` refuses (`-EACCES`) to let a module it
did not sign resolve *protected* symbols. A self-rebuilt GKI is not signed with
Google's key, so the phone's **own stock vendor modules count as unsigned**, and
a CRC-only check cannot see it because the CRCs are fine (Wi-Fi/BT never loaded
in an early bluejay kit; see device-bluejay.md).

Fix: `# CONFIG_MODULE_SIG_PROTECT is not set`, while `MODULE_SIG`/`MODULE_SIG_ALL`
stay `=y`; `internal.h` stubs both helpers when the option is off, so no source
patch is needed. Measured KMI-clean on bluejay: 203/203 factory modules load, 0
CRC mismatches, and the option confirmed off by reading the built kernel's
IKCONFIG back.

---

## Step 3 — measure the CRCs yourself, host-side

`kmi-crc-check.py` (tools.md) is the gate, and it should be run before every
flash. But **DO** also be able to read the raw numbers, because a display filter
in a tool once hid `module_layout` from a summary and sent this port chasing the
wrong thing for two builds:

```python
# __versions is an array of { u64 crc; char name[56]; }
import struct, subprocess
out = subprocess.run(["llvm-objcopy","-O","binary","--only-section=__versions",
                      "mod.ko","/dev/stdout"], capture_output=True).stdout
want = {}
for off in range(0, len(out), 64):
    rec = out[off:off+64]
    if len(rec) < 64: break
    want[rec[8:].split(b"\0")[0].decode()] = struct.unpack_from("<Q", rec, 0)[0]
# compare against column 1 of the build's Module.symvers
```

### The pattern of mismatches is the diagnosis

**DO** look at *which* symbols differ before changing anything:

| Observation | Means |
|---|---|
| **everything** differs, `printk` and `kfree` included | wrong source revision — go back to Step 0 |
| `module_layout` differs | `struct module` changed: tracing, CFI, sig, livepatch-class options |
| simple symbols match, only struct-carrying ones differ (`dev_err`, `devm_kmalloc`, `bus_register`) | a shared struct changed — config, and a small one |
| a handful of subsystem symbols differ | that subsystem's options |

On sunfish `printk`, `kfree`, `mutex_lock` and `__const_udelay` matched while
`dev_err` and `module_layout` did not — 31 of 50. That is a config difference in
`struct device` and `struct module`, and it ruled out the source and the
compiler in one look.

---

## Step 4 — the compiler: what it does and does not affect

**DON'T** chase the vendor's exact clang release to fix CRCs. genksyms computes
CRCs from *preprocessed source plus config*; it is not a codegen property.
Measured twice on sunfish:

| Our clang | Vendor clang | Simple symbols |
|---|---|---|
| 12.0.5 (r416183b) | 14.0.6 (r450784d) | 34 of 55 matched |
| 12.0.5 (r416183b) | 21.0.0 (r563880c) | 31 of 50 matched |

If the compiler decided CRCs, *nothing* would match. It does not.

**DO**, however, build with the vendor's toolchain **family** when the tree is a
Qualcomm/Android one, for a different and much sharper reason: **the SCM
(TrustZone) entry is register-pinned inline assembly, and GCC gets it wrong.**
This was the single root cause of sunfish looking dead while booting fine:

```
scm_call failed with error code -1                    (x44, GCC build)
QSEECOM: qseecom_probe: Failed to get QSEE version info -19
QSEECOM: qseecom.qsee_version = 0x0
subsys-pil-tz ...: modem/cdsp/venus: Initializing image failed(rc:-5)
```

With no SCM there is no PIL, so **no peripheral image authenticates at all** —
and because the Adreno zap shader loads through that same path, `kgsl` never
binds, `/dev/kgsl-3d0` never appears, EGL cannot initialise and the compositor
aborts in a loop (3983 restarts observed). One cause, an entire device's worth
of symptoms. Rebuilt with the clang the tree names in its own
`build.config.common`, every one of those went to zero.

**DO** expect clang-only options to switch themselves **on** when you move a
recipe from GCC to clang. `LTO_CLANG`, `CFI_CLANG` and `SHADOW_CALL_STACK`
depend on clang, so kconfig force-disables them under GCC and nobody notices
they were requested. On sunfish that produced a kernel 5 MB larger that
overlapped its own initramfs — caught only by the boot-window check
(boot-images.md), which is the first time that check earned its keep.

**DON'T** try to build a CFI/SCS kernel with GCC at all: it stops at
`cc1: error: '-fsanitize=shadow-call-stack' requires '-ffixed-x18'`.

---

## Step 5 — kconfig will ignore you, in three specific ways

Each of these cost a full rebuild before being understood.

**A choice member cannot be unset.** `# CONFIG_LTO_CLANG is not set` does
nothing when `LTO_CLANG` is one arm of a `choice`; kconfig re-selects the
previous member. Select the other arm:

```
CONFIG_LTO_NONE=y                 # not "# CONFIG_LTO_CLANG is not set"
```

**A selected symbol cannot be unset.** `DEBUG_FS` stayed `=y` through two
attempts because something else selects it. Find the chain before touching it:

```sh
# every enabled symbol that selects X
grep -rn "select X" $S --include=Kconfig\* | while IFS=: read f ln rest; do
    sym=$(awk -v n=$ln 'NR<=n && /^(menu)?config /{c=$2} NR==n{print c}' "$f")
    grep -qE "^CONFIG_$sym=y" $B/.config && echo "$sym"
done | sort -u
```

On sunfish that walked `DEBUG_FS ← TRACING ← GENERIC_TRACER ← IPC_LOGGING` —
and `IPC_LOGGING` is in the vendor's defconfig too, meaning **the vendor had
DEBUG_FS on as well and the whole hunt was misdirected.** Which leads to the
most important don't in this file:

> **DON'T disable a feature without checking whether the vendor's modules
> import it.** One command settles it:
>
> ```sh
> for m in mods/*.ko; do strings "$m" | grep -qE '^debugfs_(create|remove)' && echo "$m"; done
> ```
>
> 11 of sunfish's 42 modules import `debugfs_*`. A module cannot import what
> the kernel does not export, so DEBUG_FS was *provably* on in the vendor
> kernel, and turning it off would have reproduced the `Unknown symbol` class
> of failure — the unfixable one.

**`CONFIG_LOCALVERSION` in a fragment does not survive.** `kernel.bbclass` owns
it. To add the `-g<sha>` half of a vermagic, use OE's knob, which exports
`LOCALVERSION` for `scripts/setlocalversion` to append:

```bitbake
KERNEL_LOCALVERSION = "-g28f9290ae067"
```

---

## Step 6 — always have a baseline switch

**DO** put this in every per-device kernel recipe, from the first commit:

```bitbake
LUNEOS_KERNEL_FRAGMENT ?= "1"      # "0" = the vendor's config verbatim
```

It is the control experiment, and it is what splits the only two possibilities
apart:

- **verbatim build passes the gate** → tree, toolchain and config reproduce the
  vendor; every remaining mismatch is in your own delta, and can be bisected
  with `symvers-drift.py`.
- **verbatim build still fails** → the cause is outside your config entirely,
  and no amount of fragment editing will help.

bramble had this switch and reached 0/218 in three measured steps. On sunfish a
run *believed* to be a baseline silently carried the whole delta (`bitbake -R`
with a variable the recipe never reads changes nothing). **DON'T** report a
baseline number without checking the recipe actually honours the switch.

---

## Poison options: per KMI, and drift is a max

An option is **KMI-poison** when it changes a struct that exported symbols carry,
moving their genksyms CRCs so the stock modules refuse to load. LuneOS needs a
small delta an Android defconfig omits (kernel-porting.md § The config delta); most
of it is CRC-neutral.

**The poison list is a property of the KMI *and* kernel tree.** Re-derive it per
KMI with `kmi-crc-check.py`; never transplant it between KMIs in either direction.
Measured so far:

| Kernel | Poison | Source |
|---|---|---|
| ACK `android14-6.1` (bluejay, panther) | `FANOTIFY`, `NET_L3_MASTER_DEV` | cumulative bisect: 3145 → 0 drift, 203/203 → 2/203 failing (the 2 were ACK-pin skew; kernel-porting.md § Vendor-hook modules) |
| sunfish 4.14 (LineageOS tree) | `FANOTIFY`, `CGROUP_DEVICE` | per-option measurement below |
| MediaTek mgk `android12-5.10` (Q25) | `USER_NS` kept off (not measured on its own) | device-q25.md |

Within a KMI it transfers: panther confirmed bluejay's fragment unchanged
(204/204 modules, 0 mismatches). Whether `CGROUP_DEVICE` shows up depends on
whether the vendor config already enables it — check rather than assume.

### What the two sunfish poisoners change

Between them they move the CRC of **8158 of 12823 exported symbols** on sunfish
(measured: diff the two `Module.symvers`), because they reach structs that almost
every prototype reaches:

| Option | Changes | Reached by |
|---|---|---|
| `FANOTIFY` | `atomic_t fanotify_listeners` in `struct user_struct` (`include/linux/sched/user.h`) | `struct cred.user`, and `cred` is reachable from `file`, `sock`, `task_struct`, and from `device` via `class` → `kobj_ns_type_operations` → `sock` |
| `CGROUP_DEVICE` | `SUBSYS(devices)` bumps `CGROUP_SUBSYS_COUNT`, which dimensions `subsys[]`, `e_cset_node[]`, `e_csets[]` in `struct css_set` / `struct cgroup` | `task_struct.cgroups` |

**The poison sets overlap, so the drift is a max and not a sum.** This is the
single most important thing to know before trying to fix drift by removing
options: in the table below `FANOTIFY` alone moves exactly as many sampled CRCs
as the whole delta, and `CGROUP_DEVICE` alone most of the same ones. A change
that removes one poisoner while another stays shows up as zero improvement,
which reads exactly like "the option was innocent" and is not. A cumulative
bisect hides the same thing; attribute one option at a time.

Everything else in the fragment is CRC-free. Measured per option on sunfish, over
164 CRCs sampled from `fs/inode.o`, `drivers/base/{core,platform}.o`,
`kernel/sched/core.o`, `kernel/module.o`:

| Config under test | CRCs moved vs LineageOS-verbatim |
|---|---|
| the whole LuneOS delta | 143 / 164 |
| `FANOTIFY` alone | 143 / 164 |
| `CGROUP_DEVICE` alone | 118 / 164 |
| `PID_NS` + `USER_NS` | 0 |
| `VT` + `VT_CONSOLE` + `HW_CONSOLE` + `DUMMY_CONSOLE*` + `CONSOLE_TRANSLATIONS` | 0 |
| `DEVTMPFS` (+`_MOUNT`) | 0 |
| `FHANDLE` / `AUTOFS4_FS` / `MODULE_FORCE_LOAD` / `MSM_RDBG` | 0 each |
| the 9 `BT_*` options | 0 |
| **the whole delta minus `FANOTIFY` and `CGROUP_DEVICE`** | **0** |

Note what is *not* in that list: the namespace options. `struct nsproxy` is
unconditional and `struct user_namespace`'s members are gated only by
`PERSISTENT_KEYRINGS`/`SYSCTL`, so `PID_NS` and `USER_NS` are KMI-free on this
tree — the opposite of what the shape of the problem suggests, and worth checking
rather than assuming for any option you are about to fight. It is per tree: on
the Q25's MediaTek 5.10 tree `USER_NS` stays off (device-q25.md).

### How to attribute drift in minutes instead of hours

Do not rebuild the kernel once per option. CRCs come out of genksyms on
*preprocessed source*, so they are visible in a handful of objects:

```sh
make -C $src O=$objdir ARCH=arm64 CC=clang LD=ld.lld LLVM_IAS=1      CLANG_TRIPLE=aarch64-linux-gnu- olddefconfig prepare
make ... fs/inode.o drivers/base/core.o kernel/sched/core.o kernel/module.o
llvm-nm $objdir/fs/inode.o | awk '$2 ~ /^[Aa]$/ && $3 ~ /^__crc_/'
```

About three minutes per config instead of an hour, and a private `O=` objdir
never touches the builder's tree. One catch: **turn LTO off for the measurement**
(`CONFIG_LTO_NONE=y`, and `CFI_CLANG`/`SHADOW_CALL_STACK` off with it). With LTO
on, each `.o` is LLVM bitcode, Kbuild's `cmd_modversions_c` sees no `__ksymtab`
in `objdump -h` and skips the CRC step, so `__crc_*` stays an unresolved weak
symbol and every config looks identical. Turning LTO off is safe here precisely
because CRCs do not depend on codegen.

### Does anything actually need `FANOTIFY` or `CGROUP_DEVICE`?

Asked on sunfish, because it is the obvious next question once you know they are
the only two poisoners there.

**`FANOTIFY`: nothing appears to need it. Removable, pending one control test.**

- bluejay, panther and tangorpro boot the *same* halium-arm64 rootfs
  with `# CONFIG_FANOTIFY is not set` — meta-android's shared GKI fragment already
  lists it as KMI-poison and leaves it out. Same systemd build, no fallout. This is
  the strongest evidence available and it costs nothing to look up.
- Scanning every regular file in the shipped rootfs for `fanotify` finds only
  syscall *name tables*: `strace`, the valgrind tools, gdb's `syscalls/*.xml`,
  `libseccomp`, `enosys`, perfetto's trace processor, and glibc's own wrapper.
  The one real library reference is `libsystemd-shared-257.so`, which does not need
  the kernel side present. No LuneOS component calls it.

- **Provenance, which is the part worth knowing:** it comes from the Mer/SFOS kernel
  config checker, which lists `CONFIG_FANOTIFY  y,!  # optional, required for
  systemd readahead.` — and whose own header defines `!` as *"Failure will be warned,
  not errored"*. So it was never a requirement even there, and its stated reason,
  `systemd-readahead`, was **removed from systemd in v217 (2014)**. The LuneOS rootfs
  ships systemd 257, with no readahead unit or binary. If a Tier B fragment carries
  an option justified only by a Mer-checker line, check the notation and the date
  before paying a KMI price for it.

It was in sunfish's fragment under a "systemd's mount/automount machinery" comment
— an assumption inherited from that checker, never a measurement, and the most
expensive one in the file.

**Open:** the GKI devices prove systemd *starts* without fanotify, not that a
full LuneOS stack is unaffected; the control test on sargo
(`LUNEOS_TEST_NO_FANOTIFY=1` in `linux-google-sargo`, or counting live fanotify
fds on a booted device) has no recorded result, and sunfish keeps
`CONFIG_FANOTIFY=y` until it does.

**`CGROUP_DEVICE`: kept, because it does something.** 7 units in the shipped rootfs
carry `DeviceAllow=`/`DevicePolicy=` (`systemd-logind`, both `systemd-journald`
units, `systemd-hostnamed`, `bluebinder`, both `openvpn@` templates). Without the
controller systemd logs a warning and skips the restriction rather than failing the
unit, so it is confinement, not a boot dependency — and the Android container does
not need it either (`/var/lib/lxc/android/config` has zero `lxc.cgroup` directives).
It is worth knowing it *can* go if a port ever needs the CRCs; the GKI devices run
without it.

### The genksyms trick: last resort for one member

If an option genuinely cannot go, the `#ifndef __GENKSYMS__` trick (declare the
member at the end of the struct, hidden from genksyms) applies to `FANOTIFY` — it is one member
(`atomic_t fanotify_listeners`) and moving it to the end of `struct user_struct`
keeps every pre-existing offset. It does **not** apply to `CGROUP_DEVICE`: that
changes an array *dimension* in the middle of `css_set`/`cgroup`, so hiding it from
genksyms would publish a CRC for an offset layout the kernel does not have — a
silent wrong answer instead of a loud refusal. It works for **one** struct at a time; it does not scale to `user_struct` plus a
config-sized array dimension in `css_set`, and a patch series hiding several
would be a permanent maintenance burden on the most churn-prone headers in the
tree.

---

## Force-loading prebuilt modules, and when it is safe

Force-loading is for modules you cannot build (Step −1). It works — wifi, BT and
GPS came up this way on mindphone — and the recipe is:

- set `CONFIG_MODULE_FORCE_LOAD=y` in luneos.cfg — this only makes forcing
  *possible*; something still has to ask for it,
- **derive the list and the order from the vendor's own init**, never hand-write
  one (see hal-userspace.md, "let the vendor's init load them"): `insmod` lines in
  `/vendor/etc/init/*.rc` for the connac era, `/vendor/etc/init.insmod.<hw>.cfg`
  for Qualcomm and the MTK GKI devices, `modules.load` as the fallback,
- escalate per module — plain `modprobe`, then `--force-vermagic`, then `--force`.
  Starting at `--force` hides a real KMI break on a port where only the vermagic
  string differs; if vermagic is the only difference, match it instead (Step 0),
  and a struct change then fails loudly at insmod instead of corrupting memory,
- point `firmware_class.path` at `/android/vendor/firmware` first. The kernel
  resolves `request_firmware()` against the *host* filesystem, not the
  container's.

**It is only safe while every struct those modules touch has the stock layout.**
`--force` skips the CRC check that would have caught a layout change, so a
mismatch shows up as memory corruption, not as a load error. Tier B has an ABI to
keep after all: not a KMI in the GKI sense, but the stock kernel's layout as seen
by every prebuilt `.ko` on the vendor partition. Check it (§ Struct layouts)
before the first forced load. `Unknown symbol` is never force-loadable (Step 2).

**Do not stage a vendor set in `/lib/modules/$(uname -r)`.** udev's coldplug
autoloads by modalias out of that directory, so a depmod'd copy of a whole vendor
set there makes the *next* boot insmod every matching vendor module before
anything is ready. On the MP01 that pulled in `mtk_lpm` within a second of udevd
starting, froze the SoC, and left the hardware watchdog bootlooping the device on
every boot after the first. Symlink the vendor `.ko` into a private tree under
`/run` instead, out of udev's sight and off persistent storage, and point
`depmod -b` and `modprobe -d` at it (`mtk-load-modules.sh` does this). Modules
built with your own kernel are different: they belong in `/usr/lib/modules/<kver>`,
where coldplug autoloading is what you want.

Easy to get wrong once the loading itself works:

- **The vendor's cfg does more than load modules.** Qualcomm's
  `init.insmod.<hw>.cfg` interleaves `enable|<sysfs path>` lines that start the
  DSPs, and the node one of them writes is created by a module earlier on the same
  list. Walk the file, do not grep the module names out of it (on sunfish a
  missing `adsp_loader_dlkm.ko` meant no ADSP, fastrpc "Transport endpoint is not
  connected", and no sensors).
- **A module that is shipped but not listed gets no chance to be forced.** Android
  loads some itself with `finit_module`, a path with no force option
  (`incrementalfs.ko` on sunfish: `Exec format error`, and vold could not prepare
  user 0). Name those separately.
- **Reason from the vendor partition, not from the defconfig**: what matters is
  which `.ko` files the phone carries, not which symbols are `=m` in the tree's
  defconfig (guessing from the latter predicted working audio on a sunfish with no
  ALSA card). `debugfs -R "ls -l /lib/modules" vendor.img` answers it without root
  or a loop mount.

---

## Struct layouts: the ABI a forced load depends on

A panic in the first vendor network driver to register a netdev (Titan Pocket:
`Unable to handle kernel paging request`, `lr : __dev_xdp_attached`, under
`register_netdev <- [wlan_drv_gen3]`) is the signature of a layout change the
force skipped (device-titanpocket.md). Check before flashing.

### The config diff

1. Get the stock config from the stock kernel itself (Step 1). MediaTek stock
   kernels carry IKCONFIG: unpack `boot.img`, gunzip the kernel, then
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

### Better: compare the real layouts, using the stock kernel's own headers

The config diff is a heuristic. If the vendor partition carries **`kheaders.ko`**
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
attribution (§ Poison options) works when you build the vendor's own
source; against a reconstruction, compare layouts instead.

Found by the config diff and the layout probe on the Titan Pocket, and what was done:

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
cgroup structs are cgroup-core internals. Options that change *built-in* code
only (e.g. the BT stack) are invisible to vendor modules unless they call into it.

Struct bodies are not the whole ABI: inline helpers and macros also bake offsets
into the module. The struct list is a practical filter, not a proof.

### NETCONSOLE and `NET_POLL_CONTROLLER`

`CONFIG_NETCONSOLE` selects NETPOLL, which turns on `NET_POLL_CONTROLLER`, which
adds `npinfo` to `struct net_device` and inserts
`ndo_poll_controller`/`ndo_netpoll_setup`/`ndo_netpoll_cleanup` into the middle
of `struct net_device_ops`. A prebuilt wifi driver's ops table laid out for stock
then has the kernel read `ndo_bpf` from the wrong slot and jump to whatever is
there. On Tier A it is KMI-poison; on Tier B it is a panic whenever a stock
network module is force-loaded, unless the stock config already had
`NET_POLL_CONTROLLER`. Safe only where the network drivers are built with the
kernel (athena builds its own `wlan.ko`). Usage of netconsole as a debug channel:
debugging.md.

---

## Building and shipping your own modules

**Which route when.** The generic `halium-arm64` rootfs is built once for every
machine, so no machine's module package lands in it, and the tissot/mido pattern
(`MACHINE_EXTRA_RDEPENDS = " … kernel-module-wlan … "`) cannot be copied: those
machines build their own complete image (sargo carries an unresolved
`# kernel-module-wlan` comment in its machine conf for this reason). Two routes
work, both for modules built with your own kernel:

- **The initramfs route** (sunfish, bramble): ship the modules in the machine
  initramfs, next to the kernel they were built against — the only arrangement
  in which the two cannot drift apart — and put them where the vendor's loader
  looks. Use it when the vendor's own init or the initramfs loads the modules.
- **The rootfs.img injection route** (athena): write the module tree into the
  built `rootfs.img` with debugfs and let `systemd-modules-load` load it. Use it
  when nothing vendor-side loads the module (athena: `CONFIG_QCA_CLD_WLAN=m` is the
  only module, and the vendor's `wlan.ko` will not load).

A prebuilt vendor set is neither: it stays on the vendor partition (§ Force-loading).

### The initramfs route

Ship them in the initramfs, unsplit:

```bitbake
KERNEL_SPLIT_MODULES = "0"
ANDROID_EXTRA_INITRAMFS_IMAGE_INSTALL = "kernel-modules"
```

Where they have to *land* differs, and getting it wrong fails silently — the build
is green and the device behaves exactly as if nothing changed.

**Shape A - modules live on /vendor (sunfish, most Tier B Qualcomm).** The
vendor's `init.insmod.sh` modprobes from `/vendor/lib/modules` inside the
container. Stage the modules into the rootfs from the initramfs (it is freed at
`switch_root`): `init.sh`'s `mount_kernel_modules()` hook, called after
`mountroot` and before `switch_root`, idempotent with a marker file. Then bind
them over the vendor's directory in `mount-android.sh`, so the container's own
`init.insmod.sh` does the loading:

```sh
cp -a "$ANDROID_ROOT/vendor/lib/modules/." "$stage/"   # vendor's index files
cp -f <our .ko>                            "$stage/"   # our binaries on top
mount --bind "$stage" "$ANDROID_ROOT/vendor/lib/modules"
```

**Shape B - modules live in the vendor_boot ramdisk (bramble, Tensor GKI).** The
bootloader merges vendor_boot's ramdisk and then ours, and `init.sh`'s
`load_kernel_modules()` modprobes whatever is at `/lib/modules`.

1. **cpio layering will not do the substitution for you.** A later archive
   replaces an earlier entry only at the *same path*. The vendor keeps a real
   `/lib/modules` directory; our rootfs is usrmerge so our modules are packaged
   at `/usr/lib/modules`; and our `/lib -> usr/lib` symlink cannot be created
   over the directory the vendor already made. Result: two separate directories
   and no override, so the vendor's binaries get loaded against your kernel.
2. So copy explicitly, before anything is modprobed - `init.sh`'s
   `stage_our_kernel_modules()` does this, logs the count, and no-ops when both
   paths already resolve to the same place (Shape A).

**DO keep the vendor's `modules.load`, `modules.dep`, `modules.softdep` and
`modules.alias` in both shapes.** They address modules by name, so they stay
correct for your binaries, and `modules.load` preserves a load order the vendor
tuned. Anything you do not build keeps the vendor's copy and fails as it would
have anyway.

**DO match the layout and the names exactly.** LineageOS keeps bramble's 221
modules flat at `/lib/modules/*.ko` while `modules_install` writes
`/lib/modules/<version>/kernel/...`; flatten in `do_install` or the override never
happens. A module whose name comes out different is skipped just as silently:
MediaTek's Mali tree names `mali_mgm_$(MTK_PLATFORM_VERSION).ko` from a variable
it does not export, so kbuild produced `mali_mgm_.ko` until the recipe passed
`MTK_PLATFORM_VERSION=<soc>` (device-q25.md).

### Packaging traps

**`KERNEL_SPLIT_MODULES = "0"` is not optional on an LTO build.** With OE's
default per-module packaging, each module's `depends=` field becomes package
RDEPENDS — and under `CONFIG_LTO_CLANG` that field names the LTO intermediates:

```
q6_dlkm.ko:  depends=apr_dlkm.lto,snd_event_dlkm.lto
```

No package provides `kernel-module-apr-dlkm.lto`, so `do_rootfs` fails with
"none of the providers can be installed". This is **not** a defect in your
build: LineageOS's own shipped `mpq-dmx-hw-plugin.ko` carries the identical
`depends=mpq-adapter.lto`, and it is harmless on-device because `modprobe`
resolves against `modules.dep`, not that field. Unsplit, there are no
inter-module RDEPENDS to be unsatisfiable.

**Depend on the kernel's package, never on its deploy.** `MODULE_TARBALL_DEPLOY`
cannot be used: the tarball is created inside `kernel_do_deploy`, and where the
kernel's own `do_deploy` assembles the boot image (`kernel_android`) it is the task
that *consumes* the initramfs — a dependency loop, `1705 unbuildable tasks`.
Depending on a kernel's `do_deploy` is only safe when a *different* recipe
assembles the boot image. On a GKI machine `virtual/kernel` is `linux-dummy`, so
`ANDROID_INITRAMFS_KERNEL_MODULES` must name the recipe that really deploys the
tarball: use `GKI_KERNEL_PROVIDER`.

### A standalone kernel recipe: the packaging shape that works

A recipe that builds with the vendor's own Clang cannot `inherit kernel`, so it
gets none of `kernel.bbclass`'s packaging arrangements. Five failures came out of
adding a working `do_install` to one (bramble) - all of them downstream of
`do_install` having been `noexec` for the recipe's whole life, and none of them
in the kernel itself:

```bitbake
# 1. usrmerge: modules must be under /usr, and kbuild always writes lib/modules
install -d ${D}${nonarch_base_libdir}
${KERNEL_MAKE} INSTALL_MOD_PATH=${WORKDIR}/modinst INSTALL_MOD_STRIP=1 modules_install
mv ${WORKDIR}/modinst/lib/modules ${D}${nonarch_base_libdir}/modules

# 2. ownership: pseudo records only what it is asked to. Files kbuild copies in
#    keep the builder's uid, and do_package then refuses them with
#    "getpwuid(): uid not found: 1000". An explicit chown IS intercepted.
do_install[fakeroot] = "1"
chown -R root:root ${D}${nonarch_base_libdir}/modules

# 3. ...but do NOT make do_deploy fakeroot: bitbake creates sstate-build-deploy
#    outside pseudo, and the sstate hashing then trips over its ownership.
#    Set ownership in the archive instead.
tar --owner=0 --group=0 --numeric-owner -czf ${DEPLOYDIR}/modules-${MACHINE}.tgz ...

# 4. no debug splitting: there is no ${HOST_PREFIX}objcopy under
#    INHIBIT_DEFAULT_DEPS, and INSTALL_MOD_STRIP already stripped them
INHIBIT_PACKAGE_STRIP = "1"
INHIBIT_PACKAGE_DEBUG_SPLIT = "1"
FILES:${PN} += "${nonarch_base_libdir}/modules"

# 5. packaging must still RUN. PACKAGES = "" breaks buildhistory's postfunc, and
#    do_package*[noexec] breaks image builds: oe.package_manager walks
#    do_rootfs's dependencies for do_package_write_ipk edges and demands an
#    sstate manifest for each.
```

### The rootfs.img injection route: debugfs, no root, no loop mount

The trick `android-system-image-tissot.bb` and `-mido-halium.bb` use to patch
images at build time works for a whole module tree:

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

Do not feed `modules-<machine>.tgz` from `tmp/deploy` into the injector. `kernel.bbclass`
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

---

## Checklist before flashing a rebuilt kernel that keeps vendor modules

0. **asked whether the modules can be built instead** (Step −1) — if the ROM's
   kernel source exists, they almost certainly can, and steps 3 and 5 then stop
   applying
1. `vermagic` of the vendor's modules identified, and the `-g<sha>` commit pinned;
   matched exactly if the initramfs must load vendor modules
2. vendor's real config extracted from `IKCONFIG` and used as the build base
3. vendor's modules extracted, `kmi-crc-check.py` run → **0 would fail to load**
   *(only when loading their binaries; skip if shipping your own)*
4. baseline (`LUNEOS_KERNEL_FRAGMENT = "0"`) also gated at least once
5. no feature disabled that the modules import (`strings`-check it)
   *(likewise)*
6. if anything is force-loaded: struct layouts checked against stock
   (§ Struct layouts), and no NETCONSOLE unless stock had `NET_POLL_CONTROLLER`
7. on a rebuilt GKI: `CONFIG_MODULE_SIG_PROTECT` off
8. boot-window check passes (kernel end < ramdisk load address) — and remember
   the initramfs grew if it now carries modules
9. built with the toolchain family the tree's own `build.config.common` names
10. if shipping your own modules: they are in the boot image (or the injected
    rootfs), `lsmod` on the device shows roughly the count the vendor's
    `modules.load` names, and `dmesg` shows neither "disagrees about version"
    nor "Unknown symbol"
