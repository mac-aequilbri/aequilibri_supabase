import { db, prisma } from "@/lib/db";
import type { OrgCtx } from "@/lib/platform/types";
import type { RecordId } from "@/lib/platform/recordWriter";
import {
  runConstructionAssessment,
  type AssessmentIntakeInput,
} from "@/services/platform/construction/assess";
import {
  runBuilderTenderComparison,
  type BuilderTenderComparisonInput,
} from "./builderTenderComparison";
import {
  runArchitecturalScopeAssessment,
  type ArchitecturalScopeAssessmentInput,
} from "./architecturalScopeAssessment";

export type Module3CapabilityKey =
  | "construction_intake"
  | "builder_tender_comparison"
  | "architectural_scope_assessment";

export interface Module3RunResult {
  capability: Module3CapabilityKey;
  resultId: RecordId;
  overallConfidence: number;
  outputVersion: string;
  notes: string;
}

type CapabilityInput =
  | { capability: "construction_intake"; input: AssessmentIntakeInput }
  | { capability: "builder_tender_comparison"; input: BuilderTenderComparisonInput }
  | { capability: "architectural_scope_assessment"; input: ArchitecturalScopeAssessmentInput };

async function logCapabilityRun(
  ctx: OrgCtx,
  userName: string,
  result: Module3RunResult,
  payload: unknown,
): Promise<void> {
  await db(ctx).platExecutionLog
    .create({
      data: {
        orgId: ctx.orgId,
        actorType: "ai",
        actorName: "Assessment Engine",
        operation: "generate",
        targetTable: `module3.${result.capability}`,
        targetId: typeof result.resultId === "number" ? result.resultId : null,
        payload: JSON.stringify(payload),
        result: JSON.stringify({
          id: String(result.resultId),
          confidence: result.overallConfidence,
          outputVersion: result.outputVersion,
          notes: result.notes,
          by: userName,
        }),
        status: "executed",
        executedAt: new Date(),
      },
    })
    .catch(() => {});
}

export async function runModule3Capability(
  ctx: OrgCtx,
  userName: string,
  request: CapabilityInput,
): Promise<Module3RunResult> {
  let result: Module3RunResult;
  switch (request.capability) {
    case "construction_intake": {
      const assessmentId = await runConstructionAssessment(ctx, userName, request.input);
      result = {
        capability: "construction_intake",
        resultId: assessmentId,
        overallConfidence: 60,
        outputVersion: "module3.construction-intake@1.0",
        notes: "Construction intake assessment drafted.",
      };
      break;
    }
    case "builder_tender_comparison":
      result = await runBuilderTenderComparison(ctx, userName, request.input);
      break;
    case "architectural_scope_assessment":
      result = await runArchitecturalScopeAssessment(ctx, userName, request.input);
      break;
    default:
      throw new Error("Unsupported Module 3 capability.");
  }
  await logCapabilityRun(ctx, userName, result, request.input);
  return result;
}
