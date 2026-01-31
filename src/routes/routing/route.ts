import { Hono } from "hono"
import { authStore } from "~/services/auth/store"
import { getProviderModels } from "~/services/routing/models"
import { 
    loadRoutingConfig, 
    saveRoutingConfig, 
    setActiveFlow, 
    toggleAccountDisabled, 
    getModelMappings,
    saveModelMappings,
    PRESET_SOURCE_MODELS,
    type RoutingEntry, 
    type RoutingFlow, 
    type AccountRoutingConfig,
    type ModelMapping,
} from "~/services/routing/config"
import { accountManager } from "~/services/antigravity/account-manager"
import { getAggregatedQuota } from "~/services/quota-aggregator"
import { AVAILABLE_MODELS } from "~/lib/config"
import { readFileSync } from "fs"
import { join } from "path"
import { randomUUID } from "crypto"
import type { ProviderAccountSummary } from "~/services/auth/types"

export const routingRouter = new Hono()

routingRouter.get("/", (c) => {
    try {
        const htmlPath = join(import.meta.dir, "../../../public/routing.html")
        const html = readFileSync(htmlPath, "utf-8")
        return c.html(html)
    } catch {
        return c.text("Routing panel not found", 404)
    }
})

routingRouter.get("/config", async (c) => {
    accountManager.load()
    const config = loadRoutingConfig()

    const listSummariesInOrder = (provider: "antigravity" | "codex" | "copilot"): ProviderAccountSummary[] => {
        const accounts = authStore.listAccounts(provider)
        const sorted = accounts.sort((a, b) => {
            const aTime = a.createdAt || ""
            const bTime = b.createdAt || ""
            if (aTime && bTime) {
                return aTime.localeCompare(bTime)
            }
            if (aTime) return -1
            if (bTime) return 1
            return 0
        })
        return sorted.map(acc => ({
            id: acc.id,
            provider: acc.provider,
            displayName: acc.label || acc.email || acc.login || acc.id,
            email: acc.email,
            login: acc.login,
            label: acc.label,
            expiresAt: acc.expiresAt,
        }))
    }

    const accounts = {
        antigravity: listSummariesInOrder("antigravity"),
        codex: listSummariesInOrder("codex"),
        copilot: listSummariesInOrder("copilot"),
    }

    const models = {
        antigravity: getProviderModels("antigravity"),
        codex: getProviderModels("codex"),
        copilot: getProviderModels("copilot"),
    }

    // Get quota data for displaying on model blocks
    let quota: Awaited<ReturnType<typeof getAggregatedQuota>> | null = null
    try {
        quota = await getAggregatedQuota()
    } catch {
        // Quota fetch is optional, continue without it
    }

    return c.json({ config, accounts, models, quota })
})

routingRouter.post("/config", async (c) => {
    const body = await c.req.json<{ flows?: RoutingFlow[]; entries?: RoutingEntry[]; accountRouting?: AccountRoutingConfig }>()
    let flows: RoutingFlow[] = []

    if (Array.isArray(body.flows)) {
        flows = body.flows
    } else if (Array.isArray(body.entries)) {
        flows = [{ id: randomUUID(), name: "default", entries: body.entries }]
    } else {
        const existing = loadRoutingConfig()
        flows = existing.flows
    }

    const normalized = flows.map((flow, index) => ({
        id: flow.id || randomUUID(),
        name: (flow.name || `Flow ${index + 1}`).trim() || `Flow ${index + 1}`,
        entries: Array.isArray(flow.entries)
            ? flow.entries.map(entry => ({
                ...entry,
                id: entry.id || randomUUID(),
                label: entry.label || `${entry.provider}:${entry.modelId}`,
            }))
            : [],
    }))

    let accountRouting: AccountRoutingConfig | undefined
    if (body.accountRouting) {
        accountRouting = {
            smartSwitch: body.accountRouting.smartSwitch ?? false,
            routes: Array.isArray(body.accountRouting.routes)
                ? body.accountRouting.routes.map(route => ({
                    id: route.id || randomUUID(),
                    modelId: (route.modelId || "").trim(),
                    entries: Array.isArray(route.entries)
                        ? route.entries.map(entry => ({
                            ...entry,
                            id: entry.id || randomUUID(),
                        }))
                        : [],
                }))
                : [],
        }
    }

    const config = saveRoutingConfig(normalized, undefined, accountRouting)
    return c.json({ success: true, config })
})

// 🆕 设置/清除激活的 flow
routingRouter.post("/active-flow", async (c) => {
    const body = await c.req.json<{ flowId: string | null }>()
    const config = setActiveFlow(body.flowId)
    return c.json({ success: true, config })
})

// 🆕 清理孤立账号（已删除但仍在 routing 中的账号）
routingRouter.post("/cleanup", async (c) => {
    const config = loadRoutingConfig()

    // 获取所有有效账号
    const validAntigravity = new Set(authStore.listSummaries("antigravity").map(a => a.id || a.email))
    const validCodex = new Set(authStore.listSummaries("codex").map(a => a.id || a.email))
    const validCopilot = new Set(authStore.listSummaries("copilot").map(a => a.id || a.email))

    let removedCount = 0

    // 清理每个 flow 中的孤立 entries
    const cleanedFlows = config.flows.map(flow => ({
        ...flow,
        entries: flow.entries.filter(entry => {
            let isValid = false
            if (entry.provider === "antigravity") {
                isValid = entry.accountId === "auto" || validAntigravity.has(entry.accountId)
            } else if (entry.provider === "codex") {
                isValid = validCodex.has(entry.accountId)
            } else if (entry.provider === "copilot") {
                isValid = validCopilot.has(entry.accountId)
            }
            if (!isValid) {
                removedCount++
            }
            return isValid
        })
    }))

    // 清理 account routing 中的孤立 entries
    const cleanedAccountRouting = config.accountRouting ? {
        ...config.accountRouting,
        routes: config.accountRouting.routes.map(route => ({
            ...route,
            entries: route.entries.filter(entry => {
                let isValid = false
                if (entry.provider === "antigravity") {
                    isValid = entry.accountId === "auto" || validAntigravity.has(entry.accountId)
                } else if (entry.provider === "codex") {
                    isValid = validCodex.has(entry.accountId)
                } else if (entry.provider === "copilot") {
                    isValid = validCopilot.has(entry.accountId)
                }
                if (!isValid) {
                    removedCount++
                }
                return isValid
            })
        }))
    } : config.accountRouting

    // 保存清理后的配置
    const newConfig = saveRoutingConfig(cleanedFlows, undefined, cleanedAccountRouting)

    // 同时清理 account-manager 的 rate limit 状态
    accountManager.clearAllRateLimits()

    return c.json({
        success: true,
        removedCount,
        config: newConfig
    })
})

// 🆕 切换账户禁用状态
routingRouter.post("/toggle-account", async (c) => {
    const body = await c.req.json<{ provider: string; accountId: string }>()
    if (!body.provider || !body.accountId) {
        return c.json({ error: "Missing provider or accountId" }, 400)
    }
    const result = toggleAccountDisabled(body.provider, body.accountId)
    console.log(`[Routing] Account ${body.provider}/${body.accountId} ${result.disabled ? "DISABLED" : "ENABLED"}`)
    return c.json({ success: true, disabled: result.disabled })
})

// ==================== 🆕 模型映射 API ====================

// 获取模型映射配置
routingRouter.get("/model-mappings", async (c) => {
    const mappings = getModelMappings()
    // 获取 Antigravity 支持的目标模型列表
    const targetModels = AVAILABLE_MODELS.map(m => ({ id: m.id, name: m.name }))
    return c.json({ 
        mappings, 
        presets: PRESET_SOURCE_MODELS,
        targetModels,
    })
})

// 保存模型映射配置
routingRouter.post("/model-mappings", async (c) => {
    const body = await c.req.json<{ mappings: ModelMapping[] }>()
    if (!Array.isArray(body.mappings)) {
        return c.json({ error: "Invalid mappings format" }, 400)
    }
    
    const config = saveModelMappings(body.mappings)
    console.log(`[Routing] Saved ${body.mappings.length} model mappings`)
    return c.json({ success: true, mappings: config.modelMappings })
})

// 添加单条模型映射
routingRouter.post("/model-mappings/add", async (c) => {
    const body = await c.req.json<{ source: string; target: string }>()
    if (!body.source || !body.target) {
        return c.json({ error: "Missing source or target" }, 400)
    }
    
    const mappings = getModelMappings()
    const newMapping: ModelMapping = {
        id: randomUUID(),
        source: body.source.trim().toLowerCase(),
        target: body.target.trim(),
        enabled: true,
    }
    mappings.push(newMapping)
    saveModelMappings(mappings)
    
    console.log(`[Routing] Added model mapping: ${newMapping.source} → ${newMapping.target}`)
    return c.json({ success: true, mapping: newMapping })
})

// 删除模型映射
routingRouter.delete("/model-mappings/:id", async (c) => {
    const id = c.req.param("id")
    const mappings = getModelMappings()
    const index = mappings.findIndex(m => m.id === id)
    
    if (index < 0) {
        return c.json({ error: "Mapping not found" }, 404)
    }
    
    const removed = mappings.splice(index, 1)[0]
    saveModelMappings(mappings)
    
    console.log(`[Routing] Deleted model mapping: ${removed.source} → ${removed.target}`)
    return c.json({ success: true })
})

// 切换模型映射启用状态
routingRouter.post("/model-mappings/:id/toggle", async (c) => {
    const id = c.req.param("id")
    const mappings = getModelMappings()
    const mapping = mappings.find(m => m.id === id)
    
    if (!mapping) {
        return c.json({ error: "Mapping not found" }, 404)
    }
    
    mapping.enabled = !mapping.enabled
    saveModelMappings(mappings)
    
    console.log(`[Routing] Model mapping ${mapping.source} → ${mapping.target} ${mapping.enabled ? "ENABLED" : "DISABLED"}`)
    return c.json({ success: true, enabled: mapping.enabled })
})
