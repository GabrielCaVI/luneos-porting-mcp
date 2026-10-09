# Device: q25 (Zinwa Q25 / Q25 Pro)

Zinwa Q25 / Q25 Pro (`Q25`), BlackBerry Classic restomod on MediaTek Helio G99 (MT6789), Tier A on MediaTek's mgk kernel: KMI-clean kernel and boot image build and run on hardware.

The first MediaTek Tier A (GKI) target, the first LuneOS port onto a square screen (3.5" 720x720 1:1 panel, physical QWERTY and trackpad), and the port that produced the method's sharpest correction so far: **"GKI device" does not imply "an ACK kernel will do"**. MT6789 ships MediaTek's *mgk* GKI derivative, not pure GKI, and an ACK build scored 344 of 344 stock vendor modules failing to load before the device-tree build scored 0. The KMI-poison list is a property of a specific KMI-plus-tree rather than of GKI in the abstract. Yocto: layer `meta-smartphone/meta-zinwa`, `MACHINE=q25`.

Status: **a KMI-verified kernel and boot image build from this tree**, and the
device has run LuneOS on hardware (keyboard and audio measured on the phone from
late September 2026, a 3.9-day uptime by 6 Oct; the hardware results live in
meta-zinwa's commit history and are not yet written up here). `boot-q25-luneos.img` reproduces the stock header field for
field, and all **344 stock vendor modules load against our kernel with zero CRC
mismatches**. The stock firmware has been obtained and dissected
(`drive.zinwa.com` → Google Drive → `OS-Images/Q25/MassProduction/With-GMS/OS-new-camera-0120-Q25-GMS.zip`,
2.53 GiB, build `SP1A.210812.016`, 20 Jan 2026).

## Platform facts

All verified from the device's own LineageOS device tree
(`LineageOS/android_device_xelex_Q25`, `lineage-23.2`), its GPL kernel tree
(`LineageOS/android_kernel_xelex_mt6789`), and the Droidian port
(`JamiKettunen/droidian-zinwa-q25` + `gitlab.com/deathmist/halium-gki`
branch `q25-droidian`). Not from hardware.

| Fact | Value |
|---|---|
| Codename / vendor | `Q25` (capital Q), `xelex`. Board name `q20_v12_factory` |
| SoC / GPU | MediaTek Helio G99 = **MT6789**, Mali (`ro.hardware.vulkan=mali`); EGL driver is `libGLES_meow.so` (`ro.hardware.egl=meow`) |
| CPU | arm64, cortex-a76 + cortex-a55, armv8-2a |
| RAM / storage | 12 GB, 256 GB UFS (228 GiB userdata stock) |
| Panel | 3.5" 720x720 IPS, driver `panel-q20-hd720-lcm-dsi-vdo.ko`. True 291 ppi; LineageOS ships density 193 |
| Stock Android | **12** (`SP1A.210812.016`). `ro.vndk.version=31`, `ro.board.first_api_level=31`, `ro.vendor.build.version.sdk=31`. The Android 14 build *fingerprint* on system/product/odm is an attestation spoof — every real platform property says 12 |
| Kernel | `5.10.198-android12-9-gfcab0aff02db`, clang **r416183b** (12.0.5), `Image.gz` → KMI **android12-5.10 generation 9**. `CONFIG_MODVERSIONS=y`, `MODULE_SIG_FORCE` not set |
| Partitions | A/B, dynamic (`super` 9216 MiB), separate `metadata` 32 MiB. `init_boot_a/b` exist in the scatter (8 MiB) but are **unused** — no `init_boot.img` ships and nothing flashes one |
| boot | header **v4**, 64 MiB. kernel 20,174,525 B + ramdisk 1,189,717 B (non-zero → generic ramdisk rides here). os_version 12.0.0, patch 2024-03, **cmdline empty** |
| vendor_boot | 64 MiB, header v4, one ramdisk fragment (18.9 MB gzip), dtb 184,000 B. cmdline `bootopt=64S3,32N2,64N2 buildvariant=user`. 180 early modules incl. `bbqX0kbd.ko`, `8250_mtk.ko` |
| AVB | enabled, boot rollback index 1, vbmeta + vbmeta_system + vbmeta_vendor |
| Console | `8250_mtk.ko` → `ttyS0`. Stock vendor_boot cmdline asks for `console=tty0` |
| Wi-Fi / BT | connac1x combo, `gen4m_6789`, control node `/dev/wmtWifi` |
| Modem | single SIM (`ro.telephony.sim.count=1`), VoLTE/VoWiFi props present |
| SPL | 2024-03-05 |
| Vendor modules | **344 unique**: 180 in the vendor_boot ramdisk + 184 in `vendor_dlkm_a` (32.2 MiB, inside super) |
| Camera | `imx111_mipi_raw` + `s5kjn1_mipi_raw`; modem `q20v1_a_ulwctg_cogps` |

### The keyboard, which is the interesting part

`drivers/input/keyboard/bbqX0kbd/` in the GPL kernel tree — Zinwa's fork of
wallComputer's driver, talking over I2C to an RP2040 running solderparty
`i2c_puppet` firmware. Contrary to what the Droidian wiki assumes, the source
*is* published (though `bbqX0kbd_main.o_shipped` sits next to the `.c`, so
part of it ships prebuilt).

- It registers **one** input device, `input->name = "Q25_keyboard"`, carrying
  `EV_KEY` *and* `EV_REL` (`REL_X`/`REL_Y`) *and* `BTN_LEFT`/`BTN_RIGHT`. The
  QWERTY, the toolbelt keys and the trackpad are all that one node. The stock
  `.kl`/`.kcm`/`.idc` are keyed on the same name.
- `/proc/q20_switch_key_mouse`: `0` (the driver default) → the trackpad reports
  relative motion, i.e. a pointer. `1` → it accumulates offsets and emits
  `KEY_UP/DOWN/LEFT/RIGHT` past a threshold, i.e. a d-pad. LuneOS wants the
  default.
- `/proc/q20_spec_power_flag`: `1` enables wake-on-`Call end` (stock Android
  exposes it as "Keyboard function switching"), at some idle-power cost.
- `/proc/firmware_upgrade`: `1` then `2` while holding `Call end` puts the MCU
  in mass-storage mode for a `.uf2` firmware update. Without holding `Call end`
  the same sequence puts the keyboard into "PC mode" over USB.
- `bbqX0kbd.ko` is in `modules.load.ramdisk`, so it loads from `vendor_boot` —
  the keyboard is alive in the initramfs, which is worth a great deal when
  debugging a device with no UART.

Power and volume are separate and conventional: `mtk-pmic-keys.c` registers
`"mtk-pmic-keys"`, `mtk-kpd.c` registers the matrix keypad.

## The kernel decision, and the measurement that reversed it

The Q25 looks like a textbook Tier A device — GKI boot image, `android12-5.10`
KMI generation 9, stock `vendor_boot` and `vendor_dlkm`, `CONFIG_MODVERSIONS=y`
with no `MODULE_SIG_FORCE`. So the port first did the Tier A thing: ACK
`android12-5.10` (via the Halium/Droidian fork, which carries MT6789
`gki_quirks`), built with the Clang the KMI was frozen with.

**That kernel scored 344 of 344 stock vendor modules failing to load**, with
`module_layout` itself mismatching — a total CRC shift, not a stray option.

The reason is in the stock kernel's own IKCONFIG: `CONFIG_ARCH_MEDIATEK=y` and
~1,200 options `gki_defconfig` does not have. **MediaTek does not ship pure GKI
on MT6789.** Their kernel is *mgk*: `gki_defconfig` merged with
`mgk_64_k510_defconfig` (646 lines, 280 `CONFIG_MTK*`), then
`entry_level.config`, then the board's `q20_v12_factory.config` — on a tree that
carries `drivers/misc/mediatek` and `drivers/gpu/mediatek` out of tree. The stock
modules' CRCs follow that. No ACK build of any vintage can match them.

So the port builds the **device's own kernel**, from
`LineageOS/android_kernel_xelex_mt6789` (`lineage-23.2`, at 5.10.198 — exactly
the stock kernel's version), with the device's own four-fragment config chain
plus a LuneOS delta. The KMI discipline is unchanged — stock `vendor_boot` and
`vendor_dlkm` stay, we replace only the kernel — but the baseline to reproduce is
MediaTek's, not Google's.

This is worth generalising: **"GKI device" does not imply "ACK kernel will do".**
The test is cheap and decisive (`kmi-crc-check.py` against the stock `.ko` set)
and it should be run before assuming the one-kernel-per-KMI property holds.

### The bisect

All numbers against the full 344-module set (180 from the `vendor_boot` ramdisk
+ 184 from `vendor_dlkm`), `kmi-crc-check.py`:

| Kernel | Result |
|---|---|
| ACK 5.10.250 (Halium fork) + `gki_defconfig` + droidian + LuneOS fragments | **344 of 344 would fail** |
| device tree 5.10.198, device config chain, **no** LuneOS delta | **0 would fail** |
| + an early LuneOS delta that also enabled `USER_NS` (and SysV IPC) | **344 would fail** |
| + LuneOS delta as shipped | **0 would fail** ← shipped |

**KMI-poison on MediaTek mgk android12-5.10 / MT6789: `CONFIG_USER_NS` and/or
SysV IPC** — measured only as a group. Neither is needed, so they were not
separated and both stay off.

Everything else LuneOS needs is clean: `PID_NS`, `CHECKPOINT_RESTORE`,
`DEVTMPFS(+MOUNT)`, `FHANDLE`, `TMPFS_XATTR`/`POSIX_ACL`, `AUTOFS_FS`, `VT`,
`QUOTA_NETLINK_INTERFACE`, `UEVENT_HELPER`, `STATIC_USERMODEHELPER=n`, the whole
netfilter/PPP/L2TP block, the bluez/vhci set, `VETH`. That `PID_NS` is clean is
**the same answer bluejay's bisect gave on android14-6.1** — two different SoCs,
two different KMIs.

Userland consequence: LXC must not unshare the IPC or user namespaces. `PID_NS`
is available.

### Rejected path: ACK android12-5.10

The first kernel was ACK from the Halium/Droidian fork
`gitlab.com/deathmist/kernel-android-common`, branch
`common-android12-5.10-droidian` (18 patches on ACK android12-5.10-lts @
5.10.250), pinned at `da8ef85f`, with its `droidian.config` merged over
`gki_defconfig` and the LuneOS fragment on top. It is the kernel the Droidian
port runs. Its MT6789-relevant patches:

| Patch | Why it matters |
|---|---|
| gki_quirks: `find_get_pid` hook for `mali_kbase(_mt6789)` | with `PID_NS=y` the Mali driver's pid lookups must resolve globally; without it, no GPU |
| gki_quirks: `snd_soc_jack_report` hook for `mt6358_accdet` | headset detection on the MT6358 codec |
| binder: ignore `txn_security_ctx` | the usual Halium hwbinder-stability patch |
| bluetooth: don't send `READ_SYNC_TRAIN_PARAMS` | ditto for BT |
| module.c: force-load on symbol-version failure | escape hatch Droidian leans on |

`droidian.config` also enables options its own comments call *"ABI-breaking when
enabled for MT6789"* (`FANOTIFY`, `NF_TABLES`, `HUGETLBFS`,
`NETFILTER_XT_MATCH_NFACCT`; the wiki adds `CGROUP_PIDS` and `POSIX_MQUEUE`) and
relies on the force-load patch. LuneOS keeps all six off: a force-loaded module
that disagrees about a struct layout corrupts memory rather than failing cleanly.

**Rejected because it scored 344 of 344 stock vendor modules failing** (table
above): no ACK build matches MediaTek's mgk CRCs, patches or not. The recipe
that built it was removed from meta-android.

### 5.10 kbuild gotchas (not device-specific — expect them on any 5.10 port)

Three of these cost a build cycle each:

| Symptom | Cause | Fix |
|---|---|---|
| `register 'sp' unsuitable for global register variables on this target` in `asm-offsets.c` | 5.10 derives clang's `--target` from `CROSS_COMPILE`; `LLVM=1` alone does not imply one (6.1 works it out from `ARCH`). clang was building for the x86_64 host | `CROSS_COMPILE=aarch64-linux-gnu-` — only the triple is used, no GNU binutils needed |
| wants an external assembler | 5.10 defaults to `-fno-integrated-as` | `LLVM_IAS=1` |
| whole kernel compiles, then `link-vmlinux.sh: python: not found` | 5.10 still spells `PYTHON` as `python`, and calls `scripts/jobserver-exec` | `PYTHON=python3`. Droidian's CI symlinks `python`→`python2`, which is both host-wide and the wrong interpreter — `jobserver-exec` parses clean as python3 |

Plus `CROSS_COMPILE_COMPAT=arm-linux-gnueabi-`, because `CONFIG_COMPAT_VDSO=y`.

## What was wired up

Everything below is in place and `MACHINE=q25 bitbake --dry-run
luneos-bootimg-gki` resolves the full graph (1657 tasks).

**New layer `meta-smartphone/meta-zinwa`** (added to `conf/bblayers.conf`):

| File | Role |
|---|---|
| `conf/layer.conf` | `zinwa-layer`, depends on core + openembedded-layer + android-layer |
| `conf/machine/q25.conf` | the machine. Boot-image only, like bluejay: no rootfs, no GSI baked in |
| `recipes-core/udev/udev-extraconf/70-q25.rules` | `Q25_keyboard` input tagging, `wmtWifi`/`stpbt`/`stpgps`/`conninfra_dev`/`accdet` ownership. Installed into the **generic halium-arm64 rootfs**, as sargo's are |
| `recipes-core/luneos-device-config/.../Q25-deviceinfo` | Tier 1: key devices, display DPI, device pixel ratio. Installed as `adaptations/Q25` with a lowercase symlink |
| `recipes-kernel/linux/linux-zinwa-q25_git.bb` + `files/luneos.cfg` | **the kernel** — device tree, device config chain, LuneOS delta, KMI-verified |

**`meta-smartphone/meta-android`** (generic):

| Change | Why |
|---|---|
| *(an ACK `android12-5.10` recipe lived here briefly and was removed once measurement showed it cannot serve this device — see above. The 6.1 one is untouched.)* |
| `recipes-bsp/gki-bootimg/luneos-bootimg-gki_1.0.bb` | **moved here from meta-google** and gated on `GKI_BOOTIMG = "1"` instead of a `^(bluejay\|panther)$` regex, so adding a GKI device is one line in its own machine conf. The recipe never was Google-specific; the class it inherits already lived here |
| `classes/gki_bootimg.bbclass` | `GKI_KERNEL_IMAGE_NAME` (default `Image.lz4`) so a machine can ask for `Image.gz` |
| `recipes-core/udev/udev-extraconf/65-android.rules` | `/dev/mali0` 0666 `system:graphics`, next to the existing `kgsl` and `pvr_sync` rules. Device-class, not q25-specific — same failure mode as pvr_sync (only root gets a GL context, so the compositor renders and every sandboxed GPU process does not) |

**`meta-smartphone/meta-google`**: `GKI_BOOTIMG = "1"` and
`PREFERRED_VERSION_linux-halium-gki = "6.1%"` added to `bluejay.conf` and
`panther.conf` — behaviour unchanged, they just now say out loud which KMI they
want, because there are two.

**`meta-webos-ports/meta-luneos`**: `nyx-modules/q25.cmake`, a copy of
`halium-arm64.cmake` (a machine without one does not parse).

**`conf/local.conf`**: `GKI_CLANG_DIR:q25` / `GKI_BUILD_TOOLS_DIR:q25`
machine-scoped, because android12-5.10 wants clang **r416183b** and the
existing unscoped values are android14-6.1's **r487747c**. Machine overrides
win over the plain assignments for `MACHINE=q25` only; bluejay and panther are
untouched.

## Build

```sh
# once: the KMI's own toolchain (clang-r416183b, ~3 GB, prebuilts only)
./fetch-gki-toolchain.sh   # from the port's tool directory

cd $BUILD_DIR && . ./setup-env

MACHINE=q25 bitbake linux-zinwa-q25          # Image.gz + Module.symvers + kernel-config
MACHINE=q25 bitbake initramfs-android-image
MACHINE=q25 bitbake luneos-bootimg-gki       # boot-q25-luneos.img, -debug.img
```

Output in `tmp/deploy/images/q25/`. The rootfs is the shared one:

```sh
MACHINE=halium-arm64 bitbake luneos-dev-image
```

Timing, so nobody thinks it has hung: `q25.conf` sets `KERNEL_LTO_THIN = "1"`
(see "ThinLTO" below). With `"0"` the device config's `LTO_CLANG_FULL` applies
and the kernel takes ~20 min, almost all of it the single-threaded
`LTO vmlinux.o` link. Editing `files/luneos.cfg` at all — comments included —
rehashes the task and costs a full rebuild.

To reproduce the stock baseline instead of the LuneOS one, put
`LUNEOS_KERNEL_FRAGMENT = "0"` in a conf file and pass it with `bitbake -R`.
Do that first whenever a KMI check fails: it separates "my delta broke it" from
"the tree or toolchain is wrong".

### Verified output, 13 Sep 2026

```
344 modules checked, 0 would fail to load

boot-q25-luneos.img   header v4, kernel 20,424,381 B, ramdisk 6,634,352 B,
                      os version 12.0.0, patch 2024-03
stock boot.img        header v4, kernel 20,174,525 B, ramdisk 1,189,717 B,
                      os version 12.0.0, patch 2024-03
```

27,066,368 B (full LTO), 40% of the 64 MiB `boot` partition. Every header
field matches stock except the sizes and our deliberate command line. The
current ThinLTO image with the patched keyboard driver is 23,470,080 B
(22.4 MiB).

## The stock firmware, and what it settled

`drive.zinwa.com` is a redirect to a public Google Drive folder
(`Q25-P26-Q27-res`). The path that matters:
`OS-Images / Q25 / MassProduction / With-GMS / OS-new-camera-0120-Q25-GMS.zip`
— 2.53 GiB, direct-downloadable with
`https://drive.usercontent.google.com/download?id=14F9dbToL6euSiRKtBRJ_l6PGQYne0QNl&export=download&confirm=t`.
Take the **OS** archive, not the OTA one. It is a full SP Flash Tool package:
scatter, preloader, every firmware blob, `boot.img`, `vendor_boot.img`,
`super.img`, vbmeta, and — usefully — the partitions' `.prop` files loose in the
tree, so the identity questions are answerable without unpacking anything.

| Question | Answer | Where it came from |
|---|---|---|
| Codename | **`Q25`** | `q20_v12_factory/vendor.prop`: `ro.product.vendor.device=Q25` — the exact property `luneos-device-config` reads first. The adaptation directory was already right |
| Vendor API level | **31** (Android 12) | same file: `ro.vndk.version=31`, `ro.board.first_api_level=31` |
| Which GSI | the existing **halium_arm64 16.0** one | `halium-luneos-16.0-20260910-1-halium_arm64.tar.bz2` already carries `com.android.vndk.v31` (alongside v30/v32/v33/v34). No VNDK-snapshot work of the kind mindphone needed |
| init_boot? | **no** | stock `boot.img` has a 1,189,717-byte ramdisk; no `init_boot.img` ships. The scatter's `init_boot_a/b` are unused |
| os_version field | 12.0.0 / 2024-03 | `unpack_bootimg` on the stock boot.img. `ANDROID_BOOTIMG_OS_VERSION = "0x18000183"` reproduces it exactly |
| boot cmdline | **empty** | ditto. `bootopt=...` lives in vendor_boot's cmdline, which stays stock — so the padded LuneOS cmdline displaces nothing |
| Kernel image | `Image.gz` | stock kernel is gzip, 5.10.198-android12-9 |
| Clang | `r416183b` | the stock kernel's own version string, matching what the recipe pins |

### The stock kernel config, and what it means for the fragment

`CONFIG_IKCONFIG_PROC=y`, so the config came straight out of the boot image
(2,669 options).
`mer_verify_kernel_config` on it gives **23 errors / 54 warnings** — almost exactly bluejay's 23/59.

**21 of the 23 are covered** by the LuneOS fragment. The two that are not are
the two that should not be:

- `NET_L3_MASTER_DEV` — deliberately left off (adds `l3mdev_ops` to
  `struct net_device`, which every vendor wifi module touches). ofono does not
  need VRF.
- `DUMMY` — the checker wants `n` while its own stock run shows Android ships
  `y`. Known checker quirk; keep the Android value.

That is the same shape bluejay finished in: a handful of remaining errors, every
one accounted for.

Other stock-config facts that shape the fragment:

| Option | Stock | Consequence |
|---|---|---|
| `PID_NS` | not set | the fragment turns it on; KMI-clean per the bisect |
| `MODVERSIONS` | `y` | the KMI check applies |
| `MODULE_SIG_FORCE` | not set | force-load is available as an escape hatch |
| `DEBUG_INFO_BTF` | not set | no pahole needed — the recipe already says so |
| `STATIC_USERMODEHELPER` | `y` | UMH is disabled in stock; the fragment unsets it so `request_module()` works |
| `VT`, `BT_HCIVHCI` | not set | both needed (bluebinder wants vhci); both set by the LuneOS fragment |
| `OVERLAY_FS` | **`y`** | the Tier 2 adaptation overlay path works here, unlike sargo's 4.9 kernel |
| `ANDROID_BINDERFS` | `y` | LuneOS's host-binderfs model works |
| `USB_CONFIGFS_RNDIS` + `ECM` | both `y` | both debug-network gadgets available |

### Getting the module set

`./extract-vendor-modules.sh firmware` reproduces it: 180 `.ko` out of the
vendor_boot ramdisk plus 184 out of `vendor_dlkm_a`, **344 unique**. The two halves are different files and both
matter — `mali_kbase_mt6789.ko` and `mt6358-accdet.ko`, the two modules the
Droidian fork's `gki_quirks` exist for, are in the `vendor_dlkm` half only.

For a host with neither `lpunpack` nor `simg2img`, `lpunpack.py` is a minimal
liblp reader (handles sparse input; `debugfs -R rdump`
then gets the files out of the ext4 without root).

## What is still needed

The kernel side is closed: KMI 0/344 and vermagic matching (see "The boot
blocker: vermagic" below). Open items:

1. Re-check `mer_verify_kernel_config` against
   `tmp/deploy/images/q25/kernel-config` once, to confirm what remains is
   deliberate (expect `NET_L3_MASTER_DEV`, `DUMMY` and `SYSVIPC`; SysV IPC is
   not needed and stays off).
2. Write up the hardware results (see Status).

Things that want attention on hardware:

- The square panel: `deviceinfo_display_dpi` and `deviceinfo_device_pixel_ratio`
  are arithmetic, not tuning.
- The keyboard: one input node is the whole QWERTY, the toolbelt keys and the
  trackpad, so whatever decides "is there a hardware keyboard" sees an unusual
  device.

## The install kit

Re-cut at the end of September 2026 in the device's staging kit, distributable as
`q25_20260930.zip` (1.22 GiB compressed, integrity verified).

| File | |
|---|---|
| `boot-q25-luneos.img` | 23,470,080 B (22.4 MiB) into the 64 MiB `boot` partition; carries the patched keyboard driver, and `kernel.release` = `5.10.198-android12-9-gfcab0aff02db` |
| `boot-q25-luneos-debug.img` | `enable_adb` variant |
| `userdata-luneos.img` | 4.2 GiB ext4 labelled `userdata`: `rootfs.img` (2.9 GiB halium-arm64) + `android-rootfs.img` (1.0 GiB, Halium 16 GSI `halium-luneos-16.0-20260910-1-halium_arm64`) side by side |
| `vbmeta.img` | Zinwa's own stock vbmeta |
| `install.sh`, `make-userdata.sh`, `README.md`, `SHA256SUMS` | |
| `userdata-src/` | the two images loose, for rebuilds (not zipped) |

**No `fastboot boot` anywhere.** MediaTek's lk frequently does not implement it,
so the debug image is *flashed* rather than booted out of RAM, and the install
never depends on a debug-boot + `adb push` step. The rootfs goes in as a
prefilled `userdata` image (`fastboot flash userdata`, the route the Droidian
port proves on this hardware) that grows to the partition on first boot.

`install.sh` gained two checks over the September version, both from the MP01:
a **lock-state check** (a locked MediaTek lk does not report itself locked; it
refuses individual critical partitions with "No support by lock control", which
reads like a problem with that partition) and a **partition-size report** (the
scatter nominally declares `userdata` as 3 GiB; the real one is ~228 GiB and the
image relies on the initramfs growing into it).

The GSI had to be regenerated from the tarball, not copied from another kit. The tarball in `DL_DIR` unpacks to a **raw**
ext4 `system.img`, so it is a rename rather than a `simg2img` — worth knowing,
because the recipe path does convert and the assumption is easy to carry over.

**Use the `halium-arm64` rootfs, not the `luneos-dev-image` built for
`MACHINE=q25`.** Both appear in `tmp/deploy/images` if someone builds the latter,
and only the former is correct: the whole point of the generic rootfs is that it
carries nothing device-specific, and `generic-rootfs-qa` exists to keep it so.

### The bug that assembling the kit exposed

`kbdscroll` **was not in the rootfs at all** — `/usr/sbin/kbdscroll: File not
found` — so every bit of the relative-pad work was dead on this device. Caught
only by checking the assembled image rather than trusting the build.

`packagegroup-luneos-extended` gated it on

```bitbake
RDEPENDS:${PN}:append = "${@bb.utils.contains_any('MACHINE_FEATURES', 'keyboard-touch trackpad', ...)}"
```

which is evaluated for the machine that **builds the rootfs**. That is
`halium-arm64`, whose `MACHINE_FEATURES` has neither flag; `trackpad` lives in
`q25.conf` and `keyboard-touch` in `athena.conf`, and neither of those machines
builds a rootfs. So the package could never reach either device.

This is the **same architectural gap as the kbdscroll profiles, one level up**:
anything gated on a device machine's `MACHINE_FEATURES` is invisible to the
shared rootfs. The fix matches how `70-q25.rules` and the
`luneos-device-config` adaptations already work — ship it on the generic image
and let the runtime decide:

```bitbake
RDEPENDS:${PN}:append:halium-arm64 = " ${KEYBOARD_TOUCH_RDEPENDS}"
RDEPENDS:${PN}:append:halium-arm   = " ${KEYBOARD_TOUCH_RDEPENDS}"
```

Safe because it is already how kbdscroll behaves: with no touch surface besides
the touchscreen it logs "nothing to do" and exits 0 deliberately, and its own
comment says the package is expected on machines that have none.

**Worth generalising: when a device builds only a boot image, every
`MACHINE_FEATURES`-gated package is a candidate for the same bug.** Grep
`contains_any('MACHINE_FEATURES'` in the packagegroups and ask, for each, whether
a q25/mp01/athena-style machine would ever see it.

Verified in the re-cut image: `kbdscroll` present (67,880 bytes, carrying the
relative code paths), `by-codename/{athena,q25}.conf` installed, the Q25 Tier 1
adaptation with all four MediaTek keys, and `70-q25.rules`.

## Install sketch (the manual sequence)

A/B, which gives the Droidian port's nicest property: **Android keeps slot A
and LuneOS takes slot B**, so the stock ROM stays bootable and switching is
`fastboot --set-active=other reboot`. Flashing slot B needs the stock firmware
flashed to slot B first (everything except `logo`, `super` and `boot_b`) or the
slot is in an unknown state — the Q25 wiki has the exact list.

```sh
fastboot --disable-verity --disable-verification flash vbmeta_b vbmeta.img
fastboot set_active b
fastboot flash boot_b   boot-q25-luneos.img
```

`rootfs.img` and `android-rootfs.img` then go into a filesystem the initramfs
can find. The kit uses a flashed `userdata` image (mindphone/sargo style). The
Q25 also supports a microSD partition (Droidian's default, and the one that
touches nothing) or a dedicated `linux` partition carved out of `userdata` with
`mtkclient` and one of the wiki's pre-built GPT blobs.

Anti-rollback: unknown on this device. Assume it exists, never flash older
firmware than what is on it.

## The boot blocker: vermagic (fixed 26 Sep 2026)

The port as it stood on 13 Sep **would not have booted**, and the reason is worth
stating in full because every individual check had passed.

`check-kmi.sh` said 344 of 344 stock modules load with 0 CRC mismatches, and
`mtk-load-modules.sh` escalates `modprobe` -> `--force-vermagic` -> `--force`, so
a vermagic that differed looked covered. Both true; both irrelevant to the
modules that decide whether the device comes up.

Those are loaded by the **initramfs**, not by that script. On this device the
storage and USB controllers are themselves vendor modules -
`ufs-mediatek-mod.ko`, `phy-mtk-ufs.ko`, `mtk-mmc.ko`, `musb_hdrc.ko`, all in the
stock `vendor_boot` ramdisk's `/lib/modules` - so `init.sh` must insmod them
before it can find userdata at all. The initramfs carries only **busybox**
insmod/modprobe, which has no `--force-vermagic`, and `CONFIG_MODULE_FORCE_LOAD`
is not set in the stock config either. Vermagic therefore has to genuinely match
or nothing loads, there is no userdata, and the phone is mute: no console (no
debug UART), no adb (the USB controller is one of the modules that did not load).

```
stock modules want:  5.10.198-android12-9-gfcab0aff02db SMP preempt mod_unload modversions aarch64
we were producing:   5.10.198-g2a873a3511ee             SMP preempt mod_unload modversions aarch64
now:                 5.10.198-android12-9-gfcab0aff02db   <- kernel.release, deployed as a build artefact
```

Everything after the release string already matched, because we build the
device's own config. The sublevel needed no rewriting either - the xelex tree is
genuinely 5.10.198, exactly what the stock kernel reports - so the fix is two
lines in `files/vermagic.cfg` (`CONFIG_LOCALVERSION`, `LOCALVERSION_AUTO` off)
plus an empty `.scmversion` written in `do_configure:prepend`, without which
`scripts/setlocalversion` appends a `+` and the match misses by one character.

Merged **unconditionally, including for the `LUNEOS_KERNEL_FRAGMENT="0"`
baseline**: it belongs to "reproduce the vendor's kernel", not to the LuneOS
delta, so the baseline must carry it or the baseline is not a baseline.

### Why not "build the vendor's modules instead" (kmi-crc-matching.md step -1)

That is the better answer on most devices and the wrong one here, for two
measured reasons:

1. **Nothing to buy.** The CRCs already match, 344 of 344. The binaries the
   device already has are fine; only the vermagic string blocked them.
2. **Actively risky on MT6789.** The MP01 embedded its 180 vendor modules
   (5.5 MB compressed), the boot image went 28 MB -> 31.6 MB, and lk then
   stopped loading it at all - no kmsg, no panic, nothing in expdb, on six
   consecutive images. The 64 MiB partition was never the constraint; the
   combined ramdisk the kernel must decompress is.

ThinLTO (`KERNEL_LTO_THIN = "1"`, set in `q25.conf`) is the other change worth
having: it took the kernel from 20.4 MB to **16.0 MB** and the boot image to
~22.6 MB, which is more
headroom under that ceiling as well as a much shorter build (the stock config's
full-LTO `vmlinux.o` link is ~20 minutes of a single core). KMI-neutral by
construction and re-verified 0/344.

## What else came from the MP01 (26 Sep 2026)

The MP01 is the same SoC, the same MediaTek `mgk` android12-5.10 kernel, and it
**boots to the LuneOS UI**. Read `device-mp01.md` alongside this. Taken from it:

| Change | Why |
|---|---|
| `cgroup_disable=net_prio` on the boot cmdline | Breaks a boot- *and* shutdown-time deadlock: `net_prio`'s `cgrp_css_online()` takes rtnl under cgroup_mutex, connmand holds rtnl in `ccmni_close()` waiting on an "events" work item, and every events kworker waits on cgroup_mutex in `cgroup_bpf_release()`. PID 1 then blocks in `proc_cgroup_show`. Nothing device-specific: `net_prio` is the only controller whose `css_online` takes rtnl, `ccmni` is MediaTek's shared cellular netdev, and LXC + connman are the same on every port |
| `deviceinfo_hybris_prefer_vndk="1"` | **Verified on this device, not assumed**: the Q25's own `/vendor/lib64/libnvram.so` (out of super.img) imports `android::base::Basename(const std::string&)`, which the Android 16 GSI's libbase no longer exports. Without it pulseaudio crashes on start |
| `deviceinfo_audio_sample_rate="48000"` | MediaTek's HAL runs its downlink paths at 48 kHz; at pulseaudio's default 44.1 kHz it resamples everything |
| `deviceinfo_bluebinder_ext_features_page_2_mask="0x0400000000000000"` | The MT6789 claims Synchronization Train support and then answers Read Synchronization Train Parameters with "Unknown HCI Command", aborting hci init - hci0 never comes up. Attributed to the chip, and this is the same chip with the same connac1x Bluetooth |
| `deviceinfo_force_hwc2="1"` | `ro.hardware.hwcomposer=mtk_common`, as on the MP01, where the compositor otherwise spun trying to become DRM master |

The same three userspace keys appear independently in the **radon** (MT6877)
adaptation, which is what makes them MediaTek-A12-vendor properties rather than
board ones.

Deliberately **not** copied, each with its reason recorded in the file that would
have carried it:

- `GKI_RAMDISK_COMPRESSION = "lz4-legacy"` - both of the Q25's stock ramdisks are
  **gzip** (checked with `file` on the unpacked stock `boot.img` and
  `vendor_boot.img`), which is what `initramfs-android-image` already produces.
  The MP01's are LZ4 and AOSP requires the compression to match across the
  bootloader's concatenation.
- `initcall_debug=0 loglevel=4` - these undo an MP01 vendor_boot cmdline that
  turns both on. The Q25's is `bootopt=64S3,32N2,64N2 buildvariant=user` and
  turns on neither.
- `deviceinfo_battery_critical_percent="0"` - different charging hardware
  entirely (mt6358_battery + hodafone_battery, upm6922/upm6722, mt6375 PD). If
  the phone powers off within a minute on a charger, check
  `/sys/class/power_supply/battery/capacity` first - that is the MP01's symptom.
- `deviceinfo_backlight_outdoor_scale` (E Ink only) and
  `deviceinfo_compositor_geometry` (the MP01's panel is mounted rotated; the
  Q25's is square).

## Module audit: what our tree can and cannot build (26 Sep 2026)

Prompted by a good question - whether we actually have source for the keyboard
driver, given the `.o_shipped` objects sitting next to it in the LineageOS repo.

**We do.** kbuild's `%.o: %.c` rule wins wherever the `.c` exists, and
`.bbqX0kbd_main.o.cmd` in the build tree is a full 133 KB clang invocation, not a
`cp`. Our `bbqX0kbd.ko` carries the same 43 text symbols as the stock binary -
including Zinwa's own `hodafone_q20_*`, `q20_switch_key_mouse_*`,
`q20_spec_power_flag_*` and `firmware_upgrade_*` - differing only by ThinLTO's
`$<hash>` CFI suffixes on static functions. The `.o_shipped` files are ignored
dead weight.

Systematically, our build produces **333 of the device's 344 stock modules**. The
11 it does not:

| Missing | What it is | Source | Matters? |
|---|---|---|---|
| `met.ko` + 9 × `met_*_api.ko` | MediaTek Extensive Tracing (profiling) | **absent from the tree** | No - debug tooling |
| `fpsgo.ko` | an older FPS governor; we build `mtk_fpsgo.ko` from `performance/fpsgo_v3/` | v3 only | No - perf tuning |

None of them blocks anything: the device keeps all 344 stock modules and they now
load.

### A naming bug, fixed before it bit

`mali_mgm_mt6789.ko` and `mali_prot_alloc_mt6789.ko` were in that missing list
until 26 Sep, and the reason was not missing source. MediaTek's Mali tree sets

```make
MTK_PLATFORM_VERSION := $(CONFIG_MTK_PLATFORM:"%"=%)      # midgard/Makefile:21
```

without exporting it, and the two **sibling** directories name their modules from
it:

```make
obj-m += mali_mgm_$(MTK_PLATFORM_VERSION).o
obj-m += mali_prot_alloc_$(MTK_PLATFORM_VERSION).o
```

kbuild descends into them with the variable unset, so we produced `mali_mgm_.ko`
and `mali_prot_alloc_.ko`. `mali_kbase` escapes it because
`drivers/gpu/mediatek/Makefile` *exports* `MTK_PLATFORM`, which is what names
that one. Android's build passes the variable in the environment, which is why
the vendor never hit it.

Harmless while the only module we ship is `bbqX0kbd.ko`, but it is exactly the silent
failure kmi-crc-matching.md warns about under *"DO match the layout exactly"*:
the vendor's `modules.load` and `modules.dep` address modules by name, so a
future module override would quietly skip these two and load the vendor's
binaries against our kernel. Fixed with `MTK_PLATFORM_VERSION=mt6789` on the
recipe's make line; overlap went 331 -> 333 and the KMI check stayed at 0/344.

## The keyboard: what actually reaches Qt

Established 26 Sep by reading the driver, and it is a real gap rather than a
tuning question.

The Q20 keyboard hardware reports **uppercase ASCII scancodes**; the driver
resolves them and reports both `EV_MSC/MSC_SCAN` (the raw scancode) and an
`EV_KEY` keycode. **Android reads the scancode** through
`Q25_keyboard.kl`/`.kcm`, which is why punctuation works there. **Qt's
evdevkeyboard plugin reads only `EV_KEY`**, and the driver's two layer maps cover
only:

- `bbqX0kbd_get_num_lock_keycode()` - digits: W->1, E->2, R->3, S->4, D->5,
  F->6, Z->7, X->8, C->9, `$`->0. And it is gated on a **latched num-lock**
  (Alt then RightShift), not on Alt being held.
- `bbqX0kbd_get_altgr_keycode()` - navigation and volume only: PageUp/PageDown,
  arrows, Home, Menu, VolUp/VolDown, Mute, Delete.

Every symbol in the Q20 layout - `# ( ) _ - + @ * / : ; ' " ? ! , . \ ^ = { } [ ]
< > &` - falls through `default: returnValue = keycode`, so Qt sees the bare
letter keycode with Alt or Sym reported as an ordinary modifier. **On LuneOS as
it stands the keyboard types letters, digits, arrows and Enter/Space/Backspace,
and no punctuation at all.**

There is no per-device keymap file to fix it with, which is worth writing down
because it is the obvious first assumption:

- `generate_qmap` (qt-features-webos) takes **only an output path** and emits a
  fixed built-in table (Qt's default plus `webos_keymap`). There is no input
  keymap, so a `.qmap` cannot be device-specific without patching that shared
  recipe - which would change Alt+letter behaviour on every other device.
- `kbdscroll`'s `profiles/<machine>.conf` is the right *shape* of answer but the
  wrong tool: it reads **absolute** touch surfaces and says so explicitly - "an
  optical pad that reports REL_X/REL_Y is already a pointer to the compositor
  and is not what this reads". The Q25's trackpad is relative.
- The `.kl`/`.kcm` in the LineageOS device tree are Android's, read via
  `MSC_SCAN`, which Qt never looks at.

(`trackpad` in q25.conf's MACHINE_FEATURES only documents the device: kbdscroll
now ships on the generic rootfs regardless, and reads relative pads — see
"Scrolling" below.)

### Closed: the symbol layers are resolved in the driver (26 Sep 2026)

`meta-zinwa/recipes-kernel/linux/files/0001-bbqX0kbd-Q20-symbol-layers.patch`
maps both layers to the keycode and shift state a US layout needs, taken from the
diagram in `bbq20kbd_pmod_codes.h` (character printed *above* a key = Alt,
*below* = Sym). `q20_layers=0` as a module parameter restores stock behaviour
without a rebuild.

Three things it has to get right, each of which would fail silently:

- **Declare the new keycodes.** `KEY_MINUS`, `KEY_SLASH`, `KEY_SEMICOLON`,
  `KEY_APOSTROPHE`, `KEY_COMMA`, `KEY_DOT`, `KEY_BACKSLASH`, `KEY_LEFTBRACE`,
  `KEY_RIGHTBRACE` are not in the base table, and the input core **drops** an
  event for a key the device never set in `input->keybit`. The probe now sets
  them from the two tables.
- **Remember what was emitted, per scancode.** Releasing Alt before the key
  would otherwise report a release for a keycode never pressed and leave the
  symbol held down for ever.
- **Do not fight a physical shift.** The synthetic `KEY_LEFTSHIFT` is injected
  only when neither physical shift is down.

Alt and Sym are no longer reported to userspace at all: on this keyboard they are
layer selectors printed on the keys, not PC modifiers, and reporting them makes
the toolkit see `Alt+Shift+3` rather than `#`.

**The patch alone would have been dead code**, and this is the part worth
remembering. `bbqX0kbd.ko` is a *module*, in the stock `vendor_boot` ramdisk's
`modules.load` (line 129 of 160), and the Q25 ships none of its own modules - so
the device would have loaded the vendor's binary and never seen the patch. The
fix is the MP01's arrangement for its patched `mediatek-drm.ko`:

- the recipe's `do_install` puts the stripped module in the machine initramfs,
- `q25.conf` sets `ANDROID_EXTRA_INITRAMFS_IMAGE_INSTALL = "linux-zinwa-q25"`,
- `init.sh`'s `stage_our_kernel_modules()` copies `/usr/lib/modules/*.ko` over the
  vendor's `/lib/modules/` before anything is modprobed - necessary because
  usrmerge packages ours at `/usr/lib/modules` while the vendor ramdisk creates a
  real `/lib/modules`, and cpio only substitutes at an identical path,
- `load_kernel_modules()` then loads in the vendor's own `modules.load` order, so
  the dependency order stays theirs and only the binary is ours.

It logs `initrd: installed 1 of our own kernel modules over the vendor's` to
kmsg, which is the thing to grep for on first boot.

One 66 KB module, not the 344-module wholesale copy: the boot image is 22.4 MiB,
against the ~28 MB at which the MP01 measured lk refusing to load one at all.

Verified: patch applies cleanly, driver compiles with no warnings, the new
`q20_alt_layer`/`q20_sym_layer`/`q20_held_*` symbols are in the built module, it
is present in the initramfs at `/usr/lib/modules/bbqX0kbd.ko`, and the KMI check
is still 344 of 344.

**Untested on hardware.** The layout transcription, whether suppressing Alt/Sym
breaks any shortcut worth having, and whether the shift injection reads correctly
through Qt all want checking on the device.

### Scrolling: kbdscroll now reads a relative pad (26 Sep 2026)

The keyboard types; the *pad* is what scrolls, and it did nothing. Two facts
decide the design:

- **The LuneOS shell scrolls under a finger, not a cursor.** kbdscroll exists
  precisely because nothing in a Wayland stack does anything useful with a
  secondary surface, and it injects a synthetic touch contact so "every toolkit
  (Mojo, Enyo, QML, Chromium) scrolls - and flings - exactly as it would under a
  real finger". Moving a pointer around buys almost nothing here.
- **The Q25's pad is relative.** The driver advertises `EV_REL` `REL_X`/`REL_Y`
  and nothing else - signed int8 deltas - so there is no coordinate space, no
  touch-down and no touch-up. kbdscroll excluded relative pads by design, on the
  grounds that "the compositor already turns that into a pointer… a device that
  has one does not need this". True on a desktop, false on a touch-first shell,
  and the Q25 is the device that falls through the gap.

So kbdscroll now reads relative pads, with the gesture boundaries synthesised:
first movement after stillness is the contact coming down, `rel-lift-ms` (120 ms)
of stillness is it lifting. The deltas accumulate into a virtual surface
(`rel-width`/`rel-height`, defaulting to the screen's size so one pad unit is one
screen pixel at scale 1.0), and everything downstream - slop, axis locking,
scale, the fling, the cursor modifier, typing-cancels-the-gesture - is the same
code the absolute path uses. The lift feeds one synthetic `SYN_REPORT` through
the same loop rather than duplicating the end-of-stroke handling, so there is
exactly one code path.

It deliberately does **not** grab the device: on the Q25 the pad and the whole
QWERTY are one input node (`Q25_keyboard`), so a grab would swallow typing. If a
cursor turns out to move and fight the injected finger, that belongs in the
compositor's input configuration, not here.

`profiles/q25.conf` is the config file. Two entries in it are judgements rather
than measurements and are the first things to check on hardware:

- `cursor-modifier = rightalt`, not the default Alt. On this keyboard **Alt is
  the symbol layer** - Alt+Q is `#` - so leaving the modifier on Alt would make
  every punctuation mark move the text cursor instead. Sym already carries the
  printed arrow keys, which is the same idea.
- `arrows = uinput`. A Classic layout has no dedicated arrow keys, so a device of
  our own is the only way to send them.

### The profile mechanism had to change too

kbdscroll installed `profiles/${MACHINE}.conf` at build time. That cannot work
for this device, or for mp01, or for any other Halium target: they build **no
rootfs of their own** and run the generic `halium-arm64` one, where `${MACHINE}`
is `halium-arm64` and a `q25.conf` would simply never be installed.

So profiles now ship together and are selected at runtime by codename, from
`LUNEOS_DEVICE_CODENAME` in `/run/luneos-device/device.env` - the same
arrangement `luneos-device-config` uses for its Tier 1 adaptations, for the same
reason. Codenames are not reliably lowercase (`Q25`, `MP01`) while profiles are
named after the machine, so the exact spelling is tried first and then lowercase.

A machine that *does* build its own rootfs keeps its build-time drop-in as well,
so athena's tuning does not become conditional on codename derivation working.
Verified: the generic rootfs gets `by-codename/{athena,q25}.conf`, athena gets
those **plus** its original `10-athena.conf`.

Verified: compiles clean under `-Wall -Wextra` and in the cross environment for
both machines, the new options appear in `--help`, and `--list` degrades
gracefully. **Not run against hardware** - there is no `/dev/uinput` or
`/dev/input` access on the build host, so the state machine has been reasoned and
compiled but never exercised. The test on the device is
`kbdscroll --list` (is `Q25_keyboard` chosen as the pad, and reported as
`relative`?) then `kbdscroll --debug` while sliding: expect
`relative contact down`, then `touch at x,y`, then
`relative contact up: N ms still`.

### What is still worth doing

`keyd` stays the deferred alternative, and is still worth doing later for what
the driver route cannot give: the three layout variants (qwerty/qwertz/azerty)
switchable without a rebuild, latched/one-shot modifiers, remapping the toolbelt
keys to Ctrl/Alt when held as Droidian does, and a user-editable config. What the
driver route gives that keyd cannot: it works in the initramfs and a TTY, needs
no daemon or evdev grab, and keeps one source of truth for the layout.

### The two routes, as assessed before choosing

1. **Patch the driver** - extend the two lookup functions to cover the symbols,
   synthesise `KEY_LEFTSHIFT` around the shifted ones, make Alt work held rather
   than latched, and stop reporting Alt/Sym as modifiers so Qt does not see
   `Alt+Shift+3`. Self-contained in our own kernel, and now known to be viable
   since the source is complete.
2. **Port `keyd`** and ship the Droidian port's `q25-qwerty`/`qwertz`/`azerty`
   configs, which are already tested on this exact hardware. A new recipe, but it
   sits between evdev and everything, so Qt, maliit and Waydroid all benefit, and
   the layout becomes a user-editable file per layout.

## How much of mindphone transfers (both are MediaTek)

Short answer: the *method* transfers, almost none of the *specifics* do. MT6739
and MT6789 are two generations and a different connectivity family apart, and
mindphone is pre-GKI while the Q25 is GKI-shaped.

| | mindphone (MT6739) | q25 (MT6789) |
|---|---|---|
| Android / kernel | 11 / 4.14, 32-bit | 12 / 5.10 mgk, arm64 |
| Partitions | non-dynamic, no vendor_boot | A/B, dynamic `super`, `vendor_dlkm` |
| Connectivity family | WMT (`wmt_drv`, `wlan_drv_gen2`, `bt_drv`, `gps_drv`) | connac1x (`wmt_drv`, `wmt_chrdev_wifi`, `wlan_drv_gen4m_6789`, `bt_drv_connac1x`, `connfem`) |
| Where the modules live | `/vendor/lib/modules` directly | `/vendor/lib/modules` → **absolute symlink** to `/vendor_dlkm/lib/modules` |
| How they are declared | vendor's `modules.load` | vendor's **init rc** `insmod` lines, property-templated |
| Stock module CRCs vs ours | mismatch → `--force` required | **match**; vermagic pinned to stock's |

### What transfers unchanged

- The whole `mtk-connectivity` idea: mirror the vendor's `.ko` into
  `/lib/modules`, `depmod`, load them host-side, then poke `/dev/wmtWifi` and
  fix `/dev/stpbt` ownership for the container's BT HAL.
- `mtk-bt-address.sh` — the BT MAC is the first six bytes of
  `/mnt/vendor/nvdata/APCFG/APRDEB/BT_Addr` on both. The Q25's `fstab.mt6789`
  does mount `/mnt/vendor/nvdata`, so the path is right.
- The `/data/nvram` symlink for `wmt_drv`'s kernel-space nvram open.
- The `fstab.<ro.hardware>`-over-`fstab.enableswap` selection fix that mindphone
  forced — already generic, and the Q25 needs it for the same MTK NV partitions.

### The `/vendor_dlkm` symlink is a non-issue

`/vendor/lib/modules` is an absolute symlink to `/vendor_dlkm/lib/modules`, so
reading it through `/android/vendor/...` resolves against the **host** root.
That is fine, because `mount-android.sh` deliberately mounts `vendor_dlkm` at
host `/vendor_dlkm` — it cannot go under `$ANDROID_ROOT`, since LXC drops
anything mounted on the container rootfs. Checked on the real images:
`/vendor_dlkm/etc/build.prop` exists, so `try_mount_validated` accepts the
mount, and `/vendor_dlkm/lib/modules/modules.load` is there.

### What did NOT transfer, and had to be fixed

Two real bugs, both found by reading the Q25's own vendor partition:

1. **`mtk-load-modules.sh` picked the wrong modules.** It drove off the
   vendor's `modules.load`, which on MT6789 contains only `connadp.ko` and
   `c2k_usb_f_via_gps.ko` of the connectivity family — the real drivers are
   `insmod`ed by the vendor's init rc behind a two-stage gate:

   | trigger | modules |
   |---|---|
   | `on boot` | `wmt_drv.ko`, `connfem.ko` |
   | `on property:vendor.connsys.driver.ready=yes` | `${ro.vendor.wlan.chrdev}`, `wlan_drv_${ro.vendor.wlan.gen}`, `bt_drv_${ro.vendor.bt.platform}`, `${ro.vendor.gps.chrdev}`, `gps_pwr`, `fmradio_drv_${ro.vendor.fm.platform}` |

   That property is set by the container's own connsys daemon after it patches
   the CONSYS firmware — the same class of never-fires gate as the
   `wait_for_prop` problem `start-android-hals.sh` solves. The script now
   **derives** the ordered list from the rc files and expands the property
   templates off the mounted vendor partition, which keeps it device-agnostic.
   Verified offline against the Q25's own rc files and `build.prop`:

   ```
   connfem  wmt_drv  bt_drv_connac1x  fmradio_drv_mt6631_6635
   gps_drv_stp  gps_pwr  wmt_chrdev_wifi  wlan_drv_gen4m_6789
   ```

   with `wmt_drv` correctly ahead of the Wi-Fi pair. The `modules.load` path is
   kept as a fallback for the WMT era.

2. **The Bluetooth unit never ran.** `mtk-connectivity-bt.service` gated on
   `ConditionPathExists=|…/bt_drv.ko` or `…/conninfra.ko`; the Q25 has
   `bt_drv_connac1x.ko` and **no** `conninfra.ko` at all, so neither matched and
   systemd skipped the unit silently. Now `ConditionPathExistsGlob` with
   `bt_drv*.ko` / `conninfra*.ko`.

Also changed: the loader tries plain `modprobe`, then `--force-vermagic`, then
`--force`. On a KMI-preserving port at most the vermagic string differs (on the
Q25 it no longer does — see "The boot blocker: vermagic"), so
`--force-modversions` is not wanted, and blanket `--force` would hide a real CRC
regression. The fallback chain keeps mindphone working, where the CRCs genuinely
do disagree.

### Still mindphone-only, and worth revisiting on hardware

- **`mtk-ril-watchdog`** (in `meta-greentouch`, so mindphone-only today).
  The Q25's `mtkrild.rc` declares `vendor.ril-daemon-mtk` with the *identical*
  `oneshot` + `disabled` pair that means init will not respawn it, and it runs
  the same `mtkfusionrild`. If telephony dies once and stays dead, this is the
  fix — but it needs moving to `meta-android` (the Q25 builds no rootfs of its
  own) and it should not be moved blind.
- **`bluebinder`'s `mt6739-le-commands.conf`.** That patches an MT6739
  controller that under-reports its LE supported-commands bitmap. The Q25 is
  connac1x, a different controller; do not copy it. If LE discovery finds
  nothing while classic inquiry works, that file is the known *shape* of the
  fix, with a bitmap derived for this chip.

## Known hazards, inherited from the Droidian port

Worth reading before concluding any of these is a LuneOS bug:

- **The 20-character cmdline.** MediaTek's G99 lk drops the first 20 characters
  of the boot image command line. `ANDROID_BOOTIMG_CMDLINE` pads with `?`
  accordingly. Anything LuneOS really needs goes in `CONFIG_CMDLINE` instead,
  which is where the cgroup-v1 pair lives.
- Backlight IC varies between units: `ocp2131` on early ones, `rt4831a` on
  final. `ocp2131_drv.ko` is in the shipped module list.
- Headset: needs replugging if present at boot; mic is always routed from the
  jack. Both are kernel-workaround artefacts on Droidian.
- Hotspot needs `echo A > /dev/wmtWifi` rather than the UI toggle.
- Signal strength is under-reported by the modem stack.

## Sources

- https://github.com/JamiKettunen/droidian-zinwa-q25 (+ its wiki)
- https://gitlab.com/deathmist/halium-gki/-/tree/q25-droidian
- https://gitlab.com/deathmist/kernel-android-common/-/tree/common-android12-5.10-droidian
- https://github.com/LineageOS/android_device_xelex_Q25
- https://github.com/LineageOS/android_kernel_xelex_mt6789
- https://wiki.lineageos.org/devices/Q25/
