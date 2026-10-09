# Device: sm-t220 (Samsung Galaxy Tab A7 Lite Wi-Fi) — MediaTek Tier 1 behind a Samsung bootloader

Samsung Galaxy Tab A7 Lite Wi-Fi (`sm-t220`), MediaTek MT8768T, Tier B on its stock Android 12 vendor and Halium 16 GSI: boots LuneOS with audio, media and app installs.

A MediaTek MT8768T (platform `mt6765`) tablet running the stock Android 12 vendor
and its 4.19.191 kernel interface under the generic Halium 16 GSI, modelled on
`radon`. It boots LuneOS, with speaker audio, HTML5 media (the Testr app) and app
installs through appinstalld2 all confirmed on the device. What makes it worth
reading is not the SoC but the chain of faults that all looked like "no sound":
the causes were a kernel syscall, a vendor library's allocator assumption, a
resource table and a scheduler limit, and none of them is visible in a mixer.
Layer `meta-smartphone/meta-samsung`, `MACHINE=sm-t220`. Status file in the layer:
`meta-samsung/conf/machine/sm-t220-STATUS.md`.

## Platform facts (read from the firmware and the running tablet)

| Fact | Value |
|---|---|
| SoC / platform | MT8768T, `mt6765`; PowerVR GPU behind MediaTek's "meow" EGL wrapper (`ro.hardware.egl=mtk` works) |
| Kernel | `gta7lite/android_kernel_samsung_ot8`, branch `halium-12` (Samsung's 4.19.191 drop plus one Halium config commit), Google Clang r416183b, `gta7litewifi_defconfig` + `halium.config` + `luneos.cfg` |
| Vendor | Android 12, VNDK 31, `ro.product.vendor.device=gta7litewifi` (so the adaptation directory is `gta7litewifi`, not `sm-t220`) |
| Boot image | header v2, page 2048, kernel `0x40080000`, ramdisk `0x51b00000`, tags/dtb `0x47880000`; cmdline `bootopt=64S3,32N2,64N2 printk.devkmsg=on`; dtb section must be an Android `dt_table` (magic `0xd7b7ab1e`) wrapping `mt6765.dtb` — this lk does not parse a bare FDT |
| Partitions (single slot eMMC) | boot `mmcblk0p38` (32 MiB), recovery p39, dtbo p13, vbmeta p14, super p45, userdata p51 |
| Panel | 800x1340, driver-reported 107 x 172 mm (196 ppi, not ruler-checked) |
| Codec | MT6357 PMIC codec (`mtk-soc-codec-6357.c`; the `mt6358` directory next to it is not the one built) |
| Speaker amps | two Awinic AW87xxx class-K PAs on i2c bus 3 (0x58, 0x59, chip id 0x59), fed from the codec line-out |
| Keys | Vol Up on `mtk-kpd`, Vol Down and Power on `mtk-pmic-keys`, headset jack as a `mt-snd-card Headset Jack` input (jack detect works) |
| Sensors | grip (SAR) sensors only; the sensors HAL answers sensorfw's proximity request with "invalid sensor type: 8" |
| USB in LuneOS | the tablet does not enumerate on USB once LuneOS runs (no gadget configured), so debug over Wi-Fi ssh |

## The Samsung lk: Odin only

- There is no usable `fastboot flash`: the Samsung lk's fastboot answers
  "not allowed in locked state" and has no flash/erase commands. Flashing goes
  through Odin (Thor) in Download mode.
- Download mode by key: hold Vol Up + Vol Down while plugging in USB, then
  long-press Vol Up at the warning screen to unlock. `adb reboot download` on the
  stock Android goes straight to "Downloading...".
- Developer options → OEM unlocking, then the long-press, gives the orange
  state and sets the Knox warranty bit.
- vbmeta: an unsigned header with `AVB_VBMETA_IMAGE_FLAGS_VERIFICATION_DISABLED`
  (flags=2 at offset 120, padded to 4096) is what lets the unlocked lk boot a
  non-Samsung image.
- The screen's "SW REV CHECK FAIL: [userdata]" (fused 6 > binary 0) is shown but
  the flash proceeds. It is not the failure to chase.
- **Odin's userdata write left holes in the rootfs image on this tablet** (proven
  to happen at flash time, content-specific, not zero runs, not decompression, not
  the initramfs resize). Everything else flashed fine. The working route is TWRP
  plus `adb push` (see `installing`).
- odin4 for Linux: the release has a bug that fails multi-part sequences with
  "expected 30 got 0"; it is fixed on `main` (commit e916c1e), so build it from
  source. Use `TMPDIR` on a real disk (`/tmp` is a small tmpfs and the temporary
  decompressed image does not fit), one fresh Download session per run, and put a
  newline before the md5 trailer line of the `.tar.md5` (odin4 hashes up to the
  previous newline; Samsung's Odin reads the line directly; a newline satisfies
  both).

## What was broken, in the order it was found

### 1. Boot loop about 57 s in: Samsung stubs out the raw HCI socket

Symptom: the "Failed to boot" panic, then a reset every 77 s (preloader `0e8d:2000`
re-enumerating). Cause: Samsung comments out almost all of
`net/bluetooth/hci_sock.c` and reduces `hci_sock_create()` to `return 0`. Android
never opens an HCI socket; bluebinder does, `bt_sock_create()` then calls
`bt_sock_reclassify_lock(NULL)` and `BUG_ON(!sk)` fires; MediaTek's
`ipanic_die()` / mrdump resets the device. Evidence came from the ramoops console
(`/sys/fs/pstore/console-ramoops-0`, readable in TWRP right after a looping boot).
`net/bluetooth/` differs from v4.19.191 in that one file only, so the fix is to
make it identical again. Check any Samsung/MTK vendor tree for the same stub
before blaming the kernel config.

### 2. PulseAudio killed with no trace: RLIMIT_RTTIME

PulseAudio started completely, loaded `module-droid-card`, and was gone about a
second later: `Main process exited, code=killed, status=9/KILL`, no core, no log
line. `pulseaudio` arms `RLIMIT_RTTIME` (200 ms) when it enables real-time
scheduling; the droid sink threads run `SCHED_RR` and a write into the MediaTek
HAL can run longer than that without sleeping, so the scheduler tick sends SIGKILL
from interrupt context. It was found with the kernel's `signal_generate`
tracepoint filtered to `sig==9`: the sender was the `droid-sink-deep` thread
itself, in hard-IRQ context. Fix: `rlimit-rttime = -1` in
`/etc/pulse/daemon.conf.d/`, which keeps real-time scheduling.

### 3. The speakers: a vendor library that assumes zeroed `malloc`

With PulseAudio stable there was still no sound, while headphones worked (a
direct `aplay` to `hw:0,0` with only `Audio_Amp_L/R` on was audible there).
Everything a mixer can set was tried and was silent on the speakers: amps on,
`Music` profile, `Ext_Speaker_Amp_Switch`, `Speaker_Amp_Switch`, line-out gain,
`I2S0DL1`, with the jack verified empty. The mixer state during real HAL playback
was identical to the manual setup except that the HAL never selected the Awinic
path, which pointed at the HAL's own decision, not at the hardware.

That decision is `AudioALSAHardwareResourceManager::setNonSmartPAType()`, which
reads the feature option `MTK_AUDIO_SPEAKER_PATH` and maps `int_spk_amp` → 0
(internal amp, `speaker_output` only), `int_lo_buf` → 1, `int_hp_buf` → 2 (the
`aw_speaker_*` / Awinic path), `2_in_1_spk` → 3, `3_in_1_spk` → 4. The vendor
`AudioParamOptions.xml` says `int_hp_buf`, but the HAL logged
`MTK_AUDIO_NUMBER_OF_MIC undefined in AudioParamOptions` and used type 0, i.e. it
never read the file. `strace -f -e trace=openat,newfstatat` on a copy of the
PulseAudio process showed why:

    newfstatat(".../\264\254\213\233U/vendor/etc/audio_param_huaqin/NA/AudioParamOptions.xml") = -1 ENOENT

Five stale bytes in front of the path. `libaudio_param_parser-vnd.so`
`appGetXmlDirFromProperty()` does `buf = malloc(512)` and then `strcat(buf, path)`
without clearing `buf` (it also `property_set`s the corrupted value, which is
where `persist.vendor.audio.tuning.def_path = "wڞU/vendor/..."` came from).
Bionic's allocator returns zeroed memory for a fresh block, glibc's under
libhybris does not. Setting the property by hand does nothing (the HAL rebuilds the
path itself), and `MALLOC_PERTURB_=255` does nothing either because glibc's
thread cache returns blocks without applying it; adding
`GLIBC_TUNABLES=glibc.malloc.tcache_count=0` made `module-droid-card` fail to
load. What works is changing that one allocation to `calloc(512, 1)` in a copy of
the vendor library and bind-mounting it over the original at boot, before
PulseAudio starts: `mov w1,#1` / `nop` / `bl calloc@plt` replacing the
`ldr`/`stur`/`bl malloc` sequence, and a `nop` over the stack-protector check
that no longer has a canary to compare. The layer does this at runtime on the
device's own library, checks every instruction word it changes and does nothing
on a different build, so no vendor binary is redistributed. See
`hal-userspace` for the general lesson.

The other rejected idea is worth recording because it looked right: the 32-bit
`awinic.audio.effect.so` that the HAL fails to `dlopen` ("is 32-bit instead of
64-bit") is Awinic's software speaker-protection DSP (the `aw_piano_*` symbols),
not the code that switches the amplifiers on.

### 4. `pulseaudio-modules-droid-hidl` without its helper

`module-droid-hidl` spawns `/usr/libexec/audiosystem-passthrough/audiosystem-passthrough`,
but the recipe only had a build-time `DEPENDS` on it, so the image carried the
module without the binary ("helper disappeared"). Check the *runtime* dependency
whenever a module execs a helper.

### 5. Nothing plays through the webOS media server (found with Testr)

Testr's HTML5 audio test was silent although PulseAudio and the speakers were
fine, and no stream ever reached PulseAudio. Three layers:

- **Kernel.** `umediaserver` logged `waitid(pid:N, pidfd=M) failed: Invalid
  argument (22)` and `Pooled process N exited with status -1`. GLib (≥ 2.74)
  commits to its pidfd child watch as soon as `pidfd_open()` succeeds; this tree
  (Android's 4.19 backport) has `pidfd_open()` but not the 5.4 half,
  `waitid(P_PIDFD)`, so every reap failed. Same fix as athena and mindphone: the
  backport in the shr-distribution/linux fork. The follow-up they need on 4.14
  ("do not require a zeroed `*parent_tidptr`" for `CLONE_PIDFD`) is not needed on
  a tree whose `copy_process()` has no such check — read the code before copying
  a fix list.
- **Config.** After that the pipelines still failed: `strace -f -p <umediaserver>`
  showed `execve("/usr/sbin/reference-media-pipeline") = -1 ENOENT`. The shared
  `umediaserver-configs` names that binary; the tree ships
  `/usr/sbin/g-media-pipeline` and nothing provides the other name. This is
  **not device-specific** (hammerhead and q25 behave the same).
- **Resources.** With the right binary a plain WAV makes `g-media-pipeline` ask
  for `1 ADEC` and `8 VDEC` against a table of 2 each: `POLCAND_FIND_ERR no
  suitable candidate found`, then `MEDIA_ERROR_FORMAT` in the page. The counts
  are abstract units; VDEC 16 / ADEC 8 lets two players run. Those numbers are a
  judgement, not a measurement.

Gotcha for testing: the player is created when the page loads, so a failed load
leaves it in an error state and pressing play later logs nothing. Close and
relaunch the app (`luna-send -n 1 luna://com.webos.service.applicationmanager/launch`)
with the trace already running.

### 6. `stp_dump3` at 93% CPU

MediaTek's connectivity core-dump collector was started by
`start-android-hals.sh`, which starts every service init left stopped, including
services marked `disabled`. It sat at about 93% CPU in `top` (56 CPU-minutes
accumulated in one reading) beside a load average around 26. Do not blame it for
slow file copies: an ssh copy stayed under 1 MiB/s with it stopped, the Wi-Fi path
being the limit. The telling log line is
`init: Processed ctl.start for 'stp_dump' from pid: 0`. Fix:
`deviceinfo_android_skip_services="stp_dump"`, plus a `prop.halium` with
`persist.vendor.connsys.coredump.mode=0` (and the AEE dump properties) bind-mounted
over the GSI's empty `/system/etc/prop.halium` — the mechanism FuriOS' adaptations
use.

### 7. appinstalld2 cannot install anything on the standard image

`appinstalld2` unpacks an IPK by running `ar`, and the standard image has none
(busybox is built without the applet; `binutils` is only in the developer
package group): `Failed to execute child process "ar"`. After that, its separate
package database under `/media/cryptofs/apps` cannot see system packages, so an
IPK with `Depends: cordova` fails with `nothing provides cordova` — repack the
control file without `Depends:` for such a test. A hand-run
`opkg install` of the same IPK succeeds into the system root, which is misleading:
the installer does not use that database.

## Deploying to this tablet

- Boot partition: from a running LuneOS, `dd` the `Image.gz.fastboot` straight to
  `/dev/mmcblk0p38` and read it back to compare checksums; no Download mode
  needed. Keep a copy of the previous partition.
- Rootfs: boot TWRP (Vol Up + Power), `adb push` the `rootfs.ext4` to
  `/data/rootfs.img.new` (about 79 MB/s over USB; over Wi-Fi ssh the same file
  runs at about 0.6 MiB/s), compare checksums, then rename the old file to
  `rootfs.img.prev` and the new one to `rootfs.img`. Always `adb -s <serial>`:
  another tablet is usually plugged in too.
- The package's `android-kernel-bootimg` post-install writes the boot image to
  the partition, so an `opkg` install of it re-flashes the same kernel.

## Open items

Panel size not ruler-checked; GPS, Bluetooth, suspend/resume and charging
behaviour not verified; `luneos.cfg` is a first pass (28 options differ from
Samsung's defconfig); the backlight node for the initramfs `machine.conf` is not
set; the proximity sensor is probably absent on the Wi-Fi model but that is not
checked against the spec sheet.
