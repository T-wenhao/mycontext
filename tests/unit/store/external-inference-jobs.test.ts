import { describe, expect, it } from "vitest"
import { ExternalInferenceJobError, ExternalInferenceJobRepository } from "@mycontext/store"
import { openTestVault } from "../../helpers/vault.js"

const NOW = 1_800_000_000_000

function enqueue(repository: ExternalInferenceJobRepository, id = "job-1") {
  return repository.enqueue(
    {
      id,
      domainKind: "distillation",
      domainRef: "task-1",
      promptVersion: "distill-tasks-v1",
      contractVersion: "external-inference-v1",
    },
    NOW,
  )
}

describe("ExternalInferenceJobRepository", () => {
  it("persists jobs and makes publishing idempotent", () => {
    const vault = openTestVault()
    const repository = new ExternalInferenceJobRepository(vault.db)

    const first = enqueue(repository)
    const second = enqueue(repository, "job-2")

    expect(first.state).toBe("pending")
    expect(second.id).toBe("job-1")
    expect(repository.list()).toHaveLength(1)
  })

  it("rejects reusing a job id for a different domain reference", () => {
    const vault = openTestVault()
    const repository = new ExternalInferenceJobRepository(vault.db)
    enqueue(repository)

    expect(() =>
      repository.enqueue(
        {
          id: "job-1",
          domainKind: "distillation",
          domainRef: "task-2",
          promptVersion: "distill-tasks-v1",
          contractVersion: "external-inference-v1",
        },
        NOW,
      ),
    ).toThrowError("JOB_ID_CONFLICT")
    expect(repository.findById("job-1")?.domainRef).toBe("task-1")
  })

  it("claims one job, renews only its lease owner, and reclaims after expiry", () => {
    const vault = openTestVault()
    const repository = new ExternalInferenceJobRepository(vault.db)
    enqueue(repository)

    const claimed = repository.claim("worker-a", NOW, 1_000)
    expect(claimed?.state).toBe("leased")
    expect(claimed?.leaseOwner).toBe("worker-a")
    expect(repository.heartbeat("job-1", "worker-b", NOW + 100, 1_000)).toBeNull()
    expect(repository.heartbeat("job-1", "worker-a", NOW + 100, 1_000)?.leaseOwner).toBe("worker-a")

    expect(repository.claim("worker-b", NOW + 500, 1_000)).toBeNull()
    const reclaimed = repository.claim("worker-b", NOW + 1_101, 1_000)
    expect(reclaimed?.leaseOwner).toBe("worker-b")
    expect(reclaimed?.attempts).toBe(2)
  })

  it("revokes a worker lease immediately without waiting for expiry", () => {
    const vault = openTestVault()
    const repository = new ExternalInferenceJobRepository(vault.db)
    enqueue(repository)
    repository.claim("worker-a", NOW, 60_000)

    const revoked = repository.revokeLeases(NOW + 10, "worker-a")

    expect(revoked).toHaveLength(1)
    expect(revoked[0]).toMatchObject({
      id: "job-1",
      state: "pending",
      attempts: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "LEASE_REVOKED",
    })
    expect(repository.claim("worker-b", NOW + 11, 1_000)).toMatchObject({
      leaseOwner: "worker-b",
      attempts: 1,
    })
  })

  it("commits a submission once and rejects a conflicting duplicate", () => {
    const vault = openTestVault()
    const repository = new ExternalInferenceJobRepository(vault.db)
    enqueue(repository)
    repository.claim("worker-a", NOW, 1_000)

    let domainWrites = 0
    const first = repository.commit(
      {
        jobId: "job-1",
        workerId: "worker-a",
        submissionId: "submission-1",
        submissionDigest: "digest-1",
        resultCount: 2,
        usageTokens: 17,
        at: NOW + 10,
      },
      () => {
        domainWrites += 1
      },
    )
    expect(first.status).toBe("committed")
    expect(domainWrites).toBe(1)

    const duplicate = repository.commit(
      {
        jobId: "job-1",
        workerId: "worker-a",
        submissionId: "submission-1",
        submissionDigest: "digest-1",
        resultCount: 2,
        usageTokens: 17,
        at: NOW + 20,
      },
      () => {
        domainWrites += 1
      },
    )
    expect(duplicate.status).toBe("already_committed")
    expect(domainWrites).toBe(1)

    expect(() =>
      repository.commit(
        {
          jobId: "job-1",
          workerId: "worker-a",
          submissionId: "submission-2",
          submissionDigest: "digest-2",
          resultCount: 1,
          usageTokens: null,
          at: NOW + 30,
        },
        () => undefined,
      ),
    ).toThrow(ExternalInferenceJobError)
  })

  it("does not retain source content in status or failure metadata", () => {
    const vault = openTestVault()
    const repository = new ExternalInferenceJobRepository(vault.db)
    enqueue(repository)
    repository.claim("worker-a", NOW, 1_000)
    repository.fail("job-1", "worker-a", "INVALID_RESULT", NOW + 1)

    const status = repository.status()
    expect(status.failed).toBe(1)
    expect(JSON.stringify(status)).not.toContain("source")
    expect(status.jobs[0]?.lastError).toBe("INVALID_RESULT")
  })
})
