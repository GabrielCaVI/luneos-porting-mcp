#!/usr/bin/env node
// luneos-mcp — MCP server exposing the LuneOS GSI/GKI porting & debugging
// knowledge base (modelled on webOSArchive/webos-mcp).
//
// Resources:  luneos://knowledge/<topic>   one markdown topic file
//             luneos://knowledge/all       every topic concatenated
// Tools:      luneos_list_topics, luneos_get_topic, luneos_search
// Prompts:    luneos-session-start, luneos-port-device, luneos-debug-boot

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KNOWLEDGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "knowledge");

// ---------------------------------------------------------------------------
// Knowledge base discovery
// ---------------------------------------------------------------------------

function loadTopics() {
  const topics = new Map();
  let entries = [];
  try {
    entries = readdirSync(KNOWLEDGE_DIR).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return topics;
  }
  for (const file of entries) {
    const name = file.replace(/\.md$/, "");
    let content = "";
    try {
      content = readFileSync(join(KNOWLEDGE_DIR, file), "utf8");
    } catch {
      continue;
    }
    // Title = first heading; description = first non-empty paragraph after it.
    const lines = content.split("\n");
    const title = (lines.find((l) => l.startsWith("# ")) || `# ${name}`).replace(/^#\s*/, "");
    // A paragraph may be hard-wrapped: join its lines up to the next blank line.
    const para = [];
    let pastTitle = false;
    for (const line of lines) {
      if (!pastTitle) { pastTitle = line.startsWith("# "); continue; }
      if (!line.trim()) { if (para.length) break; continue; }
      if (line.startsWith("#") && !para.length) continue;
      para.push(line.trim());
    }
    const description = para.join(" ");
    topics.set(name, { name, file, title, description, content });
  }
  return topics;
}

function allTopicsConcatenated(topics) {
  const parts = [];
  for (const t of topics.values()) {
    parts.push(`<!-- ===== luneos://knowledge/${t.name} ===== -->\n\n${t.content.trim()}\n`);
  }
  return parts.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "luneos-mcp", version: "1.0.0" },
  { capabilities: { resources: {}, tools: {}, prompts: {} } }
);

// ----- Resources -----------------------------------------------------------

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const topics = loadTopics();
  const resources = [
    {
      uri: "luneos://knowledge/all",
      name: "All LuneOS porting knowledge",
      description:
        "Every LuneOS GSI/GKI porting, bring-up and debugging topic concatenated (very large). " +
        "Prefer luneos://knowledge/architecture plus luneos_search / individual topics.",
      mimeType: "text/markdown",
    },
  ];
  for (const t of topics.values()) {
    resources.push({
      uri: `luneos://knowledge/${t.name}`,
      name: t.title,
      description: t.description,
      mimeType: "text/markdown",
    });
  }
  return { resources };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  const m = /^luneos:\/\/knowledge\/(.+)$/.exec(uri);
  if (!m) throw new Error(`Unknown resource URI: ${uri}`);
  const topics = loadTopics();
  const text =
    m[1] === "all" ? allTopicsConcatenated(topics) : topics.get(m[1])?.content;
  if (text === undefined) {
    const known = [...topics.keys()].join(", ");
    throw new Error(`Unknown topic "${m[1]}". Known topics: ${known}`);
  }
  return { contents: [{ uri, mimeType: "text/markdown", text }] };
});

// ----- Tools ---------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "luneos_list_topics",
      description:
        "List all LuneOS knowledge-base topics with a one-line description of each. " +
        "Use this first to see what porting/debugging knowledge is available.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "luneos_get_topic",
      description:
        "Return the full markdown content of one LuneOS knowledge topic " +
        "(e.g. 'kernel-porting', 'debugging', 'device-bluejay'). " +
        "Use luneos_list_topics to see valid names.",
      inputSchema: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Topic name (filename without .md)" },
        },
        required: ["topic"],
        additionalProperties: false,
      },
    },
    {
      name: "luneos_search",
      description:
        "Case-insensitive search across the whole LuneOS knowledge base. Returns matching " +
        "lines with surrounding context and the topic they came from. Good for symptoms " +
        "('wait_for_prop', 'EGL_BAD_ALLOC', 'FMP self test'), config options, file names, tools.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring or word(s) to search for" },
          context_lines: {
            type: "integer",
            description: "Lines of context around each match (default 2)",
            minimum: 0,
            maximum: 10,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const topics = loadTopics();

  if (name === "luneos_list_topics") {
    const lines = [...topics.values()].map(
      (t) => `- **${t.name}** — ${t.title}${t.description ? `: ${t.description}` : ""}`
    );
    return { content: [{ type: "text", text: lines.join("\n") || "No topics found." }] };
  }

  if (name === "luneos_get_topic") {
    const t = topics.get(String(args.topic || "").replace(/\.md$/, ""));
    if (!t) {
      return {
        content: [{
          type: "text",
          text: `Unknown topic "${args.topic}". Known topics:\n` +
            [...topics.keys()].map((k) => `- ${k}`).join("\n"),
        }],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: t.content }] };
  }

  if (name === "luneos_search") {
    const query = String(args.query || "").toLowerCase();
    if (!query) {
      return { content: [{ type: "text", text: "Empty query." }], isError: true };
    }
    const ctx = Number.isInteger(args.context_lines) ? args.context_lines : 2;
    const results = [];
    for (const t of topics.values()) {
      const lines = t.content.split("\n");
      const hits = [];
      lines.forEach((line, i) => {
        if (line.toLowerCase().includes(query)) hits.push(i);
      });
      if (!hits.length) continue;
      // Merge overlapping context windows.
      const windows = [];
      for (const i of hits) {
        const start = Math.max(0, i - ctx);
        const end = Math.min(lines.length - 1, i + ctx);
        const last = windows[windows.length - 1];
        if (last && start <= last.end + 1) last.end = end;
        else windows.push({ start, end });
      }
      const snippets = windows
        .slice(0, 8)
        .map((w) => lines.slice(w.start, w.end + 1).join("\n"))
        .join("\n    …\n");
      results.push(`## ${t.name} (${hits.length} match${hits.length > 1 ? "es" : ""})\n${snippets}`);
    }
    const text = results.length
      ? results.join("\n\n")
      : `No matches for "${args.query}" in ${topics.size} topics.`;
    // Keep responses bounded.
    const MAX = 40000;
    return {
      content: [{
        type: "text",
        text: text.length > MAX
          ? text.slice(0, MAX) + `\n\n[truncated — narrow the query or use luneos_get_topic]`
          : text,
      }],
    };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
});

// ----- Prompts -------------------------------------------------------------

const PROMPTS = {
  "luneos-session-start": {
    description:
      "Orient a session on the LuneOS porting knowledge base: read the architecture overview, then pull topics as needed.",
    messages: () => [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "You are helping with LuneOS (webOS) development on Halium/GSI/GKI Android devices. " +
            "Read luneos://knowledge/architecture now (overview, device index, glossary), then use " +
            "luneos_search and luneos_get_topic for what the task needs; luneos://knowledge/all is " +
            "very large, load it only when the task spans the whole base. Key ground rules: " +
            "match the GSI to the device's vendor API level (ro.vndk.version or " +
            "ro.vendor.build.version.sdk; ro.board.api_level is a YYYYMM date on A15+ vendors), " +
            "never to the Android version it runs; android-headers track the GSI, not the vendor; " +
            "derive device configuration at runtime instead of shipping per-device files; and when a " +
            "device does not come up, follow knowledge/debugging.md stage by stage.",
        },
      },
    ],
  },
  "luneos-port-device": {
    description:
      "Start porting LuneOS to a new Android device — walks kernel, boot image, Yocto machine and bring-up.",
    args: [
      { name: "codename", description: "Device codename (e.g. bluejay, panther)", required: false },
      { name: "details", description: "What is known: SoC, Android version, kernel version, launch year…", required: false },
    ],
    messages: (a) => [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `I want to port LuneOS to a new device${a.codename ? ` (codename: ${a.codename})` : ""}.` +
            (a.details ? ` Known details: ${a.details}.` : "") +
            "\n\nUse the luneos-mcp knowledge base. Read these topics first: architecture, " +
            "kernel-porting, boot-images, device-bringup-yocto, nyx-modules, gsi-building, installing. " +
            "Then guide me through, in order:\n" +
            "1. Classify the device: Tier A (GKI, Android 12+/kernel 5.10+) or Tier B (legacy vendor kernel); " +
            "A12-launch vs A13-launch boot layout (init_boot or not); 32-bit vs 64-bit; anti-rollback state.\n" +
            "2. Obtain and analyze the stock images (factory zip or payload.bin), extract the kernel config " +
            "via IKCONFIG, run mer_verify_kernel_config, and plan the config fragment. The KMI-poison " +
            "list is per KMI and tree: re-derive it with kmi-crc-check.py, never copy another device's " +
            "(seen so far: FANOTIFY, NET_L3_MASTER_DEV, CGROUP_DEVICE, USER_NS). CONFIG_SYSVIPC is not needed.\n" +
            "3. Build the kernel (ACK for Tier A, vendor tree for Tier B; a vendor's \"GKI\" may be a derivative " +
            "that ACK cannot match, e.g. MediaTek mgk on q25 - then build the device tree) and verify KMI with " +
            "kmi-crc-check.py before flashing anything.\n" +
            "4. Build the boot image(s) with the LuneOS initramfs (module-order-aware init, cmdline " +
            "module params) and a debug variant with enable_adb.\n" +
            "5. Create the Yocto machine (nyx module selection lives in nyx-modules-machines.inc) and the GSI pin " +
            "for the right GSI generation (match vendor API level).\n" +
            "5a. Legacy vendor converted by halium-legacy-vendor (e.g. a LineageOS build): before the first derive, " +
            "run the checklist in gsi-building § Before deriving: read LineageOS's linker shim map " +
            "(TARGET_LD_SHIM_LIBS) into HALIUM_LEGACY_LD_SHIMS and carry /system shims with HALIUM_LEGACY_EXTRA_LIBS; " +
            "list passthrough HALs that sensorfw, bluebinder or droidmedia need and ship a service plus " +
            "HALIUM_LEGACY_BINDERIZED_HALS for each; run the full-tree symbol check (tools § fullres.py) on every " +
            "vendor daemon; fetch APEX-resident libraries such as ICU. Then list the vendor services " +
            "start-android-hals would force-start (disabled ones included) and decide which belong in " +
            "deviceinfo_android_skip_services.\n" +
            "6. Assemble the flash kit and install; then follow the debugging playbook for bring-up.",
        },
      },
    ],
  },
  "luneos-debug-boot": {
    description:
      "Debug a LuneOS device that does not come up — staged triage from kernel panic to UI.",
    args: [
      { name: "symptom", description: "What you see: bootloop, stuck on splash, black screen, no adb…", required: false },
      { name: "device", description: "Device codename", required: false },
    ],
    messages: (a) => [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `A LuneOS device${a.device ? ` (${a.device})` : ""} is not coming up.` +
            (a.symptom ? ` Symptom: ${a.symptom}.` : "") +
            "\n\nUse the luneos-mcp knowledge base: read the 'debugging' topic (and the matching " +
            "device-<codename> topic if one exists) and triage stage by stage:\n" +
            "Stage 0 — kernel: ramoops/pstore console, fastboot boot the -debug image (enable_adb).\n" +
            "Stage 1 — initramfs: module load order, module cmdline params, async storage probe, " +
            "userdata resize, adb shell into the 'Halium initrd' gadget and read /dev/kmsg.\n" +
            "Stage 2 — Android container: wait_for_prop gates (incl. the quoted-value trap), " +
            "init log tee/breadcrumbs to /dev/socket/init.log, container logcat (not just journalctl), " +
            "ashmem<boot_id>, vndservicemanager/selinuxfs, binder symlinks.\n" +
            "Stage 3 — display/UI: backlight, DRM probe, panel size, node permissions (EGL_BAD_ALLOC), " +
            "wayland socket / XDG_RUNTIME_DIR.\n" +
            "Stage 4 — subsystems: wifi, modem (fstab selection!), BT, sensors, time.\n" +
            "At each stage state what evidence to collect before changing anything.",
        },
      },
    ],
  },
};

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: Object.entries(PROMPTS).map(([name, p]) => ({
    name,
    description: p.description,
    arguments: p.args || [],
  })),
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const p = PROMPTS[request.params.name];
  if (!p) throw new Error(`Unknown prompt: ${request.params.name}`);
  return {
    description: p.description,
    messages: p.messages(request.params.arguments || {}),
  };
});

// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`luneos-mcp running (knowledge dir: ${KNOWLEDGE_DIR})`);
