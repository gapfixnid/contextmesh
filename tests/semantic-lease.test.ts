import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { ContextMeshApp } from "../src/app.js";
import { APPROVED_MODEL_KEY, APPROVED_MODEL_MANIFEST, canonicalJson } from "../src/semantic/manifest.js";
import { ContextMeshDatabase, type SemanticReconciliationOwner } from "../src/storage/database.js";
import { createFixtureWorkspace, removeFixtureWorkspace, writeWorkspaceFile } from "./helpers.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeFixtureWorkspace(root);
});

function owner(ownerUuid: string): SemanticReconciliationOwner {
  return { ownerUuid, ownerPid: process.pid, ownerHostname: "lease-test" };
}

function materialFailure() {
  return {
    failureClass: "material_sticky" as const,
    code: "MODEL_FILE_HASH_MISMATCH",
    detailCode: "MODEL_FILE_HASH_MISMATCH",
    materialFingerprint: "material-v1",
    safeSummary: "MODEL_FILE_HASH_MISMATCH",
  };
}

async function configuredApp(): Promise<{ app: ContextMeshApp; root: string }> {
  const root = createFixtureWorkspace();
  roots.push(root);
  const app = new ContextMeshApp(root);
  await app.indexWorkspace({ mode: "full" });
  app.database.configureSemanticModel({
    modelKey: APPROVED_MODEL_KEY,
    manifestDigest: APPROVED_MODEL_KEY,
    manifestJson: canonicalJson(APPROVED_MODEL_MANIFEST),
    dimensions: APPROVED_MODEL_MANIFEST.model.dimensions,
    vectorCodec: APPROVED_MODEL_MANIFEST.vectorCodec,
  });
  app.database.backfillSemanticSourceHashes();
  const eligible = app.database.getEligibleSemanticEntityKeys("code").size;
  app.database.updateSemanticFailure("code", materialFailure(), [materialFailure()], eligible, 0);
  return { app, root };
}

describe("semantic reconciliation DB claims", () => {
  it("fences a future-generation code index claim when the base graph advances", async () => {
    const { app } = await configuredApp();
    const state = app.database.getSemanticState("code")!;
    const currentGeneration = app.database.getWorkspace().currentGeneration;
    const claimed = app.database.claimCodeIndexEmbedding(
      {
        expectedCurrentGeneration: currentGeneration,
        targetGeneration: currentGeneration + 1,
        modelKey: state.modelKey!,
        eligibleEntityCount: state.eligibleEntityCount,
        documentSetDigest: "future-generation-document-set",
        materialFingerprint: "future-generation-material",
      },
      owner("future-index-owner"),
    );
    expect(claimed.reason).toBe("acquired");
    expect(claimed.claim?.baseGraphGeneration).toBe(currentGeneration);
    expect(claimed.claim?.targetGraphGeneration).toBe(currentGeneration + 1);

    const raw = new DatabaseSync(app.database.dbPath);
    raw.prepare("UPDATE workspaces SET current_generation = current_generation + 1").run();
    raw.prepare(
      `UPDATE workspace_semantic_state
       SET graph_generation = graph_generation + 1, semantic_revision = semantic_revision + 1
       WHERE plane = 'code'`,
    ).run();
    raw.close();
    expect(app.database.heartbeatCodeIndexEmbedding(claimed.claim!)).toBe(false);
    await app.close();
  });

  it("renews a live same-owner code index lease but counts its expired reacquisition as a takeover", async () => {
    const { app } = await configuredApp();
    const state = app.database.getSemanticState("code")!;
    const currentGeneration = app.database.getWorkspace().currentGeneration;
    const input = {
      expectedCurrentGeneration: currentGeneration,
      targetGeneration: currentGeneration + 1,
      modelKey: state.modelKey!,
      eligibleEntityCount: state.eligibleEntityCount,
      documentSetDigest: "same-owner-index-document-set",
      materialFingerprint: "same-owner-index-material",
    };
    const leaseOwner = owner("same-index-owner");
    expect(app.database.claimCodeIndexEmbedding(input, leaseOwner).reason).toBe("acquired");
    expect(app.database.claimCodeIndexEmbedding(input, leaseOwner).reason).toBe("acquired");
    expect(app.database.getSemanticClaimDiagnostics("code")).toMatchObject({
      claimCount: 1,
      takeoverCount: 0,
    });

    const raw = new DatabaseSync(app.database.dbPath);
    raw.prepare(
      "UPDATE semantic_reconciliation_claims SET lease_expiry_epoch = unixepoch('now') - 1 WHERE plane = 'code'",
    ).run();
    raw.close();

    expect(app.database.claimCodeIndexEmbedding(input, leaseOwner).reason).toBe("acquired");
    expect(app.database.getSemanticClaimDiagnostics("code")).toMatchObject({
      claimCount: 1,
      takeoverCount: 1,
    });
    await app.close();
  });

  it("renews a live same-owner reconciliation lease but counts its expired reacquisition as a takeover", async () => {
    const { app } = await configuredApp();
    const leaseOwner = owner("same-reconciliation-owner");
    expect(app.database.claimSemanticReconciliation("code", leaseOwner).reason).toBe("acquired");
    expect(app.database.claimSemanticReconciliation("code", leaseOwner).reason).toBe("acquired");
    expect(app.database.getSemanticClaimDiagnostics("code")).toMatchObject({
      claimCount: 1,
      takeoverCount: 0,
    });

    const raw = new DatabaseSync(app.database.dbPath);
    raw.prepare(
      "UPDATE semantic_reconciliation_claims SET lease_expiry_epoch = unixepoch('now') - 1 WHERE plane = 'code'",
    ).run();
    raw.close();

    expect(app.database.claimSemanticReconciliation("code", leaseOwner).reason).toBe("acquired");
    expect(app.database.getSemanticClaimDiagnostics("code")).toMatchObject({
      claimCount: 1,
      takeoverCount: 1,
    });
    await app.close();
  });

  it("blocks a completed attempt token and counts expiry takeover separately", async () => {
    const { app } = await configuredApp();
    const first = app.database.claimSemanticReconciliation("code", owner("owner-a"));
    expect(first.reason).toBe("acquired");
    expect(first.claim).not.toBeNull();

    const raw = new DatabaseSync(app.database.dbPath);
    raw.prepare(
      "UPDATE semantic_reconciliation_claims SET lease_expiry_epoch = unixepoch('now') - 1 WHERE plane = 'code'",
    ).run();
    raw.close();

    const takeover = app.database.claimSemanticReconciliation("code", owner("owner-b"));
    expect(takeover.reason).toBe("acquired");
    expect(app.database.getSemanticClaimDiagnostics("code")).toMatchObject({
      claimCount: 1,
      takeoverCount: 1,
    });
    expect(
      app.database.completeSemanticReconciliationFailure(
        takeover.claim!,
        materialFailure(),
        [materialFailure()],
        app.database.getEligibleSemanticEntityKeys("code").size,
        0,
      ),
    ).toBe(true);
    expect(app.database.claimSemanticReconciliation("code", owner("owner-c")).reason).toBe("completed");
    await app.close();
  });

  it("atomically advances one retry generation while a second process only falls back", async () => {
    const { app, root } = await configuredApp();
    const runtimeFailure = {
      failureClass: "runtime_retryable" as const,
      code: "SESSION_CREATION",
      detailCode: "ORT_SESSION_CREATE",
      materialFingerprint: "material-v1",
      safeSummary: "SESSION_CREATION",
    };
    const eligible = app.database.getEligibleSemanticEntityKeys("code").size;
    app.database.updateSemanticFailure("code", runtimeFailure, [runtimeFailure], eligible, 0);
    const initial = app.database.claimSemanticReconciliation("code", owner("initial"));
    expect(initial.claim).not.toBeNull();
    expect(
      app.database.completeSemanticReconciliationFailure(initial.claim!, runtimeFailure, [runtimeFailure], eligible, 0),
    ).toBe(true);

    const raw = new DatabaseSync(app.database.dbPath);
    raw.prepare(
      "UPDATE workspace_semantic_state SET next_retry_epoch = unixepoch('now') - 1 WHERE plane = 'code'",
    ).run();
    raw.close();
    const before = app.database.getSemanticState("code")!.retryGeneration;
    const reader = new ContextMeshDatabase(root, app.database.dbPath);
    const winner = app.database.claimSemanticReconciliation("code", owner("winner"));
    const loser = reader.claimSemanticReconciliation("code", owner("loser"));
    expect(winner.reason).toBe("acquired");
    expect(loser.reason).toBe("leased");
    expect(app.database.getSemanticState("code")?.retryGeneration).toBe(before + 1);
    expect(reader.getSemanticState("code")?.retryGeneration).toBe(before + 1);
    expect(app.database.getSemanticClaimDiagnostics("code").claimCount).toBe(2);
    reader.close();
    await app.close();
  });

  it("immediately fences an active old-generation owner", async () => {
    const { app, root } = await configuredApp();
    const oldClaim = app.database.claimSemanticReconciliation("code", owner("old-generation")).claim!;
    writeWorkspaceFile(root, "src/new-generation.ts", "export const newGeneration = true;\n");
    await app.indexWorkspace({ mode: "incremental" });
    expect(app.database.heartbeatSemanticReconciliation(oldClaim)).toBe(false);
    expect(app.database.getSemanticClaimDiagnostics("code")).toMatchObject({
      activeAttemptToken: null,
      supersedeCount: 1,
    });
    app.database.backfillSemanticSourceHashes();
    const state = app.database.getSemanticState("code")!;
    app.database.updateSemanticFailure(
      "code",
      materialFailure(),
      [materialFailure()],
      app.database.getEligibleSemanticEntityKeys("code").size,
      0,
    );
    const fresh = app.database.claimSemanticReconciliation("code", owner("new-generation"));
    expect(fresh.reason).toBe("acquired");
    expect(fresh.claim?.graphGeneration).toBe(state.graphGeneration);
    await app.close();
  });

  it("refreshes attempt-token counts in the claim transaction and fences fingerprint drift", async () => {
    const { app } = await configuredApp();
    const raw = new DatabaseSync(app.database.dbPath);
    raw.prepare(
      "UPDATE workspace_semantic_state SET eligible_entity_count = 999 WHERE plane = 'code'",
    ).run();
    const stale = app.database.claimSemanticReconciliation("code", owner("stale-count"));
    expect(stale.reason).toBe("state_changed");
    expect(app.database.getSemanticState("code")?.eligibleEntityCount).toBe(
      app.database.getEligibleSemanticEntityKeys("code").size,
    );
    expect(app.database.getSemanticClaimDiagnostics("code").claimCount).toBe(0);

    const current = app.database.claimSemanticReconciliation("code", owner("current-state"));
    expect(current.reason).toBe("acquired");
    raw.prepare(
      "UPDATE workspace_semantic_state SET failure_fingerprint = 'changed-after-claim' WHERE plane = 'code'",
    ).run();
    raw.close();
    expect(app.database.heartbeatSemanticReconciliation(current.claim!)).toBe(false);
    expect(
      app.database.completeSemanticReconciliationFailure(
        current.claim!,
        materialFailure(),
        [materialFailure()],
        app.database.getEligibleSemanticEntityKeys("code").size,
        0,
      ),
    ).toBe(false);
    await app.close();
  });
});
