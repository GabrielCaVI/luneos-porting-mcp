# Matching a vendor's kernel: vermagic, CRCs and the mistakes that cost builds

How to build a kernel that the device's own vendor modules still load into, Tier A or Tier B, and how to diagnose it when they do not.

Distilled from bramble (218 modules, 0 failing) and from sunfish, where the same
problem took eight builds and several wrong turns — every one of which is written down here as a "don't", because the
reasoning that produced them was plausible each time.

The rule this all serves: **on any device that keeps its vendor's kernel
modules — Tier A GKI or Tier B — the vendor's kernel is the specification and
your kernel is the implementation.** Everything below is about finding out what
that specification actually is, rather than what a repository suggests it might be.

But read Step −1 first. The cheapest way to satisfy a specification is often to
build the thing yourself rather than to reverse-engineer a binary's expectations
of it — and on a device whose ROM is open, you can.

---

## Step −1 — first ask whether you need to match at all

**Everything below is about making *their* module binaries load into *your*
kernel. Before spending a day on it, ask whether you can build the modules
instead.** On sunfish that question was asked eight builds too late.

If the kernel source is available — and on a LineageOS-supported device it is,
since that is how the ROM was built — then the modules are in it too. Build them
from the same tree and the same config as your kernel and they match **by
construction**:

```
vermagic=4.14.357-openela-g28f9290ae067     LineageOS's modules
vermagic=4.14.357-openela-g28f9290ae067     ours, from the same revision
```

Check it in one command before believing any of it:

```sh
# what the vendor ships, against what your kernel build produced
ls vendor-modules/*.ko | sed 's|.*/||' | sort  > /tmp/theirs
find <kernel build> -name '*.ko' | sed 's|.*/||' | sort > /tmp/ours
comm -12 /tmp/theirs /tmp/ours | wc -l        # sunfish: 40 of their 41
```

The one module missing there was `rdbg.ko`, a Qualcomm debug transport this port
had deliberately disabled — i.e. nothing was missing at all. It is now built too
(`CONFIG_MSM_RDBG=m`, Sep 2026), so the overlay covers all 41 and no prebuilt
vendor module is loaded on this device at all. Check this before spending a day on
CRCs: **count what your kernel already builds against what the vendor ships.** The
answer on sunfish was 40 of 41, and the gap was one option we had switched off
ourselves.

### Why this is not merely easier but *necessary*

The CRC route has a hard ceiling, and it is not a matter of finding the right
option. The LuneOS delta moves the CRC of **8158 of 12823 exported symbols** on
this kernel (measured: diff the two `Module.symvers`), because two of the options
in the LuneOS delta reach a struct that almost every prototype reaches:

| Option | Changes | Reached by |
|---|---|---|
| `FANOTIFY` | `atomic_t fanotify_listeners` in `struct user_struct` (`include/linux/sched/user.h`) | `struct cred.user`, and `cred` is reachable from `file`, `sock`, `task_struct`, and from `device` via `class` → `kobj_ns_type_operations` → `sock` |
| `CGROUP_DEVICE` | `SUBSYS(devices)` bumps `CGROUP_SUBSYS_COUNT`, which dimensions `subsys[]`, `e_cset_node[]`, `e_csets[]` in `struct css_set` / `struct cgroup` | `task_struct.cgroups` |

**The poison sets overlap, so the drift is a max and not a sum.** This is the
single most important thing to know before trying to fix drift by removing
options: in the table below `FANOTIFY` alone moves exactly as many sampled CRCs
as the whole delta, and `CGROUP_DEVICE` alone most of the same ones. A change
that removes one poisoner while another stays shows up as zero improvement,
which reads exactly like "the option was innocent" and is not.

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

The `#ifndef __GENKSYMS__` trick (hide a member appended at the end of a struct
from genksyms; see the workaround of last resort below) works for **one**
struct. It does not scale to `user_struct` plus a config-sized array dimension in
`css_set`, and a patch series hiding all of them would be a permanent
maintenance burden on the most churn-prone headers in the tree.

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

### How to ship your own modules

Three pieces, all small (sunfish's are the reference implementation):

1. **Put them in the machine initramfs, not the rootfs.** The rootfs is the
   generic `halium-arm64` one, built once for every machine, so no machine's
   module package lands in it (patching the built `rootfs.img` is the other
   route: kernel-porting.md § Shipping kernel modules to a device that flashes
   the generic rootfs); and shipping
   modules in the same image as the kernel they were built against is the only
   arrangement in which the two cannot drift apart.

   ```bitbake
   KERNEL_SPLIT_MODULES = "0"
   ANDROID_EXTRA_INITRAMFS_IMAGE_INSTALL = "kernel-modules"
   ```

2. **Stage them into the rootfs from the initramfs**, since the initramfs is
   freed at `switch_root`. `init.sh` already has a `mount_kernel_modules()` hook
   for this — it was a never-called stub. Call it after `mountroot` and before
   `switch_root`, and make it idempotent with a marker file.

3. **Bind them over the vendor's directory** in `mount-android.sh`, so the
   container's own `init.insmod.sh` does the loading:

   ```sh
   cp -a "$ANDROID_ROOT/vendor/lib/modules/." "$stage/"   # vendor's index files
   cp -f <our .ko files> "$stage/"                        # our binaries on top
   mount --bind "$stage" "$ANDROID_ROOT/vendor/lib/modules"
   ```

   **DO keep the vendor's `modules.load`, `modules.dep`, `modules.softdep` and
   `modules.alias`.** They reference modules by *name*, so they stay correct for
   your binaries, and `modules.load` preserves a load order the vendor spent
   real effort on. Any module you do not build keeps the vendor's copy and fails
   to load exactly as it would have anyway.

### Two packaging traps on the way

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

**`MODULE_TARBALL_DEPLOY` cannot be used for this.** The tarball is created
inside `kernel_do_deploy`, and on these machines `do_deploy` is the task that
*consumes* the initramfs to assemble the boot image. Depending on it produced
`1705 unbuildable tasks` and a dependency loop. **Depend on the kernel's
package, never on its deploy.**

### Shipping your own modules: the two device shapes

Where the modules have to *land* differs, and getting it wrong fails silently -
the build is green and the device behaves exactly as if nothing changed.

**Shape A - modules live on /vendor (sunfish, most Tier B Qualcomm).** The
vendor's `init.insmod.sh` modprobes from `/vendor/lib/modules` inside the
container. Bind our own directory over it from `mount-android.sh`:

```sh
cp -a "$ANDROID_ROOT/vendor/lib/modules/." "$stage/"   # vendor's index files
cp -f <our .ko>                            "$stage/"   # our binaries on top
mount --bind "$stage" "$ANDROID_ROOT/vendor/lib/modules"
```

The modules must reach the rootfs first: ship them in the machine **initramfs**
(`KERNEL_SPLIT_MODULES = "0"` + `ANDROID_EXTRA_INITRAMFS_IMAGE_INSTALL =
"kernel-modules"`) and stage them across in `init.sh`'s `mount_kernel_modules()`
hook, because no machine's module package lands in the generic halium-arm64
rootfs and the initramfs is freed at `switch_root`.

**Shape B - modules live in the vendor_boot ramdisk (bramble, Tensor GKI).** The
bootloader merges vendor_boot's ramdisk and then ours, and `init.sh`'s
`load_kernel_modules()` modprobes whatever is at `/lib/modules`. Two traps here:

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

**DO match the layout exactly.** LineageOS keeps bramble's 221 modules flat at
`/lib/modules/*.ko` while `modules_install` writes
`/lib/modules/<version>/kernel/...`; flatten in `do_install` or the override
never happens.

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

And on the image side, `ANDROID_INITRAMFS_KERNEL_MODULES` must depend on the
recipe that really deploys the tarball: on a GKI machine `virtual/kernel` is
`linux-dummy`, so use `GKI_KERNEL_PROVIDER`. Depending on the kernel's
`do_deploy` is only safe when a *different* recipe assembles the boot image -
where the kernel's own `do_deploy` builds it (`kernel_android`), that is a
dependency loop (1705 unbuildable tasks).

### When you still have to match

Keep reading below when the source is genuinely unavailable — a GPL-incomplete
vendor drop, an out-of-tree combo driver (mindphone's MTK WMT stack), or a Tier A
GKI device where preserving the *stock* KMI is the whole point of the port
(bluejay, panther). Those are real cases. "The ROM ships modules" is not one of
them.

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
lineage-20-ish" is necessary, not sufficient; athena's port turned on exactly
this (its `KGSL_PROP_IB_TIMEOUT` failure came from a 4.4-era vendor against a
4.19 kernel, both nominally "Android 15").

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

bramble had this switch and reached 0/218 in three measured steps. sunfish did
not, and one run that was *believed* to be a baseline silently carried the whole
delta anyway (`bitbake -R` with a variable the recipe never reads changes
nothing) — so its 42/42 result was reported as evidence when it was noise.
**DON'T** report a baseline number without checking the recipe actually honours
the switch.

---

## The LuneOS delta: what still poisons

LuneOS needs a small set of options an Android defconfig omits (see
kernel-porting.md). Most are CRC-neutral. `CONFIG_SYSVIPC` is not in it: LuneOS
does not need SysV IPC, so leave `# CONFIG_SYSVIPC is not set`.

What is left poisoning sunfish is `FANOTIFY` and `CGROUP_DEVICE` (143 and 118 of
the same 164 sampled CRCs). Dropping both takes the sampled drift to 0, but on
sunfish that buys nothing, because it builds its own modules (Step −1) and the
vendor's prebuilts fail anyway (below).

### Does anything actually need `FANOTIFY` or `CGROUP_DEVICE`?

Asked and answered on sunfish, because it is the obvious next question once you
know they are the only two poisoners.

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

**Neither removal would let you use the vendor's prebuilts anyway.** The
CRC-verbatim sunfish build — LineageOS's config exactly, no LuneOS delta — still
fails 5 of the 41 modules:

```
FAIL incrementalfs.ko: 29/175   FAIL q6_dlkm.ko: 3/132   FAIL rdbg.ko: 3/36
FAIL wglink_dlkm.ko: 3/53       FAIL wlan.ko: 7/395
```

`wlan.ko` is in that list, so "drop the poison options and load the vendor's
modules" does not buy a working device. Build your own and overlay them; sunfish's
kernel builds all 41. Treat the gate's "41 would fail to load" there as
informational — it describes modules that are never loaded.

**Workaround of last resort, if an option genuinely cannot go:** the
`#ifndef __GENKSYMS__` trick applies to `FANOTIFY` — it is one member
(`atomic_t fanotify_listeners`) and moving it to the end of `struct user_struct`
keeps every pre-existing offset. It does **not** apply to `CGROUP_DEVICE`: that
changes an array *dimension* in the middle of `css_set`/`cgroup`, so hiding it from
genksyms would publish a CRC for an offset layout the kernel does not have — a
silent wrong answer instead of a loud refusal.

## Checklist before flashing a rebuilt Tier B kernel

0. **asked whether the modules can be built instead** (Step −1) — if the ROM's
   kernel source exists, they almost certainly can, and steps 3 and 5 then stop
   applying
1. `vermagic` of the vendor's modules identified, and the `-g<sha>` commit pinned
2. vendor's real config extracted from `IKCONFIG` and used as the build base
3. vendor's modules extracted, `kmi-crc-check.py` run → **0 would fail to load**
   *(only when loading their binaries; skip if shipping your own)*
4. baseline (`LUNEOS_KERNEL_FRAGMENT = "0"`) also gated at least once
5. no feature disabled that the modules import (`strings`-check it)
   *(likewise)*
6. boot-window check passes (kernel end < ramdisk load address) — and remember
   the initramfs grew if it now carries modules
7. built with the toolchain family the tree's own `build.config.common` names
8. if shipping your own modules: they are in the boot image, `lsmod` on the
   device shows roughly the count the vendor's `modules.load` names, and
   `dmesg` shows neither "disagrees about version" nor "Unknown symbol"
