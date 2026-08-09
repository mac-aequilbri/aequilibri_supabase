// Revoke per-org MCP API keys / disable MCP access (mcp-assistant-plan W6).
// Ops script, control DB. Counterpart of scripts/mcp-issue-key.mjs.
//
//   node scripts/mcp-revoke-key.mjs --slug <org> --list
//   node scripts/mcp-revoke-key.mjs --slug <org> --label <label>
//   node scripts/mcp-revoke-key.mjs --slug <org> --email <member@org>
//   node scripts/mcp-revoke-key.mjs --slug <org> --all [--disable]
//
// --disable additionally deactivates the org's `mcp:in` connection row (the
// kill switch every session checks), cutting OAuth consumers too — keys only
// authenticate machine clients. Offboarding an org = `--all --disable`, then
// the tenant-database decommission per §2b.

import { PrismaClient as ControlPrismaClient } from "@prisma/control-client";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const slug = arg("slug");
const label = arg("label");
const email = (arg("email") || "").toLowerCase();
if (!slug || (!has("list") && !label && !email && !has("all"))) {
  console.error(
    "Usage: node scripts/mcp-revoke-key.mjs --slug <org> (--list | --label <l> | --email <m> | --all) [--disable]",
  );
  process.exit(1);
}

const controlDb = new ControlPrismaClient();
try {
  const org = await controlDb.platOrganisation.findUnique({ where: { slug } });
  if (!org) throw new Error(`No org with slug '${slug}' in the control registry.`);

  let settings = {};
  try {
    const parsed = JSON.parse(org.settings || "{}");
    if (parsed && typeof parsed === "object") settings = parsed;
  } catch {
    /* treat malformed settings as empty */
  }
  const keys = Array.isArray(settings.mcpKeys) ? settings.mcpKeys : [];

  if (has("list")) {
    if (!keys.length) console.log(`No MCP keys stored for '${slug}'.`);
    for (const k of keys) {
      console.log(
        `- label=${JSON.stringify(k.label ?? "")} member=${k.memberEmail} created=${k.createdAt} hash=${String(k.keyHash).slice(0, 12)}…`,
      );
    }
  } else {
    const keep = has("all")
      ? []
      : keys.filter(
          (k) =>
            !(
              (label !== null && k.label === label) ||
              (email && String(k.memberEmail).toLowerCase() === email)
            ),
        );
    const removed = keys.length - keep.length;
    if (removed) {
      settings.mcpKeys = keep;
      await controlDb.platOrganisation.update({
        where: { id: org.id },
        data: { settings: JSON.stringify(settings) },
      });
    }
    console.log(`- revoked ${removed} key(s); ${keep.length} remain`);
  }

  if (has("disable")) {
    const res = await controlDb.platCtlConnection.updateMany({
      where: { orgSlug: slug, channel: "mcp", direction: "in" },
      data: { isActive: false },
    });
    console.log(
      res.count
        ? "- mcp:in connection deactivated — ALL MCP access (keys + OAuth) is now refused for this org"
        : "- no mcp:in connection row found (nothing to disable)",
    );
  }
} finally {
  await controlDb.$disconnect();
}
