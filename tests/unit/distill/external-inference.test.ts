import { describe, expect, it } from "vitest"
import { ManualClock } from "@mycontext/kernel"
import { ExternalInferenceDistillHost } from "@mycontext/distill"
import {
  ConversationRepository,
  DistillTaskRepository,
  MessageRepository,
  ProfileFacetRepository,
} from "@mycontext/store"
import { openTestVault } from "../../helpers/vault.js"

const NOW = 1_800_000_000_000

function seedTaskVault() {
  const vault = openTestVault()
  new ConversationRepository(vault.db).upsert({
    id: "conversation-1",
    channelId: "dingtalk",
    externalId: "conversation-external-1",
    type: "group",
    title: "invented project room",
    memberCount: 3,
    createdAt: NOW,
  })
  new ConversationRepository(vault.db).upsert({
    id: "conversation-2",
    channelId: "dingtalk",
    externalId: "conversation-external-outside",
    type: "group",
    title: "outside scope room",
    memberCount: 2,
    createdAt: NOW,
  })
  new MessageRepository(vault.db).upsertMany([
    {
      id: "message-other",
      channelId: "dingtalk",
      conversationId: "conversation-1",
      externalId: "message-external-other",
      senderExternalId: "person-other",
      senderDisplayName: "other-role",
      contentText: "Can you review the change before tomorrow?",
      sentAt: NOW + 1,
      direction: "inbound",
      isSelf: false,
      createdAt: NOW,
    },
    {
      id: "message-self",
      channelId: "dingtalk",
      conversationId: "conversation-1",
      externalId: "message-external-self",
      senderExternalId: "person-self",
      senderDisplayName: "self-role",
      contentText: "I will review it and report the blocking issue.",
      sentAt: NOW + 2,
      direction: "outbound",
      isSelf: true,
      createdAt: NOW,
    },
    {
      id: "message-outside",
      channelId: "dingtalk",
      conversationId: "conversation-2",
      externalId: "message-external-outside",
      senderExternalId: "person-self",
      senderDisplayName: "self-role",
      contentText: "This message must not cross the selected conversation boundary.",
      sentAt: NOW + 3,
      direction: "outbound",
      isSelf: true,
      createdAt: NOW,
    },
  ])
  new DistillTaskRepository(vault.db).enqueue(
    {
      id: "distill-task-1",
      facet: "tasks",
      scope: "global",
      scopeRef: "",
      windowStart: NOW,
      windowEnd: NOW + 10_000,
    },
    NOW,
  )
  return vault
}

function makeHost(
  vault: ReturnType<typeof openTestVault>,
  clock = new ManualClock(NOW),
  conversationExternalIds?: readonly string[],
) {
  let nextId = 0
  return new ExternalInferenceDistillHost({
    db: vault.db,
    clock,
    newId: () => `generated-${String(nextId++)}`,
    ...(conversationExternalIds === undefined
      ? {}
      : {
          getConversationScope: () => ({
            restricted: true,
            allow: conversationExternalIds,
          }),
        }),
  })
}

describe("ExternalInferenceDistillHost", () => {
  it("publishes one tasks Facet, exposes bounded evidence, and commits through the host", () => {
    const vault = seedTaskVault()
    const host = makeHost(vault)
    const published = host.publishTask("distill-task-1")

    const claim = host.claim({ workerId: "worker-a" })
    expect(claim?.job.id).toBe(published.id)
    expect(claim?.evidence.map((item) => item.ref)).toEqual([
      "message-other",
      "message-self",
      "message-outside",
    ])
    expect(claim?.prompt).toContain("message-self")
    expect(claim?.prompt).toContain("message-other")

    const submitted = host.submit({
      workerId: "worker-a",
      jobId: published.id,
      submissionId: "submission-1",
      contractVersion: "external-inference-v1",
      result: {
        items: [
          {
            key: "review-change",
            value: {
              task: "review changes",
              from: "teammate",
              trigger: "change link and request",
              askKind: "help_request",
            },
            confidence: 0.9,
            evidence: ["message-other", "message-self"],
          },
        ],
      },
      usageTokens: 37,
    })

    expect(submitted.status).toBe("committed")
    expect(new DistillTaskRepository(vault.db).findById("distill-task-1")?.state).toBe("done")
    expect(new ProfileFacetRepository(vault.db).listByFacet("tasks", "global")).toHaveLength(1)
    expect(new ProfileFacetRepository(vault.db).listByFacet("tasks", "global")[0]?.source).toBe(
      "llm",
    )

    const duplicate = host.submit({
      workerId: "worker-a",
      jobId: published.id,
      submissionId: "submission-1",
      contractVersion: "external-inference-v1",
      result: {
        items: [
          {
            key: "review-change",
            value: {
              task: "review changes",
              from: "teammate",
              trigger: "change link and request",
              askKind: "help_request",
            },
            confidence: 0.9,
            evidence: ["message-other", "message-self"],
          },
        ],
      },
      usageTokens: 37,
    })
    expect(duplicate.status).toBe("already_committed")
    expect(new ProfileFacetRepository(vault.db).listByFacet("tasks", "global")).toHaveLength(1)
  })

  it("re-applies the current conversation allow-list when a worker claims", () => {
    const vault = seedTaskVault()
    const host = makeHost(vault, new ManualClock(NOW), ["conversation-external-1"])
    host.publishTask("distill-task-1")

    const claim = host.claim({ workerId: "worker-scoped" })

    expect(claim?.evidence.map((item) => item.ref)).toEqual(["message-other", "message-self"])
    expect(claim?.prompt).not.toContain("message-outside")
  })

  it("does not treat an explicitly empty allow-list as unrestricted", () => {
    const vault = seedTaskVault()
    const host = makeHost(vault, new ManualClock(NOW), [])
    host.publishTask("distill-task-1")

    expect(host.claim({ workerId: "worker-empty-scope" })?.evidence).toEqual([])
  })

  it("rejects unknown evidence before writing the Work Layer", () => {
    const vault = seedTaskVault()
    const host = makeHost(vault)
    const published = host.publishTask("distill-task-1")
    host.claim({ workerId: "worker-a" })

    expect(() =>
      host.submit({
        workerId: "worker-a",
        jobId: published.id,
        submissionId: "submission-bad",
        contractVersion: "external-inference-v1",
        result: {
          items: [
            {
              key: "invented",
              value: {
                task: "invented task",
                from: "role",
                trigger: "request",
                askKind: "other_ask",
              },
              confidence: 0.5,
              evidence: ["outside-this-task"],
            },
          ],
        },
      }),
    ).toThrowError("UNKNOWN_EVIDENCE")

    expect(new ProfileFacetRepository(vault.db).listByFacet("tasks", "global")).toHaveLength(0)
    expect(host.status().failed).toBe(1)
  })

  it("reclaims a task after an external worker lease expires", () => {
    const vault = seedTaskVault()
    const clock = new ManualClock(NOW)
    const host = makeHost(vault, clock)
    const published = host.publishTask("distill-task-1")

    expect(host.claim({ workerId: "worker-a", leaseMs: 1_000 })?.job.leaseOwner).toBe("worker-a")

    clock.advance(1_001)
    const reclaimed = host.claim({ workerId: "worker-b", leaseMs: 1_000 })

    expect(reclaimed?.job.id).toBe(published.id)
    expect(reclaimed?.job.leaseOwner).toBe("worker-b")
    expect(new DistillTaskRepository(vault.db).findById("distill-task-1")?.state).toBe("running")
  })

  it("does not let a stale worker mark the reclaimed task failed", () => {
    const vault = seedTaskVault()
    const clock = new ManualClock(NOW)
    const host = makeHost(vault, clock)
    const published = host.publishTask("distill-task-1")

    host.claim({ workerId: "worker-a", leaseMs: 1_000 })
    clock.advance(1_001)
    host.claim({ workerId: "worker-b", leaseMs: 1_000 })

    expect(() =>
      host.submit({
        workerId: "worker-a",
        jobId: published.id,
        submissionId: "stale-submission",
        contractVersion: "external-inference-v1",
        result: {
          items: [
            {
              key: "stale",
              value: {
                task: "stale task",
                from: "role",
                trigger: "request",
                askKind: "other_ask",
              },
              confidence: 0.5,
              evidence: ["outside-this-task"],
            },
          ],
        },
      }),
    ).toThrowError("UNKNOWN_EVIDENCE")

    expect(host.status().jobs[0]?.leaseOwner).toBe("worker-b")
    expect(host.status().jobs[0]?.state).toBe("leased")
    expect(new DistillTaskRepository(vault.db).findById("distill-task-1")?.state).toBe("running")
  })
})
