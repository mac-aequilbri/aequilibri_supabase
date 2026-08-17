// The aiAuthority policy matrix is the platform's core write-safety
// mechanism — it decides whether an AI tool call executes immediately or
// waits in the approval queue. Test it exhaustively.

import { describe, expect, it } from "vitest";
import { WRITABLE_TABLES } from "@/lib/platform/recordWriter";
import { requiresApproval } from "./executor";
import { WRITER_TABLE } from "./dataCatalog";
import { ASSISTANT_TOOLS, roleCanQueryTable, roleCanUseTool, TOOL_POLICY } from "./tools";

describe("aiAuthority policy matrix", () => {
  it("reads never require approval", () => {
    for (const authority of ["propose_only", "approve_required", "auto_low_risk"] as const) {
      expect(requiresApproval(authority, "read")).toBe(false);
    }
  });

  it("propose_only and approve_required gate every write", () => {
    for (const authority of ["propose_only", "approve_required"] as const) {
      expect(requiresApproval(authority, "low_write")).toBe(true);
      expect(requiresApproval(authority, "high_write")).toBe(true);
    }
  });

  it("auto_low_risk executes low-risk writes but gates high-risk", () => {
    expect(requiresApproval("auto_low_risk", "low_write")).toBe(false);
    expect(requiresApproval("auto_low_risk", "high_write")).toBe(true);
  });

  it("unknown authority values fail safe (gate everything)", () => {
    expect(requiresApproval("garbage" as never, "low_write")).toBe(true);
    expect(requiresApproval("" as never, "high_write")).toBe(true);
  });
});

describe("tool policy registry consistency", () => {
  it("every assistant tool has a policy entry", () => {
    for (const tool of ASSISTANT_TOOLS) {
      expect(TOOL_POLICY[tool.name], `missing policy for ${tool.name}`).toBeDefined();
    }
  });

  it("every fixed-table write tool maps to a registered writable table", () => {
    for (const [name, policy] of Object.entries(TOOL_POLICY)) {
      if (policy.risk === "read") continue;
      if (policy.kind === "service") continue; // service tools call a service, not recordWriter
      if (policy.kind === "propose") continue; // table is a runtime argument — checked below
      expect(policy.table, `${name} has no table`).toBeDefined();
      expect(WRITABLE_TABLES, `${name} → unknown table ${policy.table}`).toContain(policy.table);
      expect(["create", "update"]).toContain(policy.op);
    }
  });

  it("every proposable table resolves to a registered writable table", () => {
    // The generic tools take the table as an argument, so the guarantee moves
    // from the policy to the catalog→recordWriter map.
    for (const [key, table] of Object.entries(WRITER_TABLE)) {
      expect(WRITABLE_TABLES, `${key} → unknown table ${table}`).toContain(table);
    }
    for (const [name, policy] of Object.entries(TOOL_POLICY)) {
      if (policy.kind !== "propose") continue;
      expect(["create", "update", "delete"], name).toContain(policy.op);
    }
  });

  it("deletion is always high-risk, so it is gated under every authority", () => {
    expect(TOOL_POLICY.propose_delete.risk).toBe("high_write");
  });

  it("rule proposals are always high-risk (prompt-injection reach)", () => {
    expect(TOOL_POLICY.propose_rule.risk).toBe("high_write");
  });
});

describe("assistant role-scoped access (Spec 12 Module 7)", () => {
  it("broker is read-only except creating issues (Decision Required flagging)", () => {
    expect(roleCanUseTool("broker", "query_records")).toBe(true);
    expect(roleCanUseTool("broker", "create_action")).toBe(true);
    expect(roleCanUseTool("broker", "update_action")).toBe(false);
    expect(roleCanUseTool("broker", "update_budget_line")).toBe(false);
    expect(roleCanUseTool("broker", "save_decision")).toBe(false);
  });

  it("builder writes PLAN/ISSUES only — no budget, risks, decisions, or rules", () => {
    expect(roleCanUseTool("builder", "create_action")).toBe(true);
    expect(roleCanUseTool("builder", "update_action")).toBe(true);
    expect(roleCanUseTool("builder", "log_workstream_update")).toBe(true);
    expect(roleCanUseTool("builder", "update_budget_line")).toBe(false);
    expect(roleCanUseTool("builder", "create_risk")).toBe(false);
    expect(roleCanUseTool("builder", "save_decision")).toBe(false);
    expect(roleCanUseTool("builder", "propose_rule")).toBe(false);
    expect(roleCanUseTool("builder", "create_variation_draft")).toBe(false);
  });

  it("architect drafts scope changes but has no financial write", () => {
    expect(roleCanUseTool("architect", "create_variation_draft")).toBe(true);
    expect(roleCanUseTool("architect", "update_budget_line")).toBe(false);
    expect(roleCanUseTool("architect", "save_decision")).toBe(false);
  });

  it("owner can use every tool", () => {
    for (const name of Object.keys(TOOL_POLICY)) {
      expect(roleCanUseTool("owner", name), name).toBe(true);
    }
  });

  it("financial and restricted tables are unreadable below owner", () => {
    for (const role of ["builder", "architect", "broker"]) {
      expect(roleCanQueryTable(role, "budget_lines"), role).toBe(false);
      expect(roleCanQueryTable(role, "cashflows"), role).toBe(false);
      expect(roleCanQueryTable(role, "learning_rules"), role).toBe(false);
      expect(roleCanQueryTable(role, "actions"), role).toBe(true);
    }
    expect(roleCanQueryTable("builder", "risks")).toBe(false);
    expect(roleCanQueryTable("architect", "procurement")).toBe(false);
    expect(roleCanQueryTable("builder", "procurement")).toBe(true); // their trade's items
    expect(roleCanQueryTable("owner", "budget_lines")).toBe(true);
  });
});
