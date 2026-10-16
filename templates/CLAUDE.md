# LuneOS project context

This project works on LuneOS (webOS) ports for Android devices via Halium GSI/GKI.

The `luneos-mcp` server holds the porting knowledge base. At the start of a
session read `luneos://knowledge/architecture` (the overview, device index and
glossary), then pull only what the task needs:

- `luneos_search` for a symptom, config option, file name or tool;
- `luneos_get_topic` for a whole topic (`luneos_list_topics` lists them);
- the matching `device-<codename>` topic when working on a known device.

`luneos://knowledge/all` concatenates everything (well over 100k tokens); load it
only when a task really spans the whole base.

Ground rules from the knowledge base that always apply:

- Match the GSI to the device's **vendor API level** (`ro.vndk.version`, or
  `ro.vendor.build.version.sdk` — `ro.board.api_level` is a YYYYMM date on
  Android 15+ vendors), never to the Android version it currently runs.
- Every device runs the **16.0 GSI** (`halium_arm64` or 32-bit `halium_arm`);
  legacy devices get their vendor bits converted into a `vendor.img` it can consume.
- `android-headers` versions track **the GSI, not the vendor**.
- Derive device configuration at runtime where possible; shipped config files
  are placeholders, not defaults.
- Verify KMI compatibility host-side (`kmi-crc-check.py`) **before** flashing
  any rebuilt kernel; the KMI-poison list is per KMI and tree, never copied.
- Respect anti-rollback: never flash a factory build older than the one on the
  device.
- When a device does not come up, follow `luneos://knowledge/debugging` stage
  by stage and collect evidence before changing anything.
