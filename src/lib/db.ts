import { PrismaClient } from "@prisma/client";
import { PrismaClient as ControlPrismaClient } from "@prisma/control-client";

// Two Prisma clients behind one seam (§2b rules 1–2, migration-plan Phase 3):
//
//   - TENANT client (@prisma/client, prisma/schema.prisma, DATABASE_URL):
//     all client/domain data. One database per client org is the end state;
//     DATABASE_URL is the default/legacy shared tenant DB until per-org
//     databases are provisioned (db(ctx) below is the resolver seam).
//   - CONTROL client (@prisma/control-client, prisma/control/schema.prisma,
//     CONTROL_DATABASE_URL): the org registry (PlatOrganisation) + PlatCtl*
//     stores. One per deployment.
//
// The exported `prisma`/`prismaUnscoped` are dispatch proxies: property access
// for a control-plane model routes to the control client, everything else to
// the tenant client — the physical split without touching call sites. The
// split line is exactly the old org-isolation-guard regex. Note $transaction
// runs on the TENANT client; control-plane transactions use
// `controlDb.$transaction` explicitly (no cross-database transactions exist —
// §2b topology).
//
// Tenant-isolation guard (tenant client only): every fan-out query
// (findMany/findFirst/count/aggregate/groupBy/updateMany/deleteMany) and every
// create against an org-scoped Plat* model MUST carry an orgId constraint, or
// the client throws before the query executes. Kept as a tripwire even though
// a tenant DB will only ever hold one org (§2b rule 3): wrong-DB wiring bugs
// must hit a second, independent wall. Unique-key operations are exempt
// because the platform pattern verifies ownership first (recordWriter's
// findFirst({ id, orgId }) guard). Deliberate cross-org access uses
// `prismaUnscoped`.

const ORG_SCOPED = /^Plat(?!Organisation$|Ctl)/;
const FANOUT_OPS = new Set([
  "findMany",
  "findFirst",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "deleteMany",
]);

/** Model delegates served by the control client — keep in sync with
 *  prisma/control/schema.prisma (it's small on purpose). */
const CONTROL_MODELS = new Set([
  "platOrganisation",
  "platCtlOrgRegistry",
  "platCtlTeamMember",
  "platCtlAssignment",
  "platCtlConnection",
  "platCtlOutbox",
  "platCtlReportCatalog",
  "platCtlTemplateRegistry",
  "platCtlJobCatalog",
]);

/* eslint-disable @typescript-eslint/no-explicit-any */
function hasOrgConstraint(where: any): boolean {
  if (!where || typeof where !== "object") return false;
  if (where.orgId !== undefined) return true;
  if (Array.isArray(where.AND)) return where.AND.some(hasOrgConstraint);
  return false;
}

function makeClients() {
  const base = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
  const control = new ControlPrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
  const guarded = base.$extends({
    name: "org-isolation-guard",
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          if (ORG_SCOPED.test(model)) {
            const a = (args ?? {}) as any;
            if (FANOUT_OPS.has(operation) && !hasOrgConstraint(a.where)) {
              throw new Error(
                `Unscoped platform query: ${model}.${operation} must filter by orgId (use prismaUnscoped for deliberate cross-org access).`,
              );
            }
            if (operation === "create" && a.data && a.data.orgId === undefined) {
              throw new Error(`Unscoped platform write: ${model}.create must set orgId.`);
            }
            if (operation === "createMany") {
              const rows = Array.isArray(a.data) ? a.data : [a.data];
              if (rows.some((r: any) => r && r.orgId === undefined)) {
                throw new Error(`Unscoped platform write: ${model}.createMany rows must set orgId.`);
              }
            }
          }
          return query(args);
        },
      },
    },
  });
  return { base, guarded, control };
}

type Clients = ReturnType<typeof makeClients>;
const globalForPrisma = globalThis as unknown as { prismaClients?: Clients };

const clients = globalForPrisma.prismaClients ?? makeClients();
if (process.env.NODE_ENV !== "production") globalForPrisma.prismaClients = clients;

type ControlDelegates = Pick<
  ControlPrismaClient,
  | "platOrganisation"
  | "platCtlOrgRegistry"
  | "platCtlTeamMember"
  | "platCtlAssignment"
  | "platCtlConnection"
  | "platCtlOutbox"
  | "platCtlReportCatalog"
  | "platCtlTemplateRegistry"
  | "platCtlJobCatalog"
>;

function withControlDispatch<T extends object>(tenant: T, control: ControlPrismaClient) {
  return new Proxy(tenant, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && CONTROL_MODELS.has(prop)) {
        return (control as any)[prop];
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as T & ControlDelegates;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Control-plane client (org registry + PlatCtl*). Use directly for
 *  control-plane transactions; model access via `prisma` dispatches here. */
export const controlDb = clients.control;

/** Org-isolation-guarded dispatch client — the default for all platform code. */
export const prisma = withControlDispatch(clients.guarded, clients.control);

/** Unguarded dispatch client for deliberate cross-org access only (portal
 *  token resolution, seeds, ops scripts). Every use is a reviewed exception. */
export const prismaUnscoped = withControlDispatch(clients.base, clients.control);

/** §2b rule 2 — the tenant-DB resolver seam, keyed on the Phase D OrgCtx
 *  threading. Today every org lives in the default tenant DB (DATABASE_URL),
 *  so this returns the shared guarded client; when per-org tenant databases
 *  are provisioned (Phase 3 stage B3.4), this resolves the org's connection
 *  from the control registry and returns its cached client instead. New code
 *  should reach tenant data through db(ctx), not `prisma`. */
export function db(_ctx: { orgId: number }): typeof prisma {
  return prisma;
}
