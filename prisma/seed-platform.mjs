// Platform (Plat*) demo seed — three customer organisations exercising every
// platform screen. Called from seed.mjs; same contract: idempotent (skips an
// org whose jobs already exist) and fail-safe (errors logged, never thrown).
//
//  - dulong-downs        single long_project instance (the UC2 replacement, persona "Didi")
//  - northshore-builders multi-project MSME tenant (UC3 replacement)
//  - coastal-fitouts     second MSME tenant (proves multi-tenancy)
//
// §2b split: the org registry row (PlatOrganisation) and the owner membership
// (PlatCtlTeamMember) live in the CONTROL database; all demo rows below stay
// in the (default) tenant database, keyed by the control org id.

const J = (v) => JSON.stringify(v);

// Deterministic demo portal token so /portal/<token> is demoable out of the box.
export const DEMO_PORTAL_TOKEN =
  "demo0000portal0000northshore0000riverview0000token0000000001";

async function upsertOrg(controlDb, data, ownerEmail, ownerName) {
  const org = await controlDb.platOrganisation.upsert({
    where: { slug: data.slug },
    update: {},
    create: data,
  });
  // Owner membership in the control-plane team store (authoritative under
  // Clerk auth; demo mode ignores it but the row keeps auth-path tests real).
  const member = await controlDb.platCtlTeamMember.findFirst({
    where: { orgSlug: data.slug, email: ownerEmail },
  });
  if (!member) {
    await controlDb.platCtlTeamMember.create({
      data: { orgSlug: data.slug, email: ownerEmail, name: ownerName, role: "owner" },
    });
  }
  return org;
}

async function orgIsSeeded(prisma, orgId) {
  return (await prisma.platJob.count({ where: { orgId } })) > 0;
}

async function seedCfgDefaults(prisma, orgId, { zones = [], categories = [] } = {}) {
  const refs = [
    ...categories.map((c, i) => ({
      orgId, type: "budget_category", code: c.toLowerCase().replace(/\s+/g, "_"), name: c, sortOrder: i,
    })),
    ...zones.map((z, i) => ({
      orgId, type: "zone", code: z.toLowerCase().replace(/\s+/g, "_"), name: z, sortOrder: i,
    })),
  ];
  if (refs.length) await prisma.platCfgReference.createMany({ data: refs });
  await prisma.platCfgSetting.createMany({
    data: [
      { orgId, key: "learning.hypothesis_min_samples", value: J(3) },
      { orgId, key: "learning.rule_min_samples", value: J(5) },
      { orgId, key: "learning.auto_apply_min_confidence", value: J(85) },
      { orgId, key: "learning.auto_apply_min_triggers", value: J(50) },
    ],
  });
}

// ── Org 1: Dulong Downs (single long-project instance — UC2 replacement) ──────

async function seedDulongDowns(prisma, controlDb) {
  const org = await upsertOrg(controlDb, {
    slug: "dulong-downs",
    name: "Dulong Downs",
    vertical: "construction",
    defaultEngagementType: "long_project",
    allowedEngagementTypes: J(["long_project"]),
    aiAuthority: "approve_required",
    settings: J({
      assistant: {
        name: "Didi",
        persona:
          "You are Didi, the intelligent project management assistant for the Dulong Downs construction project. Be precise, data-driven, and flag risks proactively.",
      },
      features: { procurement: true, room_matrix: true, project_plan: true, variations: false, reports: false, meeting_minutes: false, portal: false, accounting: false, risks: false },
    }),
  }, "antonio@dulongdowns.example", "Antonio");
  if (await orgIsSeeded(prisma, org.id)) {
    console.log("  · platform org dulong-downs already seeded — skipped");
    return;
  }

  const owner = await prisma.platContact.create({
    data: { orgId: org.id, name: "Client / Owner Organisation", type: "client", email: "owner@dulongdowns.example" },
  });

  const job = await prisma.platJob.create({
    data: {
      orgId: org.id, code: "DD-001", name: "Dulong Downs Residence",
      engagementType: "long_project", status: "active",
      clientContactId: owner.id,
      address: "199 Dulong Road", suburb: "Dulong", lat: -26.63, lng: 152.88,
      startDate: new Date("2025-09-01"), targetEndDate: new Date("2027-02-28"),
      completionPct: 42, healthScore: 74, budgetTotal: 1450000,
      summary: "Owner-builder rural residence; Didi coordinates budget, actions, procurement and decisions.",
    },
  });

  const phases = await Promise.all(
    [
      { name: "Site Preparation", status: "complete", completionPct: 100, sortOrder: 1 },
      { name: "Foundation", status: "complete", completionPct: 100, sortOrder: 2 },
      { name: "Framing & Structure", status: "in_progress", completionPct: 60, sortOrder: 3 },
      { name: "Roofing", status: "pending", completionPct: 0, sortOrder: 4 },
      { name: "Fitout & Finishes", status: "pending", completionPct: 0, sortOrder: 5 },
    ].map((p) => prisma.platConPhase.create({ data: { orgId: org.id, jobId: job.id, ...p } })),
  );

  // Foundation actual deliberately left at the estimate; the seeded pending
  // proposal below updates it to 131,500 when approved (demo of the gate).
  const foundationLine = await prisma.platConBudgetLine.create({
    data: { orgId: org.id, jobId: job.id, phaseId: phases[1].id, category: "Foundation", description: "Slab + retaining", budgetAmount: 120000, committedAmount: 120000, actualAmount: 120000 },
  });
  await prisma.platConBudgetLine.createMany({
    data: [
      { orgId: org.id, jobId: job.id, phaseId: phases[0].id, category: "Site Works", description: "Clearing, cut & fill", budgetAmount: 45000, committedAmount: 45000, actualAmount: 43800 },
      { orgId: org.id, jobId: job.id, phaseId: phases[2].id, category: "Framing", description: "Structural timber + steel", budgetAmount: 180000, committedAmount: 142000, actualAmount: 96000 },
      { orgId: org.id, jobId: job.id, phaseId: phases[3].id, category: "Roofing", description: "Colorbond roof + gutters", budgetAmount: 90000, committedAmount: 0, actualAmount: 0 },
      { orgId: org.id, jobId: job.id, phaseId: phases[4].id, category: "Fitout", description: "Kitchen, bathrooms, floors", budgetAmount: 260000, committedAmount: 31000, actualAmount: 0 },
    ],
  });

  await prisma.platConCashflow.createMany({
    data: [
      { orgId: org.id, jobId: job.id, period: "2026-04", projected: 85000, actual: 91200 },
      { orgId: org.id, jobId: job.id, period: "2026-05", projected: 92000, actual: 88400 },
      { orgId: org.id, jobId: job.id, period: "2026-06", projected: 110000, actual: 36200, notes: "Month in progress" },
      { orgId: org.id, jobId: job.id, period: "2026-07", projected: 95000, actual: 0 },
    ],
  });

  const ws = await prisma.platWorkstream.create({
    data: { orgId: org.id, jobId: job.id, name: "Framing & Structure", milestone: "Frame inspection passed", status: "active", description: "All tasks tied to the framing phase." },
  });

  await prisma.platActionHub.createMany({
    data: [
      { orgId: org.id, jobId: job.id, workstreamId: ws.id, title: "Book frame inspection with certifier", priority: "P1", status: "open", owner: "Antonio", dueDate: new Date("2026-06-15"), sourceType: "manual" },
      { orgId: org.id, jobId: job.id, title: "Chase plumber quote for rough-in", priority: "P2", status: "in_progress", owner: "Didi", dueDate: new Date("2026-06-18"), sourceType: "chat" },
      { orgId: org.id, jobId: job.id, title: "Confirm window delivery window with supplier", priority: "P2", status: "open", owner: "Antonio", dueDate: new Date("2026-06-05"), sourceType: "manual" },
      { orgId: org.id, jobId: job.id, title: "Pay framing progress claim #3", priority: "P1", status: "done", owner: "Antonio", dueDate: new Date("2026-05-28"), sourceType: "manual" },
    ],
  });

  await prisma.platDecision.createMany({
    data: [
      { orgId: org.id, jobId: job.id, description: "Switch roof profile from tiles to Colorbond Ultra", rationale: "Cyclone rating + 14-day shorter lead time; net saving $8,200.", category: "Materials", status: "confirmed", madeBy: "Antonio", decidedAt: new Date("2026-05-12"), sourceType: "chat" },
      { orgId: org.id, jobId: job.id, description: "Defer pool excavation until after handover", rationale: "Avoids double-handling of crane access on the east bench.", category: "Scope", status: "proposed", madeBy: "Didi", sourceType: "chat" },
    ],
  });

  const vendor = await prisma.platConVendor.create({
    data: { orgId: org.id, name: "Sunshine Frame & Truss", category: "Framing", contactName: "Marko Ilic", contactEmail: "marko@sft.example", rating: 8 },
  });
  await prisma.platConVendor.create({
    data: { orgId: org.id, name: "Range Plumbing Co", category: "Plumbing", contactName: "Tess Hartley", rating: 7 },
  });

  await prisma.platConProcurement.createMany({
    data: [
      { orgId: org.id, jobId: job.id, item: "Structural LVL beams 300x63", category: "Framing", vendorId: vendor.id, vendorName: "Sunshine Frame & Truss", qty: 14, unitPrice: 410, total: 5740, status: "delivered", dueDate: new Date("2026-05-20") },
      { orgId: org.id, jobId: job.id, item: "Colorbond Ultra roof sheets", category: "Roofing", vendorName: "Reef Roofing Supplies", qty: 220, unitPrice: 41, total: 9020, status: "ordered", dueDate: new Date("2026-07-01") },
      { orgId: org.id, jobId: job.id, item: "Window package (14 units)", category: "Fitout", vendorName: "Coastal Glazing", qty: 1, unitPrice: 31000, total: 31000, status: "pending", dueDate: new Date("2026-08-10") },
    ],
  });

  await prisma.platConRoomMatrix.createMany({
    data: [
      { orgId: org.id, jobId: job.id, zone: "Ground Floor", name: "Kitchen", areaSqm: 24, ceilingHeight: "2.7m", finishes: J({ floor: "Polished concrete", walls: "Painted plasterboard", joinery: "2-pac" }) },
      { orgId: org.id, jobId: job.id, zone: "Ground Floor", name: "Living", areaSqm: 38, ceilingHeight: "3.0m raked", finishes: J({ floor: "Engineered oak", walls: "Painted plasterboard" }) },
      { orgId: org.id, jobId: job.id, zone: "First Floor", name: "Master Suite", areaSqm: 32, ceilingHeight: "2.7m", finishes: J({ floor: "Carpet", ensuite: "Full-height tile" }) },
    ],
  });

  await prisma.platDocument.createMany({
    data: [
      { orgId: org.id, jobId: job.id, title: "Approved structural drawings RevC", kind: "link", docType: "drawing", storageProvider: "external", storageRef: "https://drive.google.com/drive/folders/demo-structural-revc", status: "approved", uploadedBy: "Antonio" },
      { orgId: org.id, jobId: job.id, title: "Framing contract — Sunshine Frame & Truss", kind: "link", docType: "contract", storageProvider: "external", storageRef: "https://drive.google.com/drive/folders/demo-framing-contract", status: "approved", uploadedBy: "Antonio" },
    ],
  });

  // Learning loop: guidance rules injected into Didi's prompt + one pending hypothesis.
  await prisma.platHypothesis.create({
    data: {
      orgId: org.id,
      description: "Plumbing quotes for rural sites come in ~12% above initial allowance; consider a standing contingency.",
      dimension: "budget.plumbing", rootCausePattern: "rural access premium",
      sampleCount: 2, avgVariancePct: 12.4, confidence: 40, status: "pending", sourceType: "chat",
    },
  });
  await prisma.platLearningRule.createMany({
    data: [
      { orgId: org.id, ruleCode: "LRN-0001", kind: "guidance", description: "Always review the execution log at session start to detect off-system changes.", category: "Session", confidence: 90, timesTriggered: 41, dateActivated: new Date("2025-11-02") },
      { orgId: org.id, ruleCode: "LRN-0006", kind: "guidance", description: "Never process more than one bulk payment batch per session without re-verifying cashflow.", category: "Finance", cannotOverride: true, confidence: 95, timesTriggered: 12, dateActivated: new Date("2025-12-14") },
      { orgId: org.id, ruleCode: "LRN-0030", kind: "guidance", description: "Cross-check the cashflow ledger before any invoice write.", category: "Finance", confidence: 82, timesTriggered: 28, dateActivated: new Date("2026-02-03") },
    ],
  });

  // A chat session with one pending (proposed) write so the approval flow is demoable.
  const session = await prisma.platChatSession.create({
    data: { orgId: org.id, jobId: job.id, title: "Budget check-in", startedAt: new Date("2026-06-09T09:00:00Z") },
  });
  await prisma.platChatMessage.create({
    data: { orgId: org.id, sessionId: session.id, role: "user", content: "The foundation actuals came in at $131,500 — update the budget line." },
  });
  const assistantMsg = await prisma.platChatMessage.create({
    data: {
      orgId: org.id, sessionId: session.id, role: "assistant",
      content: "Foundation actuals of $131,500 are $11,500 (9.6%) over the $120,000 budget. I propose updating the Foundation budget line actual to $131,500 — please confirm.",
      toolCalls: J([{ tool: "update_budget_line", input: { category: "Foundation", actualAmount: 131500 } }]),
    },
  });
  // Pending proposal lives in the approval queue (PlatPendingWrite); the
  // execution log stays append-only audit events.
  await prisma.platPendingWrite.create({
    data: {
      orgId: org.id, jobId: job.id, tableKey: "budget_line", op: "update",
      recordId: foundationLine.id, payload: J({ actualAmount: 131500 }),
      actorType: "ai", actorName: "Didi", sourceMessageId: assistantMsg.id,
      status: "proposed", expiresAt: new Date("2026-07-15"),
    },
  });
  await prisma.platExecutionLog.createMany({
    data: [
      { orgId: org.id, jobId: job.id, actorType: "human", actorName: "Antonio", operation: "update", targetTable: "plat_con_procurement", payload: J({ item: "Structural LVL beams 300x63", status: "delivered" }), status: "executed", executedAt: new Date("2026-05-21T03:10:00Z"), result: "Marked delivered" },
      { orgId: org.id, jobId: job.id, actorType: "system", actorName: "off_system_change", operation: "update", targetTable: "plat_con_cashflow", payload: J({ period: "2026-04", actual: 91200 }), status: "executed", executedAt: new Date("2026-05-01T22:00:00Z"), result: "Imported from bank export" },
    ],
  });

  await prisma.platCfgTeamMember.createMany({
    data: [
      { orgId: org.id, name: "Antonio", role: "admin", email: "antonio@dulongdowns.example" },
      { orgId: org.id, name: "Site Supervisor", role: "editor", email: "super@dulongdowns.example" },
    ],
  });
  await seedCfgDefaults(prisma, org.id, {
    zones: ["Ground Floor", "First Floor", "External"],
    categories: ["Site Works", "Foundation", "Framing", "Roofing", "Fitout"],
  });

  console.log("  ✓ platform org dulong-downs seeded");
}

// ── Org 2: Northshore Builders (multi-project MSME — UC3 replacement) ─────────

async function seedNorthshore(prisma, controlDb) {
  const org = await upsertOrg(controlDb, {
    slug: "northshore-builders",
    name: "Northshore Builders Pty Ltd",
    vertical: "construction",
    defaultEngagementType: "long_project",
    allowedEngagementTypes: J(["long_project", "short_job"]),
    aiAuthority: "approve_required",
    settings: J({
      assistant: { name: "Site Assistant", persona: "You are the AI project coordinator for Northshore Builders. Be concise and practical." },
      features: { risks: true, variations: true, reports: true, meeting_minutes: true, portal: true, accounting: true, bim: true, delay_cascade: true, procurement: false, room_matrix: false, project_plan: false },
    }),
  }, "priya@northshore.example", "Priya Raman");
  if (await orgIsSeeded(prisma, org.id)) {
    console.log("  · platform org northshore-builders already seeded — skipped");
    return;
  }

  const job1 = await prisma.platJob.create({
    data: {
      orgId: org.id, code: "NS-024", name: "Riverview Apartments — Stage 1",
      engagementType: "long_project", status: "active",
      address: "12 Riverview Parade", suburb: "Maroochydore",
      startDate: new Date("2026-02-01"), targetEndDate: new Date("2026-11-30"),
      completionPct: 35, healthScore: 68, budgetTotal: 4200000,
      summary: "8-unit apartment development, two storeys plus basement parking.",
    },
  });
  const job2 = await prisma.platJob.create({
    data: {
      orgId: org.id, code: "NS-031", name: "Harbourside Deck Rebuild",
      engagementType: "short_job", status: "active",
      address: "4 Wharf Lane", suburb: "Mooloolaba",
      startDate: new Date("2026-06-01"), targetEndDate: new Date("2026-07-15"),
      completionPct: 20, healthScore: 81, budgetTotal: 86000,
      summary: "Six-week commercial deck replacement, fixed-price.",
    },
  });

  const p1 = await prisma.platConPhase.create({ data: { orgId: org.id, jobId: job1.id, name: "Basement & Podium", status: "complete", completionPct: 100, sortOrder: 1 } });
  const p2 = await prisma.platConPhase.create({ data: { orgId: org.id, jobId: job1.id, name: "Structure L1-L2", status: "in_progress", completionPct: 55, sortOrder: 2 } });
  await prisma.platConPhase.create({ data: { orgId: org.id, jobId: job1.id, name: "Facade & Roof", status: "pending", completionPct: 0, sortOrder: 3 } });
  // AI-drafted phase awaiting approval (feeds the phase-approvals screen).
  await prisma.platConPhase.create({ data: { orgId: org.id, jobId: job1.id, name: "Services Rough-in (AI suggested split)", status: "pending", completionPct: 0, sortOrder: 4, isAiDraft: true } });
  await prisma.platConPhase.create({ data: { orgId: org.id, jobId: job2.id, name: "Demolition", status: "complete", completionPct: 100, sortOrder: 1 } });
  await prisma.platConPhase.create({ data: { orgId: org.id, jobId: job2.id, name: "Rebuild", status: "in_progress", completionPct: 15, sortOrder: 2 } });

  await prisma.platConBudgetLine.createMany({
    data: [
      { orgId: org.id, jobId: job1.id, phaseId: p1.id, category: "Concrete", description: "Basement slab + podium", budgetAmount: 680000, committedAmount: 680000, actualAmount: 702000 },
      { orgId: org.id, jobId: job1.id, phaseId: p2.id, category: "Structure", description: "L1-L2 frame + precast", budgetAmount: 940000, committedAmount: 760000, actualAmount: 512000 },
      { orgId: org.id, jobId: job1.id, category: "Preliminaries", description: "Site overheads", budgetAmount: 310000, committedAmount: 310000, actualAmount: 145000 },
      { orgId: org.id, jobId: job2.id, category: "Materials", description: "Hardwood decking + subframe", budgetAmount: 41000, committedAmount: 38500, actualAmount: 12000 },
      { orgId: org.id, jobId: job2.id, category: "Labour", description: "Crew of 3, six weeks", budgetAmount: 36000, committedAmount: 36000, actualAmount: 7200 },
    ],
  });

  await prisma.platConCashflow.createMany({
    data: [
      { orgId: org.id, jobId: job1.id, period: "2026-05", projected: 380000, actual: 402000 },
      { orgId: org.id, jobId: job1.id, period: "2026-06", projected: 410000, actual: 130000, notes: "Month in progress" },
      { orgId: org.id, jobId: job1.id, period: "2026-07", projected: 395000, actual: 0 },
      { orgId: org.id, jobId: job2.id, period: "2026-06", projected: 28000, actual: 19200 },
      { orgId: org.id, jobId: job2.id, period: "2026-07", projected: 58000, actual: 0 },
    ],
  });

  await prisma.platConRisk.createMany({
    data: [
      { orgId: org.id, jobId: job1.id, description: "Precast supplier at capacity — L2 panels may slip 2 weeks", likelihood: 4, impact: 4, mitigation: "Lock delivery slots weekly; identify backup yard.", status: "open", owner: "PM", escalatedAt: new Date("2026-06-05"), escalationNote: "Score 16 — escalated to director review." },
      { orgId: org.id, jobId: job1.id, description: "Wet season carryover delaying facade start", likelihood: 3, impact: 3, mitigation: "Resequence internal fitout ahead of facade.", status: "open", owner: "PM" },
      { orgId: org.id, jobId: job2.id, description: "Marine-grade fixings lead time", likelihood: 2, impact: 3, mitigation: "Ordered week 1.", status: "mitigated", owner: "Foreman" },
    ],
  });

  // AI-drafted variation order pending approval.
  await prisma.platConVariationOrder.create({
    data: {
      orgId: org.id, jobId: job1.id, refNumber: "VO-024-003",
      title: "Substitute precast panels with in-situ walls (L2 east)",
      description: "Supplier capacity constraint on L2 east elevation panels.",
      scopeChange: "Form and pour 14 lm of in-situ wall in lieu of 6 precast panels.",
      costImpact: 18400, timeImpactDays: 6, status: "submitted",
      isAiDrafted: true, submittedBy: "Site Assistant (AI)",
      aiDraft: J({ basis: "precast lead time 6wk vs in-situ 2wk", confidence: 72 }),
    },
  });
  await prisma.platConVariationOrder.create({
    data: {
      orgId: org.id, jobId: job1.id, refNumber: "VO-024-002",
      title: "Additional basement waterproofing membrane",
      description: "Hydrostatic pressure higher than geotech report assumed.",
      scopeChange: "Extra membrane + drainage cell to basement walls.",
      costImpact: 32600, timeImpactDays: 4, status: "approved",
      submittedBy: "PM", approvedBy: "Client Rep", approvedAt: new Date("2026-04-22"),
    },
  });

  await prisma.platConVendor.createMany({
    data: [
      { orgId: org.id, name: "SunCoast Precast", category: "Concrete", contactName: "R. Alvarez", rating: 6 },
      { orgId: org.id, name: "Bayside Cranes", category: "Plant", contactName: "K. Nguyen", rating: 9 },
    ],
  });

  // Analyzed contract document.
  await prisma.platDocument.create({
    data: {
      orgId: org.id, jobId: job1.id, title: "Head contract — Riverview Stage 1",
      kind: "file", docType: "contract", classification: "contract",
      storageProvider: "local", storageRef: "northshore-builders/NS-024/contract/head-contract.txt",
      mimeType: "text/plain", sizeBytes: 18240, status: "analyzed",
      textContent: "AS4902 design and construct, fixed lump sum $4.2M, LDs $4,500/day capped at 5%, EOT for inclement weather per BOM records, defects liability 12 months.",
      aiSummary: "AS4902 D&C, $4.2M lump sum. Key exposures: LDs $4,500/day (5% cap), 12-month DLP, EOT requires BOM evidence within 5 business days.",
      aiAnalysis: J({ risks: ["Tight 5-day EOT notice window", "LD cap reached after ~46 days delay"], obligations: ["Monthly PCG report", "Weather records retention"] }),
      uploadedBy: "PM", analyzedAt: new Date("2026-03-02"),
    },
  });

  // Draft AI weekly report pending approval.
  await prisma.platConWeeklyReport.create({
    data: {
      orgId: org.id, jobId: job1.id, weekEnding: new Date("2026-06-07"),
      title: "Week ending 7 June 2026",
      content:
        "## Progress\n- L1 deck poured Thursday; cycle time 9 days (target 8).\n- Precast delivery risk escalated (see risk register).\n\n## Budget\n- Concrete package tracking 3.2% over; structure within tolerance.\n\n## Next week\n- L2 east walls form-up; VO-024-003 decision required.",
      isAiGenerated: true, status: "draft", generatedAt: new Date("2026-06-08T07:00:00Z"),
    },
  });

  // Unconfirmed meeting minutes with extracted actions.
  await prisma.platConMeetingMinutes.create({
    data: {
      orgId: org.id, jobId: job1.id, meetingDate: new Date("2026-06-06"),
      title: "Site coordination meeting #18", attendees: "PM, Foreman, Services Engineer, Client Rep",
      rawMinutes:
        "Discussed precast supply risk. Services engineer to confirm hydraulic riser locations by Friday. Client rep asked for updated cashflow by 15th. Crane double-shift approved for week 24.",
      extractedActions: J([
        { title: "Confirm hydraulic riser locations", owner: "Services Engineer", dueDate: "2026-06-12" },
        { title: "Issue updated cashflow to client", owner: "PM", dueDate: "2026-06-15" },
        { title: "Book crane double-shift week 24", owner: "Foreman", dueDate: "2026-06-09" },
      ]),
      actionsCount: 3, status: "processed",
    },
  });

  await prisma.platActionHub.createMany({
    data: [
      { orgId: org.id, jobId: job1.id, title: "Resolve VO-024-003 precast substitution", priority: "P1", status: "open", owner: "PM", dueDate: new Date("2026-06-13"), sourceType: "manual" },
      { orgId: org.id, jobId: job2.id, title: "Order marine-grade fixings batch 2", priority: "P2", status: "done", owner: "Foreman", dueDate: new Date("2026-06-04"), sourceType: "manual" },
    ],
  });

  await prisma.platDecision.create({
    data: { orgId: org.id, jobId: job1.id, description: "Adopt crane double-shift for week 24 to recover programme", rationale: "Recovers 4 of 6 days precast slip at $9k cost vs $27k LD exposure.", status: "proposed", madeBy: "Site Assistant (AI)", sourceType: "chat" },
  });

  // BIMx model (graphisoft-hosted demo hyper-model) + deterministic portal token.
  await prisma.platConBimModel.create({
    data: {
      orgId: org.id, jobId: job1.id, name: "Riverview Stage 1 — coordination model",
      provider: "bimx", embedUrl: "https://bimx.graphisoft.com/embed/demo-riverview-stage1",
      clientVisible: true, addedBy: "PM", notes: "Updated after L1 pour.",
    },
  });
  await prisma.platConPortalToken.create({
    data: {
      orgId: org.id, jobId: job1.id, token: DEMO_PORTAL_TOKEN,
      label: "Client Rep — Riverview", isActive: true, viewsCount: 7,
      expiresAt: new Date("2027-01-01"),
    },
  });

  await prisma.platConAccountingConnection.create({
    data: { orgId: org.id, provider: "demo", status: "connected", orgName: "Northshore Builders Pty Ltd", accessToken: "demo-token", lastSync: new Date("2026-06-08T20:00:00Z"), syncLog: "Synced 42 invoices, 18 bills.", recordsSynced: 60 },
  });

  // Learning loop demo state: 3 corrections on the same dimension + a hypothesis.
  const corr = [
    { aiValue: 640000, humanValue: 702000, rootCause: "pump and boom hire underestimated" },
    { aiValue: 118000, humanValue: 131500, rootCause: "pump and boom hire underestimated" },
    { aiValue: 84000, humanValue: 90500, rootCause: "Pump and boom hire underestimated " },
  ];
  const hyp = await prisma.platHypothesis.create({
    data: {
      orgId: org.id, description: "Concrete placement costs run ~9% over AI estimate when pump/boom hire is involved.",
      dimension: "budget.concrete", rootCausePattern: "pump and boom hire underestimated",
      sampleCount: 3, avgVariancePct: 9.1, confidence: 55, status: "pending",
    },
  });
  for (const c of corr) {
    await prisma.platCorrection.create({
      data: {
        orgId: org.id, jobId: job1.id, entityType: "budget_line", dimension: "budget.concrete",
        aiValue: c.aiValue, humanValue: c.humanValue,
        variancePct: Math.round(((c.humanValue - c.aiValue) / c.aiValue) * 1000) / 10,
        rootCause: c.rootCause.trim(), correctedBy: "PM", hypothesisId: hyp.id,
      },
    });
  }

  await prisma.platExecutionLog.createMany({
    data: [
      { orgId: org.id, jobId: job1.id, actorType: "ai", actorName: "Site Assistant", operation: "generate", targetTable: "plat_con_weeklyreport", payload: J({ weekEnding: "2026-06-07" }), status: "executed", executedAt: new Date("2026-06-08T07:00:00Z"), result: "Draft report generated" },
      { orgId: org.id, jobId: job1.id, actorType: "ai", actorName: "Site Assistant", operation: "create", targetTable: "plat_con_variationorder", payload: J({ refNumber: "VO-024-003" }), status: "executed", executedAt: new Date("2026-06-06T05:30:00Z"), result: "AI draft VO created (pending human approval)" },
    ],
  });

  await prisma.platCfgTeamMember.createMany({
    data: [
      { orgId: org.id, name: "Priya Raman", role: "admin", email: "priya@northshore.example" },
      { orgId: org.id, name: "Dean Walker", role: "editor", email: "dean@northshore.example" },
      { orgId: org.id, name: "Client Rep", role: "readonly", email: "client@riverview.example" },
    ],
  });
  await seedCfgDefaults(prisma, org.id, {
    categories: ["Preliminaries", "Concrete", "Structure", "Services", "Finishes"],
  });

  console.log("  ✓ platform org northshore-builders seeded");
}

// ── Org 3: Coastal Fitouts (second MSME tenant — proves isolation) ────────────

async function seedCoastal(prisma, controlDb) {
  const org = await upsertOrg(controlDb, {
    slug: "coastal-fitouts",
    name: "Coastal Fitouts",
    vertical: "construction",
    defaultEngagementType: "short_job",
    allowedEngagementTypes: J(["short_job", "long_project"]),
    aiAuthority: "propose_only",
    settings: J({
      assistant: { name: "Fitout Assistant", persona: "You are the AI coordinator for Coastal Fitouts, a commercial fitout contractor. Be brief." },
      features: { risks: true, variations: true, reports: true, meeting_minutes: false, portal: false, accounting: false, bim: false, delay_cascade: false, procurement: false, room_matrix: false, project_plan: false },
    }),
  }, "sam@coastalfitouts.example", "Sam Okafor");
  if (await orgIsSeeded(prisma, org.id)) {
    console.log("  · platform org coastal-fitouts already seeded — skipped");
    return;
  }

  const job = await prisma.platJob.create({
    data: {
      orgId: org.id, code: "CF-112", name: "Ocean St Cafe Fitout",
      engagementType: "short_job", status: "active",
      address: "88 Ocean Street", suburb: "Maroochydore",
      startDate: new Date("2026-05-18"), targetEndDate: new Date("2026-07-03"),
      completionPct: 45, healthScore: 77, budgetTotal: 145000,
      summary: "Seven-week cafe fitout: joinery, services, front-of-house finishes.",
    },
  });

  await prisma.platConPhase.createMany({
    data: [
      { orgId: org.id, jobId: job.id, name: "Strip-out & Services", status: "complete", completionPct: 100, sortOrder: 1 },
      { orgId: org.id, jobId: job.id, name: "Joinery & Finishes", status: "in_progress", completionPct: 40, sortOrder: 2 },
      { orgId: org.id, jobId: job.id, name: "Commissioning", status: "pending", completionPct: 0, sortOrder: 3 },
    ],
  });
  await prisma.platConBudgetLine.createMany({
    data: [
      { orgId: org.id, jobId: job.id, category: "Joinery", description: "Counter + banquette package", budgetAmount: 52000, committedAmount: 52000, actualAmount: 23000 },
      { orgId: org.id, jobId: job.id, category: "Services", description: "Mechanical + hydraulic", budgetAmount: 38000, committedAmount: 36500, actualAmount: 34100 },
    ],
  });
  await prisma.platConCashflow.createMany({
    data: [
      { orgId: org.id, jobId: job.id, period: "2026-06", projected: 62000, actual: 41800 },
      { orgId: org.id, jobId: job.id, period: "2026-07", projected: 49000, actual: 0 },
    ],
  });
  await prisma.platConRisk.create({
    data: { orgId: org.id, jobId: job.id, description: "Joinery delivery clash with floor sealing cure time", likelihood: 3, impact: 2, mitigation: "Resequence: seal FOH after joinery install.", status: "open", owner: "Supervisor" },
  });
  await prisma.platActionHub.create({
    data: { orgId: org.id, jobId: job.id, title: "Confirm grease trap inspection booking", priority: "P1", status: "open", owner: "Supervisor", dueDate: new Date("2026-06-16"), sourceType: "manual" },
  });
  await prisma.platCfgTeamMember.create({
    data: { orgId: org.id, name: "Sam Okafor", role: "admin", email: "sam@coastalfitouts.example" },
  });
  await seedCfgDefaults(prisma, org.id, { categories: ["Joinery", "Services", "Finishes"] });

  console.log("  ✓ platform org coastal-fitouts seeded");
}

export async function seedPlatform(prisma, controlDb) {
  for (const fn of [seedDulongDowns, seedNorthshore, seedCoastal]) {
    try {
      await fn(prisma, controlDb);
    } catch (err) {
      console.log(`  ! platform seed (${fn.name}): skipped (${err?.message ?? err})`);
    }
  }
}
