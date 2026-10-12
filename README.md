# luneos-mcp

MCP (Model Context Protocol) server packaging the knowledge gained porting
LuneOS to modern Android devices via Halium GSIs and GKI kernels — kernel
porting, boot-image construction, Yocto/meta-smartphone device bring-up,
nyx-modules configuration, GSI building, installation, and a staged
"device doesn't come up" debugging playbook.

Modelled on [webOSArchive/webos-mcp](https://github.com/webOSArchive/webos-mcp),
but for LuneOS device porting rather than legacy webOS app development.

The knowledge was distilled from real ports and bring-ups: Pixels on GKI
(bluejay, panther) and pre-GKI kernels (sargo, sunfish, bramble), MediaTek phones
and tablets (mindphone, q25, mp01, radon, titanpocket, sm-t220), and Qualcomm
Tier B devices from 2015 to 2020 (a3-2015-halium, goyavewifi, bullhead, athena, fajita, surya). The
device index in `architecture` lists each with its tier, kernel, vendor, GSI and
status; every device has its own `device-<codename>` topic. Material from the
UBports, Droidian and Sailfish OS (HADK) porting guides is integrated where it
transfers to the LuneOS stack, and flagged where it conflicts.

## Install

```sh
git clone https://github.com/webOS-ports/luneos-porting-mcp.git
cd luneos-porting-mcp
npm install

# For Claude Code, user scope:
claude mcp add luneos-mcp -s user -- node "$PWD/index.js"

# Or per-project:
claude mcp add luneos-mcp -s project -- node "$PWD/index.js"
```

(Once published to npm: `claude mcp add luneos-mcp -s user -- npx -y luneos-mcp@latest`.)

Requires Node.js 18+.

To point Claude at the knowledge base in a porting project, copy
`templates/CLAUDE.md` into the project (or merge its contents into an existing
`CLAUDE.md`).

## What it exposes

### Resources

| URI | Content |
|---|---|
| `luneos://knowledge/all` | every topic concatenated — very large; prefer `architecture` + search |
| `luneos://knowledge/<topic>` | one topic file |

Topics (auto-discovered from `knowledge/*.md`):

| Topic | Covers |
|---|---|
| `architecture` | the GSI+GKI model, Tier A/B and Tier 0/1/2, GSI↔vendor matching, device index, glossary |
| `kernel-porting` | the kernel method: config delta, fragment traps, Tier A ACK builds, Tier B vendor trees, the command line |
| `kmi-crc-matching` | whether a vendor `.ko` loads into your kernel: vermagic, CRCs, poison options per KMI, struct layouts, force-loading, shipping your own modules |
| `boot-images` | header layouts, the kernel/ramdisk window, per-layout repack recipes, initramfs init patches, AVB, debug images |
| `installing` | flash kits, vbmeta flags, flash steps per layout, SP Flash Tool / lk2nd / Odin routes, anti-rollback |
| `gsi-building` | building Halium GSIs (arm64 and 32-bit arm), published releases, VNDK snapshot matrix |
| `device-bringup-yocto` | meta-smartphone layers, machine confs, GKI boot-image recipes, bitbake traps, mount-android/LXC |
| `nyx-modules` | nyx module selection and runtime-derived nyx.conf, time ownership |
| `hal-userspace` | libhybris/libgbinder stack by subsystem: graphics, gbinder ApiLevel, MTK connectivity, audio, modem, BT, sensors |
| `debugging` | staged "device doesn't come up" playbook, debug channels, symptom → cause table |
| `tools` | kmi-crc-check, symvers-drift, module-order, mer-kernel-check, mtkclient, … |
| `deviceinfo-reference` | the UBports/HGABT `deviceinfo` variables our Tier 1 format reuses |
| `device-<codename>` | per-device reference: status, platform facts, kernel, boot image, vendor/GSI, Yocto, install, open issues |

### Tools

- `luneos_list_topics` — list topics with descriptions
- `luneos_get_topic` — fetch one topic's markdown
- `luneos_search` — keyword search across the whole knowledge base
  (symptoms, config options, file names)

### Prompts

- `luneos-session-start` — orient a session on the knowledge base
- `luneos-port-device` — guided porting workflow for a new device
- `luneos-debug-boot` — staged triage for a device that does not come up

## Updating the knowledge

Each file in `knowledge/` is one topic; the first `# heading` is its title and
the first paragraph its description, so keep that paragraph to one sentence of
at most ~200 characters and put the rest in a second paragraph. A correction
replaces the wrong text in place rather than being appended next to it. Each
fact has one home; elsewhere, link to it (`kmi-crc-matching.md § Struct layouts`).
Device files follow a common shape (see any `device-*.md`). Add or edit files
and the server picks them up on the next request — no restart or re-registration needed.

## License

Apache-2.0
