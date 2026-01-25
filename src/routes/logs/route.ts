import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { getLogSnapshot, subscribeLogs, isLogCaptureEnabled } from "~/lib/log-buffer"

export const logsRouter = new Hono()

logsRouter.get("/", (c) => {
    const limit = Number.parseInt(c.req.query("limit") || "", 10) || 500
    const sinceId = Number.parseInt(c.req.query("since") || "", 10) || 0
    const snapshot = getLogSnapshot({ limit, sinceId })
    return c.json(snapshot)
})

logsRouter.get("/stream", (c) => {
    const limit = Number.parseInt(c.req.query("limit") || "", 10) || 500
    const sinceId = Number.parseInt(c.req.query("since") || "", 10) || 0

    return streamSSE(c, async (stream) => {
        if (!isLogCaptureEnabled()) {
            await stream.writeSSE({
                event: "disabled",
                data: "Log capture disabled",
            })
            return
        }
        const snapshot = getLogSnapshot({ limit, sinceId })
        for (const entry of snapshot.entries) {
            await stream.writeSSE({
                event: "log",
                data: JSON.stringify(entry),
            })
        }

        const unsubscribe = subscribeLogs((entry) => {
            void stream.writeSSE({
                event: "log",
                data: JSON.stringify(entry),
            }).catch(() => {
                // Ignore stream write errors on disconnect
            })
        })

        await new Promise<void>((resolve) => {
            const signal = c.req.raw.signal
            if (signal.aborted) {
                resolve()
                return
            }
            signal.addEventListener("abort", () => resolve(), { once: true })
        })

        unsubscribe()
    })
})
