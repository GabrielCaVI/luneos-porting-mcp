# Building Halium GSIs for LuneOS

How LuneOS builds the Halium GSIs it mounts as /android: halium_arm64 and halium_arm products, the halium-16.0 traps, device-tree patches and publishing.

The generic `/android` system image LuneOS mounts is a **Halium GSI**: an AOSP/LineageOS build of the `halium_arm64` (or 32-bit `halium_arm`) product from the `Halium/android` manifests, with hybris-patches applied. It is built per Halium generation (9/11/13/14/16 so far), never per device, and shipped as a tarball that the Yocto `android-system-image` recipes consume; every current port runs 16.0. This document records how the images are built, the traps hit on `halium-16.0` (lunch combo, version gates, removed modules), the device-tree patches required for a 16.0 GSI serving older vendors, and the complete recipe for building 32-bit `halium_arm` GSIs (needed for 32-bit-userland devices like mindphone/MT6739).

## Where the trees and artifacts live

| What | Where |
|---|---|
| Halium trees (with `.repo` + hybris-patches) | one checkout per generation (`<halium tree>/{11.0,13.0,14.0,16.0}`) |
| Published GSIs | `webOS-ports/halium-images` GitHub releases |
| 16.0 device-tree patches | `Herrie82/android_device_halium_halium_arm64` branch `herrie/16.0` (tip `25c6f12`) |
| The 16.0 GSI the recipes use | pinned once in `meta-android/recipes-core/android-system-image/halium-luneos-gsi-16.inc` |

Published generic GSI releases (`gh release list -R webOS-ports/halium-images`):

| Release tag | Contents |
|---|---|
| `halium-luneos-9.0-20240228-1-halium_arm64.tar.bz2` | 9.0 arm64 (served `.sha256sum`, `7469662b…`) |
| `halium-luneos-10.0-20230130-1-halium_arm64.tar.bz2` | 10.0 arm64 (pre-release) |
| `halium-luneos-11.0-20240219-1-halium_arm64.tar.bz2` | 11.0 arm64 |
| `halium-luneos-20260826` | 9.0, 11.0, 13.0, 14.0, 16.0 `halium_arm64`; 11.0 and 16.0 (`20260827-1`) `halium_arm` |
| `halium-luneos-20260830` | 16.0 `halium_arm` |
| `halium-luneos-20260910` | 16.0 `halium_arm64`, the first carrying VNDK 27–34 |
| `halium-luneos-20261005` | 16.0 `halium_arm` (`20261005-1/-2`, `20261007-1`, `20261008-3`), 16.0 `halium_arm64` `20261007-1`, plus prebuilt vendor images for legacy devices |

The build tooling itself lives in no repository — `halium-images` is release hosting only — so capturing the process as CI is a first-class task.

## The basic build (arm64)

The CI-shaped job is:

```
repo init -u https://github.com/halium/android -b halium-13.0   # or -9.0/-11.0/-16.0
repo sync
# apply hybris-patches
# device: halium/android_device_halium_halium_arm64  (product halium_arm64)
lunch <combo>          # see the 16.0 trap below
m systemimage          # → out/target/product/halium_arm64/system.img
```

Big machine, runs rarely, once per generation. This single job replaces every per-device Android build LuneOS has ever done.

Verified properties of the generic image (unsparsed): it is **system-as-root** — `/init`, `/system`, `/vendor`, `/odm` at the image root, so `ANDROID_SYSTEM_IMAGE_DESTNAME = "android-rootfs.img"` stays correct and `pre-start.sh` takes its `[ -e /android/init ]` branch. `/vendor` inside it is a **real empty directory** (0755, gid 2000), a clean mount point for the device's stock vendor.

## halium-16.0 setup and its three traps

Setup that worked:

| | |
|---|---|
| manifest | `Halium/android` `halium-16.0`, `c138022` |
| default revision | `refs/heads/lineage-23.2`; AOSP-remote projects at `android-16.0.0_r4` |
| device tree | `Halium/android_device_halium_halium_arm64` at `halium-14.0` — there is no halium-16.0 branch |
| extra | `phhusson/vendor_vndk` at `master` |
| lunch | `lineage_halium_arm64-bp4a-userdebug` |
| target | `m systemimage` |

### Trap 1 — lunch `bp4a`, never `trunk_staging` (the metalava failure)

With `lineage_halium_arm64-trunk_staging-userdebug` the build dies at 86%:

```
[ 86% 61583/70985] //frameworks/base/api:frameworks-base-api-current.txt generate current.txt
sbox_command.0.bash: line 1: ***missing tool metalava***: command not found
```

on four targets (`current.txt`, `system-current.txt`, `module-lib-current.txt`, `system-server-current.txt`). Chain: `trunk_staging` sets `RELEASE_PLATFORM_VERSION_CODENAME` to `Baklava` rather than `REL`; `build/soong/java/sdk.go:createAPIFingerprint()` only short-circuits when the codename is `REL`, otherwise it builds frameworks/base's `api_fingerprint` module, whose four srcs are `java_genrule`s with `tools: ["metalava"]`. The `halium_disable_java` pre-arch mutator has disabled `metalava` but not the `java_genrule`s that invoke it, so soong substitutes the `***missing tool***` placeholder and it fails at execution — all to stamp `ro.build.version.preview_sdk_fingerprint`, which no Halium build needs.

`vendor/lineage/release/` configures **`bp4a`** (codename `REL`, SDK 36) and ships aconfig values only for it — that is the intended combo. With `bp4a`, `PLATFORM_VERSION` is `16` rather than `Baklava`, which also defuses Trap 2. Note the failure is 40 minutes downstream of the lunch choice, and `trunk_staging` is what `lunch` suggests by default.

### Trap 2 — codename `PLATFORM_VERSION` silently breaks 19 libhybris version gates

`compat/Android.common.mk` and `compat/hwc2/Android.mk` derive `ANDROID_VERSION_MAJOR` from `PLATFORM_VERSION` and compare with `$(shell test $(ANDROID_VERSION_MAJOR) -ge N)`. A non-numeric operand makes `test` error, which reads as false, so **19 version gates silently take their oldest branch** — including the `-ge 16` gate for Android 16 support. Symptom:

```
ninja: 'libhwcomposer-command-buffer.a', needed by 'libhwc2_compat_layer.so',
missing and no known rule to make it
```

(`libhwcomposer-command-buffer` has not existed since Android 8.) Only bites on a codename release config; using `bp4a` avoids it.

### Trap 3 — `libmedialogservice` removed in Android 16

`frameworks/av/services/medialog` is gone, but `compat/media/Android.mk` links the library unconditionally for everything newer than Android 8, so `camera_service` has no rule to build. Fix direction: probe for the module by wildcard (the file already discovers `mediaserver` and `libmediaplayerservice` that way) rather than adding another version gate.

## The device-tree patches for a 16.0 GSI (`herrie/16.0`)

Against `Halium/android_device_halium_halium_arm64` at `8dbc6dc` (tip of `halium-14.0`, which the 16.0 manifest still points at). Pushed as `Herrie82/android_device_halium_halium_arm64` branch `herrie/16.0`, three commits:

| patch | why |
|---|---|
| preload `libselinux_stubs` into vndservicemanager; ship VNDK 32 | a stock vendor's vndservicemanager aborts without selinuxfs, so nothing owns `/dev/vndbinder` and every vendor HAL blocks |
| ship the VNDK 32 snapshot for Android 12.1 vendors | the 16 device tree shipped VNDK 34 alone; sargo's vendor needs 32 |
| ship uncompressed APEXes (`PRODUCT_COMPRESSED_APEX := false`) | `mount-apexes.py` cannot mount a `.capex`, so conscrypt, media and media.swcodec were silently skipped on 16 |

## VNDK snapshot matrix

The published arm64 16.0 GSIs from `halium-luneos-20260910` on ship every snapshot the
tree carries (`PRODUCT_EXTRA_VNDK_VERSIONS := 27 28 29 30 31 32 33 34`, v30 copied in
from the 14.0 tree as for `halium_arm` below), so one arm64 GSI serves vendors from
Android 8.1 to 14 and adding a device never means rebuilding the GSI. The published
`herrie/16.0` branch (tip `25c6f12`) does not carry that change. Each snapshot costs ~40 MB of system.img, uncompressed.

| VNDK | vendor | | VNDK | vendor |
|---|---|---|---|---|
| 27 | Android 8.1 | | 31 | Android 12.0 |
| 28 | Android 9 | | 32 | Android 12.1 |
| 29 | Android 10 | | 33 | Android 13 |
| 30 | Android 11 | | 34 | Android 14 |

linkerconfig looks the snapshot up by the vendor's exact `ro.vndk.version` (a LineageOS 20
vendor built with `BOARD_VNDK_VERSION := current` reports 33, and v34 cannot stand in
for it). A15+ vendors have no `ro.vndk.version` and need no snapshot (architecture.md).
The 32-bit `halium_arm` GSI carried 30, 32 and 34 in its first 16.0 build (`20260827-1`,
below); the current `20261007-1` carries v27 to v34 (the mindphone recipe). Snapshots install to
`/system/system_ext/apex/com.android.vndk.v<N>`; check a candidate GSI with
`debugfs -R "ls /system_ext/apex" system.img`.

## Building a 32-bit `halium_arm` GSI

Needed for devices with 32-bit stock userland (mindphone: MT6739, 64-bit SoC running a 32-bit 4.14 kernel + 32-bit userland, `bootopt=64S3,32S1,32S1`).

A 32-bit-specific fix (in `device/halium/halium_arm`, not arm64): `init.halium.rc` preloaded `libselinux_stubs` from hardcoded `/system/lib64/` → vndservicemanager dead on 32-bit.

### Halium 11 (the easy one — 16 minutes)

In the 11.0 tree, create `device/halium/halium_arm` cloned from `halium_arm64` with:

- board include `generic_arm_ab` instead of `generic_arm64_ab`
- no `core_64_bit.mk` inherit (zygote32 via core_minimal)
- `TARGET_USES_64_BIT_BINDER := true` **kept** — that's the binder *wire* ABI, mandatory for API≥28 (the stock kernel has no `BINDER_IPC_32BIT` either)

`lunch lineage_halium_arm-userdebug && m systemimage` → verified ELF32, no lib64. Packaged as `halium-luneos-11.0-20260826-1-halium_arm.tar.bz2`.

### Halium 16 (three edits — 17m51s first full build)

Built and verified in the 16.0 tree: system.img genuinely 32-bit-primary (vold ELF 32-bit ARM, zero `system/lib64`, 541 32-bit libs), containing `com.android.vndk.v30.apex` (48 MB) beside v32/v34 — so an Android-11 vendor is served. Runtime-proven: mindphone boots it on hardware over its Android 11 (VNDK 30) vendor (device-mindphone.md). The exact three edits:

1. `device/halium/halium_arm` cloned from `halium_arm64`: BoardConfig includes `build/make/target/board/generic/BoardConfig.mk` (pure arm, armv7-a-neon, no `TARGET_2ND_ARCH`) — the ready-made `generic_arm_ab` board was **removed in 13/14**; `lineage_halium_arm.mk` drops the `core_64_bit.mk` inherit (mirror `aosp_arm.mk`); do **NOT** set `TARGET_USES_64_BIT_BINDER` (default-true + deprecated in 16).
2. `cp -al <14.0 tree>/prebuilts/vndk/v30` into the 16.0 tree; `device.mk`: `PRODUCT_EXTRA_VNDK_VERSIONS := 30 32 34`.
3. **The non-obvious one:** `packages/modules/vndk/apex/Android.bp` only declares `apex_vndk` blocks for v31–v34 — add a v30 `apex_vndk` block, or the `com.android.vndk.v30` module never exists and the package is *silently dropped* (`BUILD_BROKEN_MISSING_REQUIRED_MODULES`). This is NOT a soong API floor (`MinSupportedSdkVersion=21`, so 30 passes vndk.go's gate).

Lunch note: Android 16's lunch wants product-release-variant and this tree's lunch doesn't split it — build with explicit env instead:

```
TARGET_PRODUCT=lineage_halium_arm TARGET_RELEASE=bp4a TARGET_BUILD_VARIANT=userdebug m systemimage
```

Residual risk was whether every Halium `PRODUCT_PACKAGES` entry links 32-bit — cleared: every entry linked, core daemons (init/apexd/servicemanager) build fine. Packaged as `halium-luneos-16.0-20260827-1-halium_arm.tar.bz2` (sha256 `32da7606...2e6c`).

## arm32 GSI feasibility per generation

| Halium | arm32 feasible? | What it takes |
|---|---|---|
| 11.0 | ✅ trivial | clone device dir, `generic_arm_ab` board |
| 13.0 | ✅ | identical state to 14 — no easier, so prefer 14 |
| 14.0 | ✅ | board/product recreation only (`generic_arm_ab` gone → use `board/generic`); VNDK is NOT dismantled in 14 (that's Android 15), `prebuilts/vndk/v30` is synced, HIDL fully present (hwservicemanager, hidl-gen, composer@2.1), `aosp_arm.mk` still ships |
| 16.0 | ✅ with v30 port | the 16 tree DOES ship `aosp_arm.mk` (32-bit-primary) and `board/generic`; HIDL works on 16 (sargo proves it). The ONLY real blocker is VNDK: 16 ships prebuilts/vndk v31–v34 only, and the halium_arm64 device.mk at the time said outright "Android 11 vendors cannot be served from a 16 GSI". Solved: v30 snapshot exists in the 13.0 AND 14.0 trees (729 MB, standard Android.bp), VNDK snapshots are AOSP-version-tied and forward-consumed — copy it in and add 30 to `PRODUCT_EXTRA_VNDK_VERSIONS` (+ the apex_vndk block, edit 3 above) |

Why sargo worked on 16 without any of this: its vendor is 12.1 (v32, already shipped); mindphone's vendor-11 needed the v30 port.

## Packaging and wiring into Yocto

Package the built `system.img` as `halium-luneos-<ver>-<date>-N-<product>.tar.bz2`, publish it as a `webOS-ports/halium-images` release, and bump `HALIUM_LUNEOS_GSI16_PV`/`_SHA256` in `halium-luneos-gsi-16.inc` (every machine moves together; a device that must stay behind overrides the weak assignments in its own recipe, as mindphone does for `halium_arm`). The `.inc` does the sparse→ext4 conversion + `/android/{system,vendor,data,...}` symlinks and consumes `${UNPACKDIR}/system.img` in place (`mv` → `simg2img` → `rm`) — note modern trees use `${UNPACKDIR}`, not `${WORKDIR}`. The image installs as `android-rootfs.img` (system-as-root mode of the initramfs).

Selecting between a GSI and an old device build per machine: device-bringup-yocto.md § android-system-image recipes.

There is no standalone GSI artifact the installer picks per device; each machine gets the GSI through an `android-system-image-<device>` recipe in the image. With the 16.0 GSI carrying VNDK 27–34, one GSI per architecture would cover every current vendor.

When a machine moves to a newer GSI generation, its android-headers move with it: device-bringup-yocto.md § What a machine conf contains.

## Do not adopt Droidian's `android-system-gsi-*-bin`

They do not build GSIs: they re-host UBports Jenkins artifacts pinned to a job number, and every URL for the versions that matter is dead (halium-14.0 job 460 and halium-13.0 job 517 both 404; `ci.droidian.org`, which the 10/11/12 packages use, no longer resolves). Their `download.sh` has signature verification commented out — an unverified `curl` into the rootfs. LuneOS's own releases plus Yocto `SRC_URI` checksums are strictly better. Their upstream — the UBports `jenkins-ci/generic_arm64` job — remains the right *reference* for building newer GSIs.

Also do not rely on `mirrors.lolinet.com/firmware/halium/GSI` — not updated since 2020.

## Legacy devices: a vendor.img for the 16.0 GSI

Every device runs the 16.0 GSI, including those with no Treble vendor of their own. For them
the vendor half is converted into a Treble-shaped `vendor.img` at build time and shipped next to
the GSI; the headers follow the GSI (16.0), not the vendor.

- **Pre-Treble Halium 9 builds** (hammerhead, mako, tenderloin): one monolithic `system.img`
  with the vendor payload under `/system/vendor`, plus vendor pieces scattered over the rest of
  the image. `halium-legacy-vendor.bbclass` (meta-android, with `lib/halium/legacy_vendor.py`)
  moves into the new image the HAL modules left in `/system/lib/hw`, the Qualcomm/display
  libraries the vendor links against, the daemons the device init starts from `/system/bin`,
  and the device init and ueventd scripts (to `/vendor/etc/init/hw/` and
  `/vendor/etc/ueventd.rc`, which Android 16 init reads). It works through `debugfs`, so the
  build stays unprivileged, takes the LLNDK list from the GSI rather than a hand-written one,
  and reports what it cannot resolve instead of guessing.
- **Vendors built from an old LineageOS tree** (a3-2015-halium from LineageOS 18.1 / VNDK 30,
  goyavewifi from LineageOS 16.0 / VNDK 28, sm-t520) go through the same class via
  `android-system-image-legacy-gsi.inc`.
- **Android 9 vendors from `m vendorimage`** (tissot, mido): a real `vendor.img` already
  exists and is paired with the GSI directly.

The per-device knobs (`HALIUM_LEGACY_*` in the class) cover the VNDK level the old vendor links
against (`HALIUM_LEGACY_VNDK`, default 28 — the GSI must carry that snapshot), which init files
to carry and which services or commands to drop (a container must not start `charger`, remount
what the host mounted or touch the host's USB gadget), dlopen()ed libraries, HALs to declare
hwbinder rather than passthrough (composer and allocator by default), and `/system/build.prop`
tuning to carry into the vendor's build.prop. The machine conf chooses the Android it boots
with `<DEVICE>_ANDROID_SYSTEM` (`"gsi"` or `"device"`).

### Before deriving: read what the old Android did for its vendor

The class closes over `DT_NEEDED` **by name**, from the vendor, the VNDK/LLNDK and the old
`/system/lib`. Four things it does not find on its own; each cost a test round on bullhead
(LineageOS 21 vendor, device-bullhead.md). Check them on every LineageOS-derived vendor before the
first derive (item 5 is a fifth that every legacy vendor with framework copies needs, found on four
devices):

1. **LineageOS's linker shims.** LineageOS builds `TARGET_LD_SHIM_LIBS` into its own linker, which
   loads a shim next to the library that needs it; the GSI's linker does not. Read the map out of the
   device image's linker (in the runtime APEX from LineageOS 17 on, `/system/bin/linker64` before):
   ```sh
   debugfs -R 'dump /system/apex/com.android.runtime.apex rt.apex' system.img
   unzip -o rt.apex apex_payload.img
   debugfs -R 'dump /bin/linker64 linker64' apex_payload.img     # and /bin/linker for 32-bit
   strings -n 6 linker64 | grep '\.so|'
   ```
   It prints `<library>|<shim>:<library>|<shim>:…`. Each pair goes into `HALIUM_LEGACY_LD_SHIMS`
   (file names). Both ends must be in the vendor image, so shims that live in `/system/lib*` (bullhead:
   `libaudioclient_shim.so`, `libshim_sensor.so`, `libshim_drm.so`) also go into
   `HALIUM_LEGACY_EXTRA_LIBS`. Without them the blobs fail to link: `cannot locate symbol
   "strdup8to16"` (ATFWD-daemon, libcne), `"android::AudioSystem::setErrorCallback"` (the RIL).
2. **Passthrough HALs that LuneOS reaches over hwbinder.** `grep -B1 -A2 passthrough
   vendor/etc/vintf/manifest.xml`. A LineageOS vendor often declares sensors, Bluetooth, the camera
   provider, vibrator, … passthrough and ships no service: its system_server, Bluetooth app or
   cameraserver loaded them in-process. sensorfw, bluebinder and droidmedia only talk hwbinder. For
   each one a LuneOS consumer needs, ship a service binary (AOSP
   `hardware/interfaces/<hal>/<version>/default`, built for the vendor's VNDK level, or one from
   another of our builds), an rc, and list the HAL in `HALIUM_LEGACY_BINDERIZED_HALS`. Without the
   manifest change the service starts and exits at once: "Service … must be in VINTF manifest in
   order to register/get".
3. **Symbols, not just names.** A vendor built without VNDK (LineageOS 21, `RELEASE_DEPRECATE_VNDK`)
   carries its own `libbinder.so`, `libutils.so`, … and the GSI's linkerconfig gives it the LLNDK only.
   A blob linked against the **system** variant of such a library then fails on a symbol although the
   name resolves: the camera HAL's `libgui.so` and the RIL's `libmediautils.so` want
   `PermissionCache`/`checkCallingPermission`, which only the system build of libbinder has. Walk each
   daemon's whole load tree and check every undefined symbol (tools.md § fullres.py), not only
   `DT_NEEDED`.
4. **Libraries that moved into an APEX.** From LineageOS 17 on ICU (`libicu.so`, `libicuuc.so`,
   `libicui18n.so`, `libandroidicu.so`) lives in the i18n APEX, not `/system/lib`, so the closure
   finds nothing for a blob that needs it (bullhead: `libharfbuzz_ng.so` under `mm-qcamera-daemon`,
   `library "libicu.so" not found`). Take them from the old image's `com.android.i18n` APEX payload.
5. **`libft2.so`: named by the LLNDK list, not handed to the vendor.** The class counts every name on
   the GSI's LLNDK list as provided, and `libft2.so` is on it, but the vendor's linker namespace in
   the container does not give it to a vendor library, so a name-based closure (and fullres.py with
   the LLNDK directory in its path) says "all resolved" while the load fails. It is reached through the
   framework copies a legacy vendor drags into `/vendor/lib`: `libhwui.so` (a3-2015, sm-t520,
   tenderloin) or `libpdfium.so` (goyavewifi: `gralloc.sc8830.so` -> `libdither.so` ->
   `libandroid_runtime.so` -> `libpdfium.so`). The symptom is a HAL service that exits with status 1
   at every start and writes **nothing** to the kernel log or the journal; only the container's logcat
   has it (debugging.md § 2.4):
   ```
   vndksupport: Could not load /vendor/lib/hw/gralloc.sc8830.so from default namespace: dlopen failed:
     library "libft2.so" not found: needed by /vendor/lib/libpdfium.so
   AllocatorHal: failed to get gralloc module
   ComposerHal: failed to open hwcomposer device
   ```
   Since halium-legacy-vendor revision 32 the converter does this itself: `libft2.so` is no longer counted as
   provided, so anything that needs it pulls the old `/system/lib` copy (~600 KB) and `HALIUM_LEGACY_EXTRA_LIBS`
   need not name it. On an older converter the rule is: **if the vendor image has `lib/libhwui.so` or
   `lib/libpdfium.so`, set `HALIUM_LEGACY_EXTRA_LIBS = "libft2.so"`**. Check it before
   the first boot: `for f in vendor/lib/*.so; do readelf -d $f | grep -q 'NEEDED.*libft2' && echo $f; done`
   lists who wants it (the result is `libhwui.so`, `libpdfium.so`, or both).
   The same fix as the framework-symbol shims in item 3 usually goes with it for the same libraries
   (`HALIUM_LEGACY_SHIM_TARGETS`, hal-userspace.md § Display: three gaps).

For 3 and 4 the fix belongs to the daemon that needs it: putting LineageOS's system libbinder into
`/vendor/lib*` would replace it for every vendor process. Give that daemon a private directory and
`setenv LD_LIBRARY_PATH` in an rc `override` (device-bringup-yocto.md § Shipping fixes through
/odm).

A converted image can be published next to the GSI as `<machine>-vendor.img` in the same
`halium-images` release; a recipe that sets `HALIUM_LEGACY_VENDOR_SHA256` then fetches it as is
instead of deriving it (sm-t520 does). Such a device must use the GSI unmodified, or the GSI it
gets is not the one the image was made against.

## GSI-side fixes for legacy vendors

- `system/linkerconfig` (branch luneos/sphal-vndk-legacy): let sphal link libbinder.so and libui.so from
  the VNDK APEX for VNDK 28 and 30 vendors (gralloc via libqdutils; see hal-userspace.md).
- `vendor/halium/droidmedia` minimedia.cpp: `configureRpcThreadpool(5, false)` — without it a HAL1
  takePicture() deadlocks minimediaservice against the HAL.
- Both are in the halium_arm GSI `halium-luneos-16.0-20261008-3`, published in the `halium-luneos-20261005`
  release. Rebuilding after a linkerconfig-only change takes ~20 s; check that
  `variableloader.cc` was recompiled (it is installed into the runtime APEX, not /system/bin).
