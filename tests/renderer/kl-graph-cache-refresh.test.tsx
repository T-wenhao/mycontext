/**
 * @vitest-environment jsdom
 *
 * KL 进程重启或建图完成后，关系图缓存必须重新取数。
 *
 * 真实故障是：服务已经重启并持有新图，但 `graph-ego` 仍保留重启前的空结果；
 * 数字概览会刷新，关系图却一直为空，直到整个应用重启。
 */
import { afterEach, describe, expect, it } from "vitest"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { useKlGraphBuild, useKlServerStart } from "@renderer/lib/queries"

afterEach(cleanup)

function installApi(): void {
  Object.defineProperty(window, "mycontext", {
    configurable: true,
    value: {
      kl: {
        serverStart: () => Promise.resolve({ ok: true, data: undefined }),
        graphBuild: () =>
          Promise.resolve({
            ok: true,
            data: { ok: true, reason: null, entities: 480, facts: 820, edges: 5_361 },
          }),
      },
    },
  })
}

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

function seedGraphQueries(client: QueryClient): void {
  client.setQueryData(["kl", "graph-overview", "dingtalk"], { facts: 0 })
  client.setQueryData(["kl", "graph-ego", "dingtalk"], { nodes: [], links: [] })
}

describe("KL 图谱缓存刷新", () => {
  it("启动 KL 后同时作废图谱概览和关系图", async () => {
    installApi()
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    seedGraphQueries(client)
    const { result } = renderHook(() => useKlServerStart(), { wrapper: wrapper(client) })

    await act(async () => {
      await result.current.mutateAsync("dingtalk")
    })

    await waitFor(() => {
      expect(client.getQueryState(["kl", "graph-overview", "dingtalk"])?.isInvalidated).toBe(true)
      expect(client.getQueryState(["kl", "graph-ego", "dingtalk"])?.isInvalidated).toBe(true)
    })
  })

  it("建图结束后同时作废图谱概览和关系图", async () => {
    installApi()
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    seedGraphQueries(client)
    const { result } = renderHook(() => useKlGraphBuild(), { wrapper: wrapper(client) })

    await act(async () => {
      await result.current.mutateAsync({ channelId: "dingtalk" })
    })

    await waitFor(() => {
      expect(client.getQueryState(["kl", "graph-overview", "dingtalk"])?.isInvalidated).toBe(true)
      expect(client.getQueryState(["kl", "graph-ego", "dingtalk"])?.isInvalidated).toBe(true)
    })
  })
})
