// Issue a per-org MCP API key (mcp-assistant-plan W2). Ops script, control DB.
//
//   node scripts/mcp-issue-key.mjs --slug <org> --email <member@org> [--label "n8n"]
//
// Steps:
//   1. Verify the org exists in the control registry and the email is an
//      active member (the key ACTS AS that member — their role and RLS job
//      scope apply to every call made with it).
//   2. Generate the key, store only its SHA-256 hash in settings.mcpKeys.
//   3. Ensure an active `mcp:in` connection row (the per-org kill switch the
//      endpoint checks; deactivate it to cut the org's MCP access).
//   4. Print the plaintext key ONCE. It is not recoverable — reissue to rotate.

import { createHash, randomBytes } from "node:crypto";
import { PrismaClient as ControlPrismaClient } from "@prisma/control-client";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
const slug = arg("slug");
const email = (arg("email") || "").toLowerCase();
const label = arg("label", "mcp");
if (!slug || !email) {
  console.error("Usage: node scripts/mcp-issue-key.mjs --slug <org> --email <member@org> [--label <name>]");
  process.exit(1);
}

const controlDb = new ControlPrismaClient();
try {
  const org = await controlDb.platOrganisation.findUnique({ where: { slug } });
  if (!org) throw new Error(`No org with slug '${slug}' in the control registry.`);
  if (!org.isActive) throw new Error(`Org '${slug}' is deactivated.`);

  const members = await controlDb.platCtlTeamMember.findMany({ where: { orgSlug: slug, isActive: true } });
  const bound = members.find((m) => m.email.toLowerCase() === email);
  if (!bound) {
    const known = members.map((m) => m.email).join(", ") || "(none)";
    throw new Error(`'${email}' is not an active member of '${slug}'. Active members: ${known}`);
  }

  const key = `aeq_mcp_${randomBytes(32).toString("base64url")}`;
  const keyHash = createHash("sha256").update(key, "utf8").digest("hex");

  let settings = {};
  try {
    const parsed = JSON.parse(org.settings || "{}");
    if (parsed && typeof parsed === "object") settings = parsed;
  } catch {
    /* start from empty rather than clobbering */
  }
  const keys = Array.isArray(settings.mcpKeys) ? settings.mcpKeys : [];
  keys.push({ keyHash, memberEmail: bound.email, label, createdAt: new Date().toISOString() });
  settings.mcpKeys = keys;
  await controlDb.platOrganisation.update({
    where: { id: org.id },
    data: { settings: JSON.stringify(settings) },
  });
  console.log(`- key hash stored in settings.mcpKeys (${keys.length} key(s) total)`);

  const conn = await controlDb.platCtlConnection.findFirst({
    where: { orgSlug: slug, channel: "mcp", direction: "in" },
  });
  if (!conn) {
    await controlDb.platCtlConnection.create({
      data: {
        orgSlug: slug,
        channel: "mcp",
        direction: "in",
        connectionKey: `${slug}:mcp:in`,
        credentialRef: "settings.mcpKeys",
        notes: "MCP endpoint enablement (mcp-assistant-plan W2)",
      },
    });
    console.log("- created active mcp:in connection row (the per-org kill switch)");
  } else if (!conn.isActive) {
    await controlDb.platCtlConnection.update({ where: { id: conn.id }, data: { isActive: true } });
    console.log("- re-activated existing mcp:in connection row");
  } else {
    console.log("- mcp:in connection row already active");
  }

  console.log(`
MCP key issued for '${slug}', acting as ${bound.email} (role: ${bound.role}).
Endpoint: POST /api/mcp/${slug}
Header:   Authorization: Bearer ${key}

Store this key now — only its hash is kept, it cannot be shown again.`);
} finally {
  await controlDb.$disconnect();
}
